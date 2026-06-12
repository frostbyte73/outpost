import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, statSync, createReadStream, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { Allowlist, type AllowlistConfig } from './allowlist.js';
import { ProjectRegistry } from './project-registry.js';
import { ApprovalQueue } from './approvals.js';
import { SessionStore } from './session-store.js';
import { SessionManager } from './session-manager.js';
import { Server } from './server.js';
import { HookServer } from './hook-server.js';
import { discoverTailscaleEnv } from './tailscale.js';
import { writeDaemonSettings, generateSecret } from './settings-gen.js';
import { handleHook } from './hook-handler.js';
import { type ApprovalMode, ApprovalModeStore } from './approval-mode.js';
import { RecurrenceTracker } from './recurrence-tracker.js';
import { WorktreeManager } from './worktree-manager.js';
import { loadOrCreateVapid } from './push-keys.js';
import { SubscriptionStore } from './push-subscriptions.js';
import { PushSender } from './push-sender.js';
import { StopHookTracker } from './stop-hook-tracker.js';
import { UsagePoller, type AccountUsageSnapshot } from './usage-poller.js';
import { loadConfig } from './config.js';
import { readProjectContextWindow } from './claude-config.js';
import allowlistDefault from '../config/allowlist.default.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };

const config = loadConfig();
const RUNTIME_DIR = config.runtimeDir;
mkdirSync(RUNTIME_DIR, { recursive: true });

// Single source of truth for the approval timeout. The PWA reads this via /api/info so
// the countdown UI matches the server's actual expiry deadline; updating one place keeps
// the client and server agreed.
const APPROVAL_TIMEOUT_MS = config.approvalTimeoutMs;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PWA_DIR = join(SRC_DIR, 'pwa');
// Path to the on-disk runtime allowlist. The tracked `allowlist.default.json` ships
// the defaults; first daemon start copies them here, after which every hot-add via
// /api/allowlist/rules atomic-writes back so rules survive a restart. The runtime
// file is gitignored so per-host rule additions don't show up as repo diffs.
const ALLOWLIST_PATH = config.allowlistPath ?? join(SRC_DIR, '..', 'config', 'allowlist.json');

function loadRuntimeAllowlist(path: string): AllowlistConfig {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as AllowlistConfig;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(allowlistDefault, null, 2) + '\n');
  renameSync(tmp, path);
  return allowlistDefault;
}

