import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, createReadStream, writeFileSync, renameSync } from 'node:fs';
import { Allowlist } from './allowlist.js';
import { ApprovalQueue } from './approvals.js';
import { SessionStore } from './session-store.js';
import { SessionManager } from './session-manager.js';
import { Server } from './server.js';
import { HookServer } from './hook-server.js';
import { discoverTailscaleEnv } from './tailscale.js';
import { writeDaemonSettings, generateSecret } from './settings-gen.js';
import { handleHook } from './hook-handler.js';
import { loadConfig } from './config.js';
import allowlistConfig from '../config/allowlist.json' with { type: 'json' };
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
// Path to the on-disk allowlist config. After a hot-add via /api/allowlist/rules we
// atomic-write the updated JSON here so the rule survives a daemon restart.
const ALLOWLIST_PATH = config.allowlistPath ?? join(SRC_DIR, '..', 'config', 'allowlist.json');

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

  const allowlist = new Allowlist(allowlistConfig);
  const queue = new ApprovalQueue({ timeoutMs: APPROVAL_TIMEOUT_MS });

  // Outpost discovers projects under the standard claude code projects root. No per-daemon
  // cwd anymore — each session carries its own (recorded by claude in the JSONL).
  const projectsRoot = config.projectsRoot;
  const sessionStore = new SessionStore({ root: projectsRoot });
  console.log(`[daemon] projects root: ${projectsRoot}`);

  function findSessionTitle(id: string): string | undefined {
    for (const p of sessionStore.listProjects()) {
      const s = p.sessions.find((x) => x.id === id);
      if (s) return s.title;
    }
    return undefined;
  }

  const manager = new SessionManager({
    settingsPath,
    daemonAuthSecret: secret,
    daemonHost: config.host ?? tsEnv.hostname,
    sessionStore,
  });

  const server = new Server({
    certPath: tsEnv.certPath,
    keyPath: tsEnv.keyPath,
    bindAddress: config.bindAddress ?? tsEnv.ipv4,
    port: config.httpsPort,
  });

  // PreToolUse hook endpoint (loopback-only — see hook-server.ts for why)
  const hookServer = new HookServer({
    port: HOOK_PORT,
    daemonAuthSecret: secret,
    onHookCall: async (body) => {
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
        onNotify: (approval) => {
          console.log(`[hook] enqueued approval ${approval.id.slice(0,8)} for ${approval.toolName}`);
          const summary = summarizeToolInput(approval.toolName, approval.toolInput);
          // Look up the session title so cross-session toasts can show "Approval on <title>"
          // rather than a meaningless id stub. Title may be undefined for very new sessions
          // whose JSONL hasn't been written yet — the client falls back to the id prefix.
          const sessionTitle = findSessionTitle(approval.sessionId);
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
          });
        },
      });
      console.log(`[hook] decision: ${result.hookSpecificOutput.permissionDecision} for ${hookInput.tool_name}`);
      return JSON.stringify(result);
    },
  });

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
    }));
  });

  server.route('GET', '/api/sessions', (_req, res) => {
    const projects = sessionStore.listProjects();
    // Title index across every project's sessions so the pending payload can show
    // "Approval on <title>" toasts cross-project the same as it does today.
    const titleById = new Map<string, string>();
    for (const p of projects) for (const s of p.sessions) titleById.set(s.id, s.title);
    const pending = queue.listPending().map((a) => ({
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
    }));
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

  // Hot-add an allowlist rule. Body shape: { kind: 'tool' | 'bash' | 'mcp', value: string }.
  // Server validates the value (regex compilation for pattern kinds), dedupes against
  // existing rules, and on success atomic-writes the updated allowlist.json so the rule
  // survives a daemon restart. Returns the new rule count for the PWA to refresh.
  server.route('POST', '/api/allowlist/rules', async (req, res) => {
    const body = await readBody(req);
    let payload: { kind?: string; value?: string };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    const { kind, value } = payload;
    if (kind !== 'tool' && kind !== 'bash' && kind !== 'mcp') {
      res.statusCode = 400; res.end('kind must be tool|bash|mcp'); return;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
      res.statusCode = 400; res.end('value must be a 1..500 char string'); return;
    }
    let added: boolean;
    try {
      added = allowlist.addRule(kind, value);
    } catch (e) {
      // Invalid regex from a bash/mcp pattern — addRule rethrows the RegExp ctor error.
      res.statusCode = 400; res.end(`invalid pattern: ${(e as Error).message}`); return;
    }
    if (added) {
      // Atomic write: stage to .tmp, then rename — avoids leaving a partially-written
      // allowlist.json if the process dies mid-write.
      const tmp = `${ALLOWLIST_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(allowlist.toConfig(), null, 2) + '\n');
      renameSync(tmp, ALLOWLIST_PATH);
      console.log(`[api] allowlist: added ${kind} rule ${JSON.stringify(value)} (total ${allowlist.ruleCount()})`);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ added, ruleCount: allowlist.ruleCount() }));
  });

  // Delete a session — kills the subprocess AND removes the .jsonl from disk. Unrecoverable.
  server.route('DELETE', '/api/sessions/:id', async (req, res) => {
    const id = (req.url ?? '').split('/').pop()!;
    await manager.close(id);
    const removed = sessionStore.delete(id);
    console.log(`[api] delete session ${id.slice(0,8)} subprocess=killed file=${removed ? 'removed' : 'not-found'}`);
    res.statusCode = 204;
    res.end();
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

  // Push every approval resolution out to clients so the PWA can render a "Timed out"
  // tile rather than the card silently disappearing — and so a second device viewing
  // the same session sees the same decision the first device made.
  queue.onResolve = (approval, decision) => {
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
      ws.send(JSON.stringify({
        type: 'notifications_snapshot',
        approvals: queue.listPending().map((a) => ({
          approvalId: a.id,
          sessionId: a.sessionId,
          toolName: a.toolName,
          toolInput: a.toolInput,
          toolUseId: a.toolUseId,
          agentId: a.agentId,
          agentType: a.agentType,
          summary: summarizeToolInput(a.toolName, a.toolInput),
          sessionTitle: titleById.get(a.sessionId),
        })),
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
    let cwd: string | undefined;
    const queryIdx = url.indexOf('?');
    if (queryIdx >= 0) {
      const params = new URLSearchParams(url.slice(queryIdx + 1));
      const raw = params.get('cwd');
      if (raw) cwd = raw; // URLSearchParams already decodes
    }
    manager.attach(sessionId, ws, { cwd });
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
      }
    });
  });

  // Static files for the PWA
  const STATIC_FILES: Record<string, { contentType: string; file: string }> = {
    '/': { contentType: 'text/html', file: 'index.html' },
    '/index.html': { contentType: 'text/html', file: 'index.html' },
    '/app.js': { contentType: 'text/javascript', file: 'app.js' },
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
