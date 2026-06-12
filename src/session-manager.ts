import { statSync } from 'node:fs';
import { ClaudeProc } from './claude-proc.js';
import { EventLog } from './event-log.js';
import type { WebSocket } from 'ws';
import type { WorktreeManager } from './worktree-manager.js';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// 10 min wall-clock OR 5000 events, whichever caps first. Generous enough to survive
// iOS backgrounding the PWA. Override at construction time for tests.
const DEFAULT_EVENT_LOG_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_LOG_MAX_EVENTS = 5000;

interface ActiveSession {
  id: string;
  proc: ClaudeProc;
  clients: Set<WebSocket>;
  eventLog: EventLog;
  idleTimer?: NodeJS.Timeout;
  lastActivity: number;
  // The actual directory claude was spawned in. Equals the project cwd for shared-cwd
  // sessions and the worktree path for worktree sessions. Forwarded to clients via
  // session_state so the PWA can anchor file paths in tool tiles before the next
  // /api/sessions refresh folds the worktreePath into state.projects.
  spawnCwd: string;
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
  // Phase 3: per-session event-log caps. Defaults are 5000 events / 10 minutes; tests
  // shrink these to force replay_gap fallback paths without producing 5000 fixtures.
  eventLogMaxEvents?: number;
  eventLogMaxAgeMs?: number;
  // Phase 4: fires when a user_message is forwarded to the subprocess — i.e. the start
  // of a turn. Lets the daemon record turn-start timestamps so the Stop hook can decide
  // whether the turn was long enough to warrant a push notification.
  onTurnStart?: (sessionId: string) => void;
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
  attach(sessionId: string, ws: WebSocket, opts: { cwd?: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string; since?: number } = {}): void {
    const since = opts.since ?? 0;
    let s = this.active.get(sessionId);
    if (s) {
      this.attachClient(s, ws, since);
      return;
    }
    // Resume path: an existing worktree session re-attaches to its recorded worktreePath.
    const existingWt = this.opts.worktreeManager?.get(sessionId);
    if (existingWt && !existingWt.archivedAt && existingWt.worktreePath) {
      s = this.spawn(sessionId, existingWt.worktreePath);
      this.attachClient(s, ws, since);
      return;
    }
    // Resume path for a known shared-cwd session: use SessionStore's recorded cwd.
    const known = this.opts.sessionStore.findSession(sessionId);
    if (known) {
      s = this.spawn(sessionId, known.cwd);
      this.attachClient(s, ws, since);
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
        this.attachClient(session, ws, since);
      })();
      return;
    }
    // Default: shared cwd (Phase 2a behavior).
    s = this.spawn(sessionId, opts.cwd);
    this.attachClient(s, ws, since);
  }

  // Adds a client to an existing session, sends the seq-window snapshot, and replays
  // missed events from `since` onwards. If `since` predates the log's earliestSeq the
  // client is told to recover via the HTTP transcript endpoint instead (replay_gap).
  private attachClient(s: ActiveSession, ws: WebSocket, since: number): void {
    s.clients.add(ws);
    this.cancelIdleTimer(s);

    // Protocol frame, no _seq — informs the client of the available seq window and
    // the actual spawn cwd (worktree path for worktree sessions, project cwd otherwise)
    // so the PWA can render project-relative paths from the very first event.
    ws.send(JSON.stringify({
      type: 'session_state',
      latestSeq: s.eventLog.latestSeq(),
      earliestSeq: s.eventLog.earliestSeq(),
      spawnCwd: s.spawnCwd,
    }));

    if (since > 0 && since < s.eventLog.earliestSeq() - 1) {
      // Client's last-seen seq is older than what we kept. Bail out to HTTP recovery.
      ws.send(JSON.stringify({
        type: 'replay_gap',
        from: since,
        earliest: s.eventLog.earliestSeq(),
      }));
    } else {
      for (const evt of s.eventLog.replayFrom(since)) {
        ws.send(JSON.stringify({ ...(evt.message as object), _seq: evt.seq }));
      }
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
    // The daemon calls send() only for user_message envelopes today. Match that
    // contract by checking type rather than firing on every send.
    if (typeof message === 'object' && message !== null
        && (message as { type?: string }).type === 'user'
        && this.opts.onTurnStart) {
      this.opts.onTurnStart(sessionId);
    }
    s.proc.send(message);
  }

  // Broadcast a daemon-originated message (not from the subprocess) to all attached WS clients
  // for the given session. Routed through the eventLog so reconnects replay it like any
  // other event — important for things like approval_mode changes that a reconnecting
  // device needs to learn about.
  broadcast(sessionId: string, message: unknown): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    const evt = s.eventLog.push(message);
    const payload = JSON.stringify({ ...(message as object), _seq: evt.seq });
    for (const ws of s.clients) ws.send(payload);
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
      eventLog: new EventLog({
        maxEvents: this.opts.eventLogMaxEvents ?? DEFAULT_EVENT_LOG_MAX_EVENTS,
        maxAgeMs: this.opts.eventLogMaxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS,
      }),
      lastActivity: Date.now(),
      proc: null!,
      spawnCwd: cwd,
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
        const evt = s.eventLog.push(msg);
        const payload = JSON.stringify({ ...(msg as object), _seq: evt.seq });
        for (const ws of s.clients) ws.send(payload);
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
