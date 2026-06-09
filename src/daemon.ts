import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, createReadStream } from 'node:fs';
import { Allowlist } from './allowlist.js';
import { ApprovalQueue } from './approvals.js';
import { SessionStore } from './session-store.js';
import { SessionManager } from './session-manager.js';
import { Server } from './server.js';
import { HookServer } from './hook-server.js';
import { discoverTailscaleEnv } from './tailscale.js';
import { writeDaemonSettings, generateSecret } from './settings-gen.js';
import { handleHook } from './hook-handler.js';
import allowlistConfig from '../config/allowlist.json' with { type: 'json' };

const RUNTIME_DIR = join(homedir(), '.claude-relay');
mkdirSync(RUNTIME_DIR, { recursive: true });

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PWA_DIR = join(SRC_DIR, 'pwa');

async function main() {
  const tsEnv = discoverTailscaleEnv({ certDir: RUNTIME_DIR });

  const secret = generateSecret();
  const HOOK_PORT = 8444;
  const settingsPath = join(RUNTIME_DIR, 'daemon-settings.json');
  writeDaemonSettings({ outPath: settingsPath, hookPort: HOOK_PORT });

  const allowlist = new Allowlist(allowlistConfig);
  const queue = new ApprovalQueue({ timeoutMs: 10 * 60 * 1000 });

  // Pin claude's cwd so all daemon-spawned sessions land in the same project dir on disk,
  // and the SessionStore reads from that same dir. Point this at whichever workspace
  // holds the CLAUDE.md, project-level plugins, and MCP servers you want relayed sessions
  // to inherit. Defaults to $HOME if unset.
  const claudeCwd = process.env.CLAUDE_RELAY_CWD ?? homedir();
  const sessionDir = process.env.CLAUDE_RELAY_SESSION_DIR ?? sessionDirFor(claudeCwd);
  const sessionStore = new SessionStore({ dir: sessionDir });
  console.log(`[daemon] claude cwd:           ${claudeCwd}`);
  console.log(`[daemon] reading sessions from: ${sessionDir}`);

  const manager = new SessionManager({
    settingsPath,
    daemonAuthSecret: secret,
    daemonHost: tsEnv.hostname,
    claudeCwd,
    sessionExists: (id) => sessionStore.list().some((s) => s.id === id),
  });

  const server = new Server({
    certPath: tsEnv.certPath,
    keyPath: tsEnv.keyPath,
    bindAddress: tsEnv.ipv4,
    port: 8443,
  });

  // PreToolUse hook endpoint (loopback-only — see hook-server.ts for why)
  const hookServer = new HookServer({
    port: HOOK_PORT,
    daemonAuthSecret: secret,
    onHookCall: async (body) => {
      const hookInput = JSON.parse(body);
      console.log(`[hook] ${hookInput.tool_name} session=${hookInput.session_id?.slice(0,8)} input=${JSON.stringify(hookInput.tool_input).slice(0, 200)}`);
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
          const sessionTitle = sessionStore.list().find((s) => s.id === approval.sessionId)?.title;
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
            summary,
            sessionTitle,
          });
        },
      });
      console.log(`[hook] decision: ${result.hookSpecificOutput.permissionDecision} for ${hookInput.tool_name}`);
      return JSON.stringify(result);
    },
  });

  // List sessions
  server.route('GET', '/api/sessions', (_req, res) => {
    const list = sessionStore.list();
    const titleById = new Map(list.map((s) => [s.id, s.title]));
    // Normalize pending approvals to the same shape the WS push uses, so the PWA can
    // treat both delivery paths uniformly. The internal queue tracks `id` but the PWA
    // refers to it as `approvalId`, and the summary is rendered server-side.
    const pending = queue.listPending().map((a) => ({
      approvalId: a.id,
      sessionId: a.sessionId,
      toolName: a.toolName,
      toolInput: a.toolInput,
      summary: summarizeToolInput(a.toolName, a.toolInput),
      sessionTitle: titleById.get(a.sessionId),
      enqueuedAt: a.enqueuedAt,
    }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessions: list, pending }));
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

  server.onWebSocket((ws, req) => {
    const url = req.url ?? '';

    if (url === '/ws/notifications') {
      notificationClients.add(ws);
      // Snapshot the current pending queue so a freshly-attached client (cold start, or
      // a reconnect after iOS backgrounded the PWA) sees what was already enqueued. This
      // is a single event with the full set — distinct from approval_pending so the client
      // can populate state without firing toasts for stale items.
      const titleById = new Map(sessionStore.list().map((s) => [s.id, s.title]));
      ws.send(JSON.stringify({
        type: 'notifications_snapshot',
        approvals: queue.listPending().map((a) => ({
          approvalId: a.id,
          sessionId: a.sessionId,
          toolName: a.toolName,
          toolInput: a.toolInput,
          summary: summarizeToolInput(a.toolName, a.toolInput),
          sessionTitle: titleById.get(a.sessionId),
        })),
      }));
      ws.on('close', () => notificationClients.delete(ws));
      return;
    }

    const m = url.match(/^\/ws\/sessions\/([\w-]+)$/);
    if (!m) {
      ws.close();
      return;
    }
    const sessionId = m[1]!;
    manager.attach(sessionId, ws);
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
  console.log(`[daemon] listening on https://${tsEnv.hostname}:8443 (${tsEnv.ipv4})`);
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

function sessionDirFor(cwd: string): string {
  // Claude Code sanitizes the cwd by replacing '/' with '-' (so `/Users/alice` becomes `-Users-alice`).
  const sanitized = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', sanitized);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
