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
  // Cwd to spawn claude in. Determines where sessions are persisted on disk under
  // ~/.claude/projects/<sanitized-cwd>/. Must match the SessionStore's read directory.
  claudeCwd: string;
  // Returns true if a session with this ID already has a stored conversation on disk.
  // Used to decide between `claude --resume <id>` (existing) and `claude --session-id <id>` (new).
  sessionExists: (id: string) => boolean;
  onProcMessage?: (sessionId: string, msg: unknown) => void;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();

  constructor(private opts: SessionManagerOpts) {}

  attach(sessionId: string, ws: WebSocket): void {
    let s = this.active.get(sessionId);
    if (!s) s = this.spawn(sessionId);
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

  async close(sessionId: string): Promise<void> {
    const s = this.active.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    await s.proc.kill();
    for (const ws of s.clients) ws.close();
    this.active.delete(sessionId);
  }

  private spawn(sessionId: string): ActiveSession {
    const s: ActiveSession = {
      id: sessionId,
      clients: new Set(),
      recentMessages: [],
      lastActivity: Date.now(),
      proc: null!,
    };
    const mode = this.opts.sessionExists(sessionId) ? 'resume' : 'new';
    s.proc = new ClaudeProc({
      sessionId,
      mode,
      settingsPath: this.opts.settingsPath,
      cwd: this.opts.claudeCwd,
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
