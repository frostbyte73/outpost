import { statSync } from 'node:fs';
import { ClaudeProc } from './claude-proc.js';
import type { WebSocket } from 'ws';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const BUFFER_REPLAY_MS = 30 * 1000;

interface ActiveSession {
  id: string;
  proc: ClaudeProc;
  clients: Set<WebSocket>;
  recentMessages: { at: number; msg: unknown }[];
  idleTimer?: NodeJS.Timeout;
  lastActivity: number;
}

export interface SessionManagerOpts {
  settingsPath: string;
  daemonAuthSecret: string;
  daemonHost: string;
  // Used to resolve cwd for known sessions (resume) and to confirm session existence.
  // For brand-new sessions the cwd arrives via attach()'s opts.cwd parameter.
  sessionStore: import('./session-store.js').SessionStore;
  onProcMessage?: (sessionId: string, msg: unknown) => void;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();

  constructor(private opts: SessionManagerOpts) {}

  // `cwd` is honored only when the session does not exist yet (first attach for a new id).
  // On resume, the cwd is read from the session's own JSONL via SessionStore.findSession,
  // so the query-param cwd from the URL is ignored.
  attach(sessionId: string, ws: WebSocket, opts: { cwd?: string } = {}): void {
    let s = this.active.get(sessionId);
    if (!s) {
      const cwd = this.resolveCwdForAttach(sessionId, opts.cwd);
      if (!cwd) {
        ws.send(JSON.stringify({
          type: 'daemon_error',
          message: opts.cwd
            ? `cwd does not exist or is not a directory: ${opts.cwd}`
            : 'cwd required for new session',
        }));
        ws.close();
        return;
      }
      s = this.spawn(sessionId, cwd);
    }
    s.clients.add(ws);
    this.cancelIdleTimer(s);
    const cutoff = Date.now() - BUFFER_REPLAY_MS;
    for (const m of s.recentMessages) {
      if (m.at >= cutoff) ws.send(JSON.stringify(m.msg));
    }
    ws.on('close', () => {
      s!.clients.delete(ws);
      if (s!.clients.size === 0) this.startIdleTimer(s!);
    });
  }

  send(sessionId: string, message: unknown): void {
    const s = this.active.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not active`);
    s.lastActivity = Date.now();
    s.proc.send(message);
  }

  // Broadcast a daemon-originated message (not from the subprocess) to all attached WS clients
  // for the given session. Used to surface session-scoped events that didn't come from claude.
  broadcast(sessionId: string, message: unknown): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    for (const ws of s.clients) ws.send(JSON.stringify(message));
  }

  // Interrupt the in-flight generation. Sends SIGINT to the claude subprocess; the
  // existing exit-handler path then notifies attached WS clients via daemon_proc_exit,
  // and the PWA's "Reopen" tile lets the user resume from where it cut off.
  interrupt(sessionId: string): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    s.proc.interrupt();
  }

  async close(sessionId: string): Promise<void> {
    const s = this.active.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    await s.proc.kill();
    for (const ws of s.clients) ws.close();
    this.active.delete(sessionId);
  }

  // Determine which cwd to spawn a session under. For an existing session, return the
  // SessionStore's recorded cwd (ignoring whatever the client passed). For a brand-new
  // session, require an absolute path to a real directory. Returns null on validation
  // failure; caller surfaces a daemon_error.
  private resolveCwdForAttach(sessionId: string, requestedCwd: string | undefined): string | null {
    const known = this.opts.sessionStore.findSession(sessionId);
    if (known) return known.cwd;
    if (!requestedCwd) return null;
    if (!requestedCwd.startsWith('/')) return null;
    try {
      if (!statSync(requestedCwd).isDirectory()) return null;
    } catch {
      return null;
    }
    return requestedCwd;
  }

  private spawn(sessionId: string, cwd: string): ActiveSession {
    const s: ActiveSession = {
      id: sessionId,
      clients: new Set(),
      recentMessages: [],
      lastActivity: Date.now(),
      proc: null!,
    };
    // Existence is determined by SessionStore.findSession — the same source of truth used
    // for cwd resolution above. Avoids a separate "does this jsonl exist?" callback.
    const mode = this.opts.sessionStore.findSession(sessionId) ? 'resume' : 'new';
    s.proc = new ClaudeProc({
      sessionId,
      mode,
      settingsPath: this.opts.settingsPath,
      cwd,
      env: { DAEMON_AUTH: this.opts.daemonAuthSecret, DAEMON_HOST: this.opts.daemonHost },
      onMessage: (msg) => {
        s.lastActivity = Date.now();
        s.recentMessages.push({ at: Date.now(), msg });
        const cutoff = Date.now() - BUFFER_REPLAY_MS;
        while (s.recentMessages.length > 0 && s.recentMessages[0]!.at < cutoff) {
          s.recentMessages.shift();
        }
        for (const ws of s.clients) ws.send(JSON.stringify(msg));
        this.opts.onProcMessage?.(sessionId, msg);
      },
      onError: (errMsg) => {
        for (const ws of s.clients) {
          ws.send(JSON.stringify({ type: 'daemon_error', message: errMsg }));
        }
      },
      onExit: (code) => {
        for (const ws of s.clients) {
          ws.send(JSON.stringify({ type: 'daemon_proc_exit', code }));
        }
        this.active.delete(sessionId);
      },
    });
    this.active.set(sessionId, s);
    return s;
  }

  private startIdleTimer(s: ActiveSession): void {
    s.idleTimer = setTimeout(() => {
      const since = Date.now() - s.lastActivity;
      if (since < IDLE_TIMEOUT_MS) {
        this.startIdleTimer(s);
        return;
      }
      void this.close(s.id);
    }, IDLE_TIMEOUT_MS);
  }

  private cancelIdleTimer(s: ActiveSession): void {
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
  }
}