async function main() {
  const tsEnv = (config.certPath && config.keyPath && config.host)
    ? {
        certPath: config.certPath,
        keyPath: config.keyPath,
        hostname: config.host,
        ipv4: config.bindAddress ?? '127.0.0.1',
      }
    : discoverTailscaleEnv({ certDir: RUNTIME_DIR });

  const secret = generateSecret();
  const HOOK_PORT = config.hookPort;
  const settingsPath = join(RUNTIME_DIR, 'daemon-settings.json');
  writeDaemonSettings({ outPath: settingsPath, hookPort: HOOK_PORT });

  // Per-project allowlists live under <runtimeDir>/allowlists/<sanitized-cwd>.json.
  // Created lazily on first promotion; absent dir = no project rules.
  const projectAllowlistDir = join(RUNTIME_DIR, 'allowlists');
  const allowlist = new Allowlist(loadRuntimeAllowlist(ALLOWLIST_PATH), { projectAllowlistDir });
  const queue = new ApprovalQueue({ timeoutMs: APPROVAL_TIMEOUT_MS });
  const modes = new ApprovalModeStore();
  const recurrence = new RecurrenceTracker();

  // Phase 4: VAPID + push subscriptions. Files live under runtimeDir by default
  // (~/.outpost/vapid.json and ~/.outpost/push-subscriptions.json). VAPID generates
  // on first start and is never rotated — rotating would invalidate every device.
  const vapid = loadOrCreateVapid(config.vapidPath);
  const pushStore = new SubscriptionStore(config.pushSubscriptionsPath);
  // Test-only: when OUTPOST_PUSH_CA_PATH is set, construct an HTTPS agent that trusts
  // ONLY that CA. Lets e2e tests stand up a fake push service with a self-signed cert
  // without disabling certificate verification globally. Unset in production → web-push
  // uses Node's default trust store.
  let pushAgent: import('node:https').Agent | undefined;
  const pushCaPath = process.env.OUTPOST_PUSH_CA_PATH;
  if (pushCaPath) {
    const { Agent } = await import('node:https');
    const { readFileSync } = await import('node:fs');
    pushAgent = new Agent({ ca: readFileSync(pushCaPath) });
    console.log(`[push] using pinned CA from ${pushCaPath}`);
  }
  const pushSender = new PushSender({
    store: pushStore,
    vapid,
    ttlSeconds: config.pushTtlSeconds,
    ...(pushAgent ? { agent: pushAgent } : {}),
  });
  console.log(`[daemon] push subscriptions: ${pushStore.list().length} loaded from ${config.pushSubscriptionsPath}`);

  // Outpost discovers projects under the standard claude code projects root. No per-daemon
  // cwd anymore — each session carries its own (recorded by claude in the JSONL).
  const projectsRoot = config.projectsRoot;
  const projectRegistry = new ProjectRegistry(join(RUNTIME_DIR, 'projects.json'));
  const worktreeManager = new WorktreeManager({ root: join(RUNTIME_DIR, 'worktrees'), projectsRoot });
  const sessionStore = new SessionStore({ root: projectsRoot, registry: projectRegistry, worktreeManager });
  console.log(`[daemon] projects root: ${projectsRoot}`);

  function findSessionTitle(id: string): string | undefined {
    for (const p of sessionStore.listProjects()) {
      const s = p.sessions.find((x) => x.id === id);
      if (s) return s.title;
    }
    return undefined;
  }

  // Phase 3: optional event-log overrides for tests. Production defaults (5000 / 10 min)
  // are set inside SessionManager when these are omitted.
  const eventLogMaxEvents = process.env.OUTPOST_EVENT_LOG_MAX_EVENTS
    ? Number(process.env.OUTPOST_EVENT_LOG_MAX_EVENTS)
    : undefined;
  const eventLogMaxAgeMs = process.env.OUTPOST_EVENT_LOG_MAX_AGE_MS
    ? Number(process.env.OUTPOST_EVENT_LOG_MAX_AGE_MS)
    : undefined;

  // Phase 4: tracks per-session turn-start timestamps so the Stop hook handler can
  // decide whether to fire a push notification (turn duration >= threshold).
  const stopTracker = new StopHookTracker({ thresholdMs: config.stopHookThresholdMs });

  const manager = new SessionManager({
    settingsPath,
    daemonAuthSecret: secret,
    daemonHost: config.host ?? tsEnv.hostname,
    sessionStore,
    eventLogMaxEvents,
    eventLogMaxAgeMs,
    worktreeManager,
    onTurnStart: (sessionId) => stopTracker.recordTurnStart(sessionId),
  });

  const server = new Server({
    certPath: tsEnv.certPath,
    keyPath: tsEnv.keyPath,
    bindAddress: config.bindAddress ?? tsEnv.ipv4,
    port: config.httpsPort,
  });

  function cwdForSession(sessionId: string): string | undefined {
    // For worktree sessions, return the PARENT project's cwd so project-scoped allowlist
    // rules (applied at the user-visible project level) still match. Only fall through
    // to SessionStore/manager when there's no worktree record for this id.
    const wtRec = worktreeManager.get(sessionId);
    if (wtRec && !wtRec.archivedAt) return wtRec.projectCwd;
    // Otherwise: on-disk cwd if known, else the in-memory spawn cwd. The latter handles
    // the brand-new-session case where the first JSONL line hasn't been flushed yet.
    return sessionStore.findSession(sessionId)?.cwd ?? manager.getCwd(sessionId);
  }

  // Most recent daemon_statusline payload per session. The event log inside SessionManager
  // already replays statusline events to clients that reconnect during a session's active
  // lifetime, but the log dies with the claude subprocess — so on the first reattach after
  // an idle exit / daemon restart, the meter would be blank until claude's next statusLine
  // fire. We cache the last payload here and replay it on session-WS attach. Memory-only;
  // a daemon restart loses the cache (acceptable: one statusLine-fire of latency).
  const latestStatuslineBySession = new Map<string, object>();

  // PreToolUse + Stop + StatusLine hook endpoints (loopback-only — see hook-server.ts for why)
  const hookServer = new HookServer({
    port: HOOK_PORT,
    daemonAuthSecret: secret,
    onStatusLineHook: async (body) => {
      // claude pipes its statusLine JSON to a shell command we install in settings.json;
      // that command POSTs the payload here, then we fan it out to every attached WS
      // client for the session. Goes through manager.broadcast so the daemon's per-session
      // event log replays the latest snapshot to a reconnecting client.
      //
      // Schema: see https://code.claude.com/docs/en/statusline#available-data.
      let payload: {
        session_id?: string;
        model?: { id?: string; display_name?: string };
        context_window?: {
          context_window_size?: number;
          used_percentage?: number | null;
          remaining_percentage?: number | null;
          total_input_tokens?: number;
          total_output_tokens?: number;
          current_usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          } | null;
        };
        cost?: {
          total_cost_usd?: number;
          total_duration_ms?: number;
          total_api_duration_ms?: number;
          total_lines_added?: number;
          total_lines_removed?: number;
        };
        rate_limits?: {
          five_hour?: { used_percentage?: number; resets_at?: number };
          seven_day?: { used_percentage?: number; resets_at?: number };
        };
        effort?: { level?: string };
        exceeds_200k_tokens?: boolean;
      };
      try { payload = JSON.parse(body); } catch {
        console.error('[hook] statusline: invalid JSON body');
        return;
      }
      const sessionId = payload.session_id;
      if (!sessionId) return;
      const msg = {
        type: 'daemon_statusline',
        sessionId,
        model: payload.model,
        contextWindow: payload.context_window,
        cost: payload.cost,
        rateLimits: payload.rate_limits,
        effort: payload.effort,
        exceeds200k: payload.exceeds_200k_tokens,
      };
      latestStatuslineBySession.set(sessionId, msg);
      manager.broadcast(sessionId, msg);
    },
    onStopHook: async (body) => {
      let payload: { session_id?: string };
      try { payload = JSON.parse(body); } catch {
        console.error('[hook] stop: invalid JSON body');
        return;
      }
      const sessionId = payload.session_id;
      if (!sessionId) return;
      const { shouldNotify, turnDurationMs } = stopTracker.consume(sessionId);
      console.log(`[hook] stop session=${sessionId.slice(0,8)} durationMs=${turnDurationMs ?? 'n/a'} push=${shouldNotify}`);
      if (!shouldNotify) return;
      const title = findSessionTitle(sessionId);
      void pushSender.send({
        title: title ? `Claude finished: ${title}` : 'Claude finished',
        body: turnDurationMs
          ? `Turn took ${(turnDurationMs / 1000).toFixed(0)}s. Tap to continue.`
          : 'Tap to continue.',
        tag: `stop-${sessionId}`,
        data: { kind: 'stop', sessionId },
      });
    },
    onPreToolHook: async (body) => {
      const hookInput = JSON.parse(body);
      console.log(`[hook] ${hookInput.tool_name} session=${hookInput.session_id?.slice(0,8)}${hookInput.agent_id ? ` agent=${hookInput.agent_type ?? '?'}/${hookInput.agent_id.slice(0,8)}` : ''} input=${JSON.stringify(hookInput.tool_input).slice(0, 200)}`);
      // Tool calls the allowlist auto-allows never reach the approval queue and
      // therefore never emit an approval_pending event. Without a special path:
      //   - subagent calls would run invisibly (the agent bucket wouldn't get any
      //     entry, so a read-only subagent's whole feed would be empty);
      //   - parent calls would appear in the transcript with no signal to the PWA
      //     that they were auto-allowed (which the expand-by-default logic depends on).
      // Mirror the call out via dedicated message types — `agent_activity` for subagent
      // buckets, `tool_auto_allowed` as a hint to the parent transcript.
      if (allowlist.allows(hookInput.tool_name, hookInput.tool_input)) {
        if (hookInput.agent_id) {
          notifyAll({
            type: 'agent_activity',
            sessionId: hookInput.session_id,
            toolName: hookInput.tool_name,
            toolInput: hookInput.tool_input,
            agentId: hookInput.agent_id,
            agentType: hookInput.agent_type,
            toolUseId: hookInput.tool_use_id,
          });
        } else {
          notifyAll({
            type: 'tool_auto_allowed',
            sessionId: hookInput.session_id,
            toolName: hookInput.tool_name,
            // Forward toolInput so the client can content-match against the streamed
            // tool_use block. Claude Code's PreToolUse hook doesn't include tool_use_id,
            // so JSON-equality of the input is the only stable correlation we have.
            toolInput: hookInput.tool_input,
          });
        }
      }
      const result = await handleHook({
        hookInput,
        allowlist,
        queue,
        modes,
        cwdForSession,
        onNotify: (approval) => {
          console.log(`[hook] enqueued approval ${approval.id.slice(0,8)} for ${approval.toolName}`);
          const summary = summarizeToolInput(approval.toolName, approval.toolInput);
          // Look up the session title so cross-session toasts can show "Approval on <title>"
          // rather than a meaningless id stub. Title may be undefined for very new sessions
          // whose JSONL hasn't been written yet — the client falls back to the id prefix.
          const sessionTitle = findSessionTitle(approval.sessionId);
          const cwd = cwdForSession(approval.sessionId);
          const suggestion = cwd ? recurrence.suggestionFor(cwd, approval.toolName, approval.toolInput) : null;
          // Goes to every attached notification WS, regardless of which session view is
          // active (if any). The client decides whether to render an inline card (own
          // session in view) or a toast (any other view).
          notifyAll({
            type: 'approval_pending',
            approvalId: approval.id,
            sessionId: approval.sessionId,
            toolName: approval.toolName,
            // Forward the raw tool_input too — most clients ignore it (they render `summary`)
            // but the AskUserQuestion popup needs the full questions/options structure to
            // build its picker. Cheap to include and keeps the API generic.
            toolInput: approval.toolInput,
            toolUseId: approval.toolUseId,
            // Subagent provenance: when these are set, the PWA routes this approval into
            // the dedicated agents feed instead of the parent session's inline cards.
            agentId: approval.agentId,
            agentType: approval.agentType,
            summary,
            sessionTitle,
            suggestion,
          });
          // Phase 4: fan out a Web Push so devices ring even when the PWA is backgrounded
          // or the screen is locked. Service worker decides client-side whether to render
          // the OS banner (no visible window) or post into an already-open window. tag
          // collapses repeated pushes for the same approval.
          void pushSender.send({
            title: sessionTitle ? `Approval: ${approval.toolName} (${sessionTitle})` : `Approval: ${approval.toolName}`,
            body: summary,
            tag: `approval-${approval.id}`,
            data: { kind: 'approval', sessionId: approval.sessionId, approvalId: approval.id },
          });
        },
      });
      console.log(`[hook] decision: ${result.hookSpecificOutput.permissionDecision} for ${hookInput.tool_name}`);
      return JSON.stringify(result);
    },
  });

  // Discover slash commands once at startup. The set is effectively static for a daemon
  // lifetime — installing a new plugin or skill requires a daemon restart to surface in
  // the palette, same as it requires a `claude` restart to be picked up.
  const slashCommands = discoverSlashCommands();
  console.log(`[daemon] discovered ${slashCommands.length} slash commands`);

  server.route('GET', '/api/info', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      version: pkg.version,
      allowlistRuleCount: allowlist.ruleCount(),
      approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
      // Used by the PWA to expand `~/foo` into an absolute path in the cwd picker
      // without baking a username into the client.
      home: homedir(),
      slashCommands,
      // Phase 4: PWA passes this as applicationServerKey to pushManager.subscribe().
      // Stable for the daemon's lifetime (never rotated).
      vapidPublicKey: vapid.publicKey,
    }));
  });

  server.route('GET', '/api/sessions', (_req, res) => {
    const projects = sessionStore.listProjects();
    // Decorate each project with its preferred context-window size (1M iff the user has
    // ever run the [1m] Opus variant there, per ~/.claude.json). PWA uses this to pick
    // 1M over the 200k default in the meter when no statusLine payload exists.
    for (const p of projects) {
      const cw = readProjectContextWindow(p.cwd);
      if (cw) p.contextWindowSize = cw;
    }
    // Title index across every project's sessions so the pending payload can show
    // "Approval on <title>" toasts cross-project the same as it does today.
    const titleById = new Map<string, string>();
    for (const p of projects) for (const s of p.sessions) titleById.set(s.id, s.title);
    const pending = queue.listPending().map((a) => {
      const cwd = cwdForSession(a.sessionId);
      const suggestion = cwd ? recurrence.suggestionFor(cwd, a.toolName, a.toolInput) : null;
      return {
        approvalId: a.id,
        sessionId: a.sessionId,
        toolName: a.toolName,
        toolInput: a.toolInput,
        toolUseId: a.toolUseId,
        agentId: a.agentId,
        agentType: a.agentType,
        summary: summarizeToolInput(a.toolName, a.toolInput),
        sessionTitle: titleById.get(a.sessionId),
        enqueuedAt: a.enqueuedAt,
        suggestion,
      };
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ projects, pending }));
  });

  // Return the parsed transcript for a session — used by the PWA to repopulate the view
  // when reopening an existing session (whether after app-kill, switching to another session,
  // or just opening an old one for the first time).
  server.route('GET', '/api/sessions/:id/messages', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/messages$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const messages = sessionStore.readMessages(m[1]!);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messages }));
  });

  // Per-session subagent history. Each entry includes the agent's metadata + the
  // flattened tool_use stream from its sidecar JSONL + (if it finished) the parsed
  // <task-notification> completion. Used by the PWA to repopulate the agents sheet
  // when reopening a session — without this endpoint, only currently-pending agents
  // would survive the reopen.
  server.route('GET', '/api/sessions/:id/subagents', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/subagents$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const subagents = sessionStore.readSubagents(m[1]!);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ subagents }));
  });

  // Hot-add an allowlist rule. Body shape: { kind: 'tool' | 'bash' | 'mcp', value: string, scope?: 'global' | { project: string } }.
  // Server validates the value (regex compilation for pattern kinds), dedupes against
  // existing rules, and on success atomic-writes the updated allowlist.json (global) or
  // the per-project file (project scope) so the rule survives a daemon restart. Returns
  // the new rule count for the PWA to refresh.
  server.route('POST', '/api/allowlist/rules', async (req, res) => {
    const body = await readBody(req);
    let payload: { kind?: string; value?: string; scope?: 'global' | { project?: string } };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    const { kind, value, scope } = payload;
    if (kind !== 'tool' && kind !== 'bash' && kind !== 'mcp') {
      res.statusCode = 400; res.end('kind must be tool|bash|mcp'); return;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
      res.statusCode = 400; res.end('value must be a 1..500 char string'); return;
    }
    let normalizedScope: 'global' | { project: string };
    if (scope === undefined || scope === 'global') {
      normalizedScope = 'global';
    } else if (typeof scope === 'object' && scope !== null && typeof scope.project === 'string' && scope.project.startsWith('/')) {
      normalizedScope = { project: scope.project };
    } else {
      res.statusCode = 400; res.end('scope must be "global" or {project: <absolute-cwd>}'); return;
    }
    let added: boolean;
    try {
      added = allowlist.addRule(kind, value, normalizedScope);
    } catch (e) {
      res.statusCode = 400; res.end(`invalid pattern: ${(e as Error).message}`); return;
    }
    if (added && normalizedScope === 'global') {
      // Atomic write of the global allowlist file (existing behavior).
      const tmp = `${ALLOWLIST_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(allowlist.toConfig('global'), null, 2) + '\n');
      renameSync(tmp, ALLOWLIST_PATH);
      console.log(`[api] allowlist[global]: added ${kind} rule ${JSON.stringify(value)} (total ${allowlist.ruleCount()})`);
    } else if (added) {
      // Project file is persisted inside Allowlist.addRule via projectAllowlistDir.
      console.log(`[api] allowlist[project=${(normalizedScope as { project: string }).project}]: added ${kind} rule ${JSON.stringify(value)}`);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ added, ruleCount: allowlist.ruleCount() }));
  });

  // Delete a session — kills the subprocess, removes the .jsonl from disk, and (if the
  // session ran in a worktree) removes the worktree + branch via WorktreeManager.remove().
  server.route('DELETE', '/api/sessions/:id', async (req, res) => {
    const id = (req.url ?? '').split('/').pop()!;
    await manager.close(id);
    const removed = sessionStore.delete(id);
    await worktreeManager.remove(id);
    latestStatuslineBySession.delete(id);
    console.log(`[api] delete session ${id.slice(0,8)} subprocess=killed file=${removed ? 'removed' : 'not-found'}`);
    res.statusCode = 204;
    res.end();
  });

  // Archive a session — keeps the .jsonl but tears down the worktree + branch. The
  // session row stays visible in the list (marked archived) so the transcript is still
  // reachable. Reopening an archived session falls through to shared-cwd mode.
  server.route('POST', '/api/sessions/:id/archive', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/archive$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    await manager.close(id);
    await worktreeManager.archive(id);
    latestStatuslineBySession.delete(id);
    console.log(`[api] archive session ${id.slice(0,8)} (worktree removed, JSONL kept)`);
    res.statusCode = 204;
    res.end();
  });

  // Per-project git branch listing for the branch picker. Cached 30s per cwd; returns
  // local + remote branches deduped + sorted by committer-date, plus the repo's default
  // branch (origin/HEAD if present, else first match of main/master).
  const branchesCache = new Map<string, { branches: string[]; defaultBranch: string | null; at: number }>();
  const BRANCHES_CACHE_MS = 30_000;
  server.route('GET', '/api/projects/:sanitized/branches', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/projects\/([\w.\-]+)\/branches$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sanitized = m[1]!;
    const project = sessionStore.listProjects().find((p) => p.cwd.replace(/\//g, '-') === sanitized);
    if (!project) { res.statusCode = 404; res.end('project not found'); return; }
    const cached = branchesCache.get(project.cwd);
    if (cached && Date.now() - cached.at < BRANCHES_CACHE_MS) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ branches: cached.branches, defaultBranch: cached.defaultBranch }));
      return;
    }
    const { execFileSync } = await import('node:child_process');
    const branches: string[] = [];
    let defaultBranch: string | null = null;
    try {
      const local = execFileSync('git', ['-C', project.cwd, 'branch', '--format=%(refname:short)', '--sort=-committerdate'])
        .toString().split('\n').filter(Boolean);
      let remote: string[] = [];
      try {
        remote = execFileSync('git', ['-C', project.cwd, 'branch', '-r', '--format=%(refname:short)', '--sort=-committerdate'])
          .toString().split('\n').filter(Boolean)
          .filter((b) => b !== 'origin/HEAD' && !b.includes('->'))
          .map((b) => b.replace(/^origin\//, ''));
      } catch { /* no remote — fine */ }
      const seen = new Set<string>();
      for (const b of [...local, ...remote]) {
        if (!seen.has(b)) { seen.add(b); branches.push(b); }
      }
      try {
        const head = execFileSync('git', ['-C', project.cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString().trim();
        defaultBranch = head.replace(/^refs\/remotes\/origin\//, '') || null;
      } catch {
        defaultBranch = branches.find((b) => b === 'main' || b === 'master') ?? branches[0] ?? null;
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(`git error: ${(e as Error).message}`);
      return;
    }
    branchesCache.set(project.cwd, { branches, defaultBranch, at: Date.now() });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ branches, defaultBranch }));
  });

  // Register a user-supplied project cwd in the ProjectRegistry. Used by the PWA's
  // "+ Add project" button to expose a fresh directory before claude has touched it.
  // Body: { cwd: <absolute path> }. Returns { added: boolean, cwd: string }.
  server.route('POST', '/api/projects', async (req, res) => {
    const body = await readBody(req);
    let payload: { cwd?: string };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    const { cwd } = payload;
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
      res.statusCode = 400; res.end('cwd must be absolute'); return;
    }
    try {
      if (!statSync(cwd).isDirectory()) {
        res.statusCode = 400; res.end('cwd is not a directory'); return;
      }
    } catch {
      res.statusCode = 400; res.end('cwd does not exist'); return;
    }
    const added = projectRegistry.add(cwd);
    if (added) console.log(`[api] project registered: ${cwd}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ added, cwd }));
  });

  // Remove a user-added project from the registry. Doesn't touch any session JSONLs —
  // claude-discovered projects (source='claude' or 'both') stay in the list after this
  // because they still have session history on disk.
  server.route('DELETE', '/api/projects', async (req, res) => {
    const body = await readBody(req);
    let payload: { cwd?: string };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    if (typeof payload.cwd !== 'string') {
      res.statusCode = 400; res.end('cwd required'); return;
    }
    const removed = projectRegistry.remove(payload.cwd);
    if (removed) console.log(`[api] project unregistered: ${payload.cwd}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ removed }));
  });

  // Phase 4: Register a device for Web Push notifications. Body shape:
  //   { subscription: { endpoint: string, keys: { p256dh: string, auth: string } }, userAgent?: string }
  // Endpoint is unique per (browser, device, origin) so re-POSTing the same endpoint is
  // idempotent (the store overwrites). Returns the current subscription count.
  server.route('POST', '/api/push/subscribe', async (req, res) => {
    const body = await readBody(req);
    let payload: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; userAgent?: string };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    const sub = payload.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys
        || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
      res.statusCode = 400; res.end('subscription.endpoint + subscription.keys.{p256dh,auth} required'); return;
    }
    if (!/^https?:\/\//.test(sub.endpoint)) {
      res.statusCode = 400; res.end('subscription.endpoint must be http(s) URL'); return;
    }
    const now = Date.now();
    pushStore.add({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      userAgent: typeof payload.userAgent === 'string' ? payload.userAgent.slice(0, 500) : undefined,
      createdAt: now,
      lastSeenAt: now,
    });
    console.log(`[push] subscribe ${sub.endpoint.slice(0, 60)}… (total ${pushStore.list().length})`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: pushStore.list().length }));
  });

  // Unregister a device. Body: { endpoint: string }. 200 either way (no leaking presence).
  server.route('DELETE', '/api/push/subscribe', async (req, res) => {
    const body = await readBody(req);
    let payload: { endpoint?: string };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    if (typeof payload.endpoint !== 'string') {
      res.statusCode = 400; res.end('endpoint required'); return;
    }
    pushStore.remove(payload.endpoint);
    console.log(`[push] unsubscribe ${payload.endpoint.slice(0, 60)}… (total ${pushStore.list().length})`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: pushStore.list().length }));
  });

  // Manual fire — used by the Settings "Send test push" button to confirm wiring
  // without waiting for a real approval. Same payload shape as production pushes.
  server.route('POST', '/api/push/test', async (_req, res) => {
    await pushSender.send({
      title: 'Outpost test push',
      body: 'If you can see this, push is wired correctly.',
      tag: 'outpost-test',
      data: { kind: 'test' },
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count: pushStore.list().length }));
  });

  // Global notification channel — every running client holds one of these open for the
  // entire app lifetime regardless of which view is showing. All approval events flow
  // through here so the session list can update live and cross-session toasts can fire
  // even when no session WS is attached.
  const notificationClients = new Set<import('ws').WebSocket>();
  function notifyAll(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of notificationClients) ws.send(payload);
  }

  // Account-wide rate-limit usage (5h / 7d) lives in claude.ai's OAuth endpoint, not the
  // statusLine JSON — claude.ai surfaces it on the settings page, claude CLI doesn't relay
  // it in headless mode. UsagePoller hits that endpoint with the OAuth token from the
  // keychain on a usage-adaptive cadence (5min idle → 30s near 90%) and broadcasts to the
  // notifications WS. Latest snapshot is cached so reconnecting clients see it instantly.
  let latestAccountUsage: AccountUsageSnapshot | null = null;
  const usagePoller = new UsagePoller({
    onSnapshot: (snap) => {
      latestAccountUsage = snap;
      notifyAll({ type: 'daemon_account_usage', rateLimits: snap });
    },
  });
  usagePoller.start();

  // Push every approval resolution out to clients so the PWA can render a "Timed out"
  // tile rather than the card silently disappearing — and so a second device viewing
  // the same session sees the same decision the first device made.
  queue.onResolve = (approval, decision) => {
    // Record before broadcasting so the next approval's onNotify sees the new count.
    recurrence.record({
      cwd: cwdForSession(approval.sessionId) ?? approval.sessionId,
      toolName: approval.toolName,
      toolInput: approval.toolInput,
      decision: decision.allow ? 'allow' : 'deny',
    });
    notifyAll({
      type: 'approval_resolved',
      approvalId: approval.id,
      sessionId: approval.sessionId,
      toolName: approval.toolName,
      agentId: approval.agentId,
      agentType: approval.agentType,
      decision: decision.allow ? 'allow' : 'deny',
      reason: decision.reason,
      timedOut: !decision.allow && (decision.reason ?? '').startsWith('Approval timed out'),
    });
  };

  server.onWebSocket((ws, req) => {
    const url = req.url ?? '';

    if (url === '/ws/notifications') {
      notificationClients.add(ws);
      // Snapshot the current pending queue so a freshly-attached client (cold start, or
      // a reconnect after iOS backgrounded the PWA) sees what was already enqueued. This
      // is a single event with the full set — distinct from approval_pending so the client
      // can populate state without firing toasts for stale items.
      const titleById = new Map<string, string>();
      for (const p of sessionStore.listProjects()) for (const s of p.sessions) titleById.set(s.id, s.title);
      if (latestAccountUsage) {
        ws.send(JSON.stringify({ type: 'daemon_account_usage', rateLimits: latestAccountUsage }));
      }
      ws.send(JSON.stringify({
        type: 'notifications_snapshot',
        approvals: queue.listPending().map((a) => {
          const cwd = cwdForSession(a.sessionId);
          const suggestion = cwd ? recurrence.suggestionFor(cwd, a.toolName, a.toolInput) : null;
          return {
            approvalId: a.id,
            sessionId: a.sessionId,
            toolName: a.toolName,
            toolInput: a.toolInput,
            toolUseId: a.toolUseId,
            agentId: a.agentId,
            agentType: a.agentType,
            summary: summarizeToolInput(a.toolName, a.toolInput),
            sessionTitle: titleById.get(a.sessionId),
            suggestion,
          };
        }),
      }));
      // Accept approval_decide on the notifications WS too. The notifications channel is
      // the one engineered to survive iOS backgrounding (the session WS often drops), and
      // it's the channel that delivered the approval_pending in the first place. Without
      // this, accept-edits auto-allows sent while the session WS happens to be closed are
      // silently dropped and the hook eventually times out (10-minute stall + denied edit).
      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let msg: { type?: string };
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'approval_decide') {
          const m2 = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
          queue.decide(m2.approvalId, { allow: m2.decision === 'allow', reason: m2.reason });
        }
      });
      ws.on('close', () => notificationClients.delete(ws));
      return;
    }

    const m = url.match(/^\/ws\/sessions\/([\w-]+)(?:\?.*)?$/);
    if (!m) {
      ws.close();
      return;
    }
    const sessionId = m[1]!;
    // Optional ?cwd=<absolute-path> on the WS URL. Honored only on the first attach for a
    // brand-new session id; SessionManager.attach validates it and emits a daemon_error + closes
    // the WS on failure.
    // Phase 2b: also accept &spawn=worktree|shared and &base=<branch> for worktree-mode spawns.
    // Phase 3: also accept &since=<seq> for replay-on-reconnect. SessionManager decides
    // whether the value is replayable from the in-memory log or triggers a replay_gap.
    let cwd: string | undefined;
    let spawnMode: 'shared' | 'worktree' | undefined;
    let baseBranch: string | undefined;
    let since: number | undefined;
    const queryIdx = url.indexOf('?');
    if (queryIdx >= 0) {
      const params = new URLSearchParams(url.slice(queryIdx + 1));
      const rawCwd = params.get('cwd');
      if (rawCwd) cwd = rawCwd;
      const rawSpawn = params.get('spawn');
      if (rawSpawn === 'worktree' || rawSpawn === 'shared') spawnMode = rawSpawn;
      const rawBase = params.get('base');
      if (rawBase) baseBranch = rawBase;
      const rawSince = params.get('since');
      if (rawSince !== null) {
        const n = Number(rawSince);
        // Ignore garbage (NaN, negatives). undefined → SessionManager defaults to 0 →
        // "send me everything you've got from the earliest still in the log".
        if (Number.isFinite(n) && n >= 0) since = Math.floor(n);
      }
    }
    manager.attach(sessionId, ws, { cwd, spawnMode, baseBranch, since });
    // Broadcast the current mode to this WS so the PWA can render the segmented control
    // in sync with server state. Cheap; one message per WS connect.
    ws.send(JSON.stringify({ type: 'approval_mode', sessionId, mode: modes.get(sessionId) }));
    // Replay the last-known statusline (CTX/cost/model) so the meter renders immediately
    // on re-attach instead of waiting for claude's next statusLine fire. If the session
    // was active continuously and the event log already had it, the client just receives
    // a duplicate — the PWA handler is idempotent.
    const cachedSl = latestStatuslineBySession.get(sessionId);
    if (cachedSl) ws.send(JSON.stringify(cachedSl));
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'user_message') {
        const m2 = msg as { content: string };
        manager.send(sessionId, {
          type: 'user',
          message: { role: 'user', content: m2.content },
        });
      } else if (msg.type === 'approval_decide') {
        const m2 = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
        queue.decide(m2.approvalId, { allow: m2.decision === 'allow', reason: m2.reason });
      } else if (msg.type === 'interrupt') {
        // User tapped Stop in the PWA. Kill the claude subprocess; the existing
        // daemon_proc_exit path handles the UI follow-up.
        console.log(`[api] interrupt requested for session ${sessionId.slice(0, 8)}`);
        manager.interrupt(sessionId);
      } else if (msg.type === 'approval_mode_set') {
        const { mode } = msg as { mode?: string };
        if (typeof mode === 'string') {
          try {
            // ApprovalModeStore.set() throws on invalid mode — it owns the valid-mode list.
            modes.set(sessionId, mode as ApprovalMode);
            // Broadcast new mode to every attached client on this session so multi-device stays in sync.
            manager.broadcast(sessionId, { type: 'approval_mode', sessionId, mode });
            console.log(`[api] approval mode for ${sessionId.slice(0, 8)} → ${mode}`);
          } catch {
            // Invalid mode string — silently ignore.
          }
        }
      }
    });
  });

  // Static files for the PWA
  const STATIC_FILES: Record<string, { contentType: string; file: string }> = {
    '/': { contentType: 'text/html', file: 'index.html' },
    '/index.html': { contentType: 'text/html', file: 'index.html' },
    '/app.js': { contentType: 'text/javascript', file: 'app.js' },
    '/session-filter.js': { contentType: 'text/javascript', file: 'session-filter.js' },
    '/sw.js': { contentType: 'text/javascript', file: 'sw.js' },
    '/manifest.json': { contentType: 'application/manifest+json', file: 'manifest.json' },
    '/icon-512.png': { contentType: 'image/png', file: 'icon-512.png' },
  };
  for (const [path, meta] of Object.entries(STATIC_FILES)) {
    server.route('GET', path, (_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', meta.contentType);
      // The PWA's HTML/JS/CSS are tightly coupled and change together when we redeploy.
      // No versioned filenames means browsers (especially iOS Safari standalone PWAs)
      // happily serve a stale app.js even after a daemon restart. Telling the cache to
      // always revalidate keeps reloads honest without ditching ETag/304 entirely.
      res.setHeader('cache-control', 'no-cache, must-revalidate');
      createReadStream(join(PWA_DIR, meta.file)).pipe(res);
    });
  }

  await server.listen();
  await hookServer.listen();
  console.log(`[daemon] listening on https://${config.host ?? tsEnv.hostname}:${config.httpsPort} (${config.bindAddress ?? tsEnv.ipv4})`);
  console.log(`[daemon] hook server on http://127.0.0.1:${HOOK_PORT} (loopback only)`);
}

function summarizeToolInput(toolName: string, toolInput: unknown): string {
  try {
    if (toolName === 'Bash') return (toolInput as { command?: string }).command?.slice(0, 200) ?? toolName;
    return `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`;
  } catch {
    return toolName;
  }
}

type SlashCommand = { name: string; source: string; description?: string };

// Scanned once at daemon startup and surfaced via /api/info. The PWA's slash-command
// palette uses this to populate its picker — saves the user typing long names on a
// phone keyboard. Scan order is hardcoded → user → plugin → skill; first occurrence
// of a given /name wins so a user override beats the plugin shipping the same name.
function discoverSlashCommands(): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  const push = (c: SlashCommand) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    out.push(c);
  };
  // Built-ins: `claude --help` doesn't enumerate slash commands in a parse-friendly form,
  // so we maintain a known list. Update when the CLI ships new ones.
  for (const b of ['clear', 'compact', 'context', 'usage', 'help', 'exit', 'mcp', 'config', 'login', 'logout', 'model']) {
    push({ name: `/${b}`, source: 'builtin' });
  }
  const claudeDir = join(homedir(), '.claude');
  // 1. User commands.
  scanCommandDir(join(claudeDir, 'commands'), 'user', push);
  // 2. Plugin commands. Layout is ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/*.md
  // — walk to depth 4 looking for any `commands` subdirectory and scan it.
  scanPluginCommands(join(claudeDir, 'plugins', 'cache'), push);
  // 3. User skills at ~/.claude/skills/<name>/SKILL.md.
  scanSkillDir(join(claudeDir, 'skills'), 'skill', push);
  return out;
}

