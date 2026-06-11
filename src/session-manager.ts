import { statSync } from 'node:fs';
import { ClaudeProc } from './claude-proc.js';
import type { WebSocket } from 'ws';
import type { WorktreeManager } from './worktree-manager.js';

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
  // Optional: when set, attach() honors spawnMode='worktree' by calling create() on
  // the manager and spawning claude at the resulting worktreePath. Phase 2b plumbing.
  worktreeManager?: WorktreeManager;
  onProcMessage?: (sessionId: string, msg: unknown) => void;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  // Tracks the cwd for every session we've spawned. Persists across the session's lifetime
  // so getCwd() works even after the process exits (hook may fire mid-session).
  private sessionCwds = new Map<string, string>();

  constructor(private opts: SessionManagerOpts) {}

  // `cwd` is honored only when the session does not exist yet (first attach for a new id).
  // On resume, the cwd is read from the session's own JSONL via SessionStore.findSession,
  // so the query-param cwd from the URL is ignored.
  //
  // `spawnMode='worktree'` (Phase 2b) creates a fresh git worktree under WorktreeManager
  // and spawns claude there. Requires `baseBranch`. On worktree-creation failure (e.g.
  // not a git repo, dirty index, branch conflict) the daemon emits `daemon_error` and
  // closes the WS — no silent fallback to shared mode.
  attach(sessionId: string, ws: WebSocket, opts: { cwd?: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string } = {}): void {
    let s = this.active.get(sessionId);
    if (s) {
      this.attachClient(s, ws);
      return;
    }
    // Resume path: an existing worktree session re-attaches to its recorded worktreePath.
    const existingWt = this.opts.worktreeManager?.get(sessionId);
    if (existingWt && !existingWt.archivedAt && existingWt.worktreePath) {
      s = this.spawn(sessionId, existingWt.worktreePath);
      this.attachClient(s, ws);
      return;
    }
    // Resume path for a known shared-cwd session: use SessionStore's recorded cwd.
    const known = this.opts.sessionStore.findSession(sessionId);
    if (known) {
      s = this.spawn(sessionId, known.cwd);
      this.attachClient(s, ws);
      return;
    }
    // New session path: validate the supplied cwd, then either spawn straight at it
    // (shared) or hand it to WorktreeManager (worktree) and spawn at the resulting path.
    if (!opts.cwd || !opts.cwd.startsWith('/')) {
      ws.send(JSON.stringify({
        type: 'daemon_error',
        message: opts.cwd
          ? `cwd must be absolute: ${opts.cwd}`
          : 'cwd required for new session',
      }));
      ws.close();
      return;
    }
    try {
      if (!statSync(opts.cwd).isDirectory()) {
        ws.send(JSON.stringify({ type: 'daemon_error', message: `cwd is not a directory: ${opts.cwd}` }));
        ws.close();
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'daemon_error', message: `cwd does not exist: ${opts.cwd}` }));
      ws.close();
      return;
    }
    if (opts.spawnMode === 'worktree') {
      if (!this.opts.worktreeManager) {
        ws.send(JSON.stringify({ type: 'daemon_error', message: 'worktreeManager not configured but spawnMode=worktree requested' }));
        ws.close();
        return;
      }
      if (!opts.baseBranch) {
        ws.send(JSON.stringify({ type: 'daemon_error', message: 'baseBranch required for spawnMode=worktree' }));
        ws.close();
        return;
      }
      const cwd = opts.cwd;
      const baseBranch = opts.baseBranch;
      const wtMgr = this.opts.worktreeManager;
      // Asynchronously create the worktree, then spawn. Errors → daemon_error + close.
      void (async () => {
        let worktreePath: string;
        try {
          const rec = await wtMgr.create({ sessionId, projectCwd: cwd, baseBranch });
          worktreePath = rec.worktreePath;
        } catch (e) {
          ws.send(JSON.stringify({
            type: 'daemon_error',
            message: `worktree creation failed: ${(e as Error).message}`,
          }));
          ws.close();
          return;
        }
        const session = this.spawn(sessionId, worktreePath);
        this.attachClient(session, ws);
      })();
      return;
    }
    // Default: shared cwd (Phase 2a behavior).
    s = this.spawn(sessionId, opts.cwd);
    this.attachClient(s, ws);
  }

  private attachClient(s: ActiveSession, ws: WebSocket): void {
    s.clients.add(ws);
    this.cancelIdleTimer(s);
    const cutoff = Date.now() - BUFFER_REPLAY_MS;
    for (const m of s.recentMessages) {
      if (m.at >= cutoff) ws.send(JSON.stringify(m.msg));
    }
    ws.on('close', () => {
      s.clients.delete(ws);
      if (s.clients.size === 0) this.startIdleTimer(s);
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

  // Returns the cwd used to spawn the given active session. Used by the daemon's
  // cwdForSession so project-scoped allowlist lookups work even for sessions whose
  // JSONL hasn't been flushed to disk yet (e.g. the very first tool call of a new session).
  getCwd(sessionId: string): string | undefined {
    return this.sessionCwds.get(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const s = this.active.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    await s.proc.kill();
    for (const ws of s.clients) ws.close();
    this.active.delete(sessionId);
  }

  private spawn(sessionId: string, cwd: string): ActiveSession {
    this.sessionCwds.set(sessionId, cwd);
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