function scanCommandDir(dir: string, source: string, push: (c: SlashCommand) => void) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    const description = readFrontmatterDescription(join(dir, f));
    push({ name: `/${name}`, source, ...(description ? { description } : {}) });
  }
}

function scanPluginCommands(root: string, push: (c: SlashCommand) => void) {
  // BFS up to 5 levels deep; any directory named "commands" gets scanned, with the source
  // tagged as `plugin:<owner-dir>`. The exact nesting depends on the marketplace, so we
  // walk rather than glob-match a fixed shape.
  const stack: { dir: string; depth: number; owner: string | null }[] = [{ dir: root, depth: 0, owner: null }];
  while (stack.length) {
    const { dir, depth, owner } = stack.pop()!;
    if (depth > 5) continue;
    let entries: { name: string; isDirectory(): boolean }[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'commands') {
        scanCommandDir(join(dir, e.name), `plugin${owner ? `:${owner}` : ''}`, push);
        continue;
      }
      // Use the first directory below cache/<marketplace> as the plugin label.
      const nextOwner = owner ?? (depth === 1 ? e.name : null);
      stack.push({ dir: join(dir, e.name), depth: depth + 1, owner: nextOwner });
    }
  }
}

function scanSkillDir(root: string, source: string, push: (c: SlashCommand) => void) {
  let entries: { name: string; isDirectory(): boolean }[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = join(root, e.name, 'SKILL.md');
    try { statSync(skillFile); } catch { continue; }
    const description = readFrontmatterDescription(skillFile);
    push({ name: `/${e.name}`, source, ...(description ? { description } : {}) });
  }
}

// Read just the `description:` line from the YAML frontmatter at the top of a .md file.
// Description text can span multiple lines in YAML, but in practice Anthropic's command
// and skill files keep it to a single line — we mirror that and only support the simple
// form. Returns undefined if the file has no frontmatter or no description key.
function readFrontmatterDescription(path: string): string | undefined {
  let content: string;
  try { content = readFileSync(path, 'utf-8'); } catch { return undefined; }
  // Read at most the first 4KB — frontmatter never gets close to that, and skill bodies
  // can be huge.
  const head = content.slice(0, 4096);
  const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm || !fm[1]) return undefined;
  const m = fm[1].match(/^description:\s*(.+?)\s*$/m);
  return m && m[1] ? m[1] : undefined;
}

function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
