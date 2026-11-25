import { statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { buildHandoffSeed } from './handoff-seed.js';
import { segmentItem, type TranscriptSegment } from './session-store.js';
import { isAuthFailure } from '../integrations/claude-login.js';
import { EventLog } from './event-log.js';
import { openNdjsonLog, type NdjsonLog } from '../runtime/event-ndjson.js';
import type { WebSocket } from 'ws';
import type { WorktreeManager } from '../git/worktree-manager.js';
import type { RuntimeRegistry } from '../runtime/registry.js';
import { isRuntimeId } from '../runtime/types.js';
import type {
  CanonicalEvent, FirstTurnSeed, PermissionMode, RuntimeId, RuntimeSession, SessionKind, SessionModel, TurnInput,
} from '../runtime/types.js';

// Why the daemon itself is tearing a session down, threaded into daemon_proc_exit
// so the PWA can tell a graceful shutdown from a crash. 'idle' = reaped for
// inactivity (resumable on the next message); 'archived' = worktree/step gone;
// 'reauth' = recycled to pick up a credential that was just re-authorized;
// 'shutdown' = the daemon itself is exiting (resumable once it is back).
// Absent on the exit event means the subprocess died on its own → a real crash.
export type SessionCloseReason = 'idle' | 'archived' | 'reauth' | 'shutdown' | 'runtime-switch';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// Replay window sized to survive iOS backgrounding the PWA.
const DEFAULT_EVENT_LOG_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_LOG_MAX_EVENTS = 5000;

interface ActiveSession {
  id: string;
  session: RuntimeSession;
  clients: Set<WebSocket>;
  eventLog: EventLog;
  idleTimer?: NodeJS.Timeout;
  // Set by close() right before it ends the session so onExit can flag the exit as
  // daemon-initiated (vs a crash). Cleared implicitly — a fresh spawn makes a new session.
  closeReason?: SessionCloseReason;
  exited: Promise<void>;
  lastActivity: number;
  // Forwarded via session_state so the PWA can anchor file paths before the next /api/sessions refresh.
  spawnCwd: string;
  // Ids we've already fired onSessionRegistered for (guards against re-firing every init message).
  registeredIds: Set<string>;
  stderrTail: string;
  seedInFlight?: string;
  replayEpoch?: string;
  launchCredential: string;
  finish?: (code: number | null) => void;
}

const STDERR_TAIL_CHARS = 2000;

export interface SessionExit {
  expected?: SessionCloseReason;
  stderrTail: string;
}

export interface SessionManagerOpts {
  runtimes: RuntimeRegistry;
  sessionStore: import('./session-store.js').SessionStore;
  worktreeManager?: WorktreeManager;
  runtimeRefusal?: (sessionId: string, runtime: RuntimeId) => string | undefined;
  // Where each session's native + canonical event streams are appended; absent, nothing is logged.
  runtimeLogDir?: string;
  // Tests shrink these to force replay_gap fallback paths without producing 5000 fixtures.
  eventLogMaxEvents?: number;
  eventLogMaxAgeMs?: number;
  // Fires on user_message forwarding so the Stop hook can gate push notifications on turn duration.
  onTurnStart?: (sessionId: string) => void;
  // Fires when a spawned claude subprocess exits. Used by the work orchestrator to detect
  // investigator/implementer/responder sessions that died without signalling completion.
  onSessionExit?: (sessionId: string, code: number | null, exit: SessionExit) => void;
  // Fires the first time the runtime reports the session started (its transcript is on disk by then).
  // Daemon fans this out as a `sessions_changed` notification so the PWA can refresh its
  // list without waiting for a full reload.
  onSessionRegistered?: (sessionId: string) => void;
  // Fires when a subprocess complains that Claude's own authentication has lapsed. The
  // complaint only ever appears on stderr, and the frame it becomes reaches attached clients
  // only — so without this the lapse is invisible to anyone not watching the session that hit it.
  onAuthFailure?: (sessionId: string, message: string) => void;
  // Fires on every launch carrying an env, spawn or not: a running session's next round has a new envelope.
  onLaunch?: (sessionId: string, cwd: string, env: Record<string, string>) => void;
  // A quiet session holding one of these is waiting on the user, not idle, so it isn't reaped.
  hasPendingApproval?: (sessionId: string) => boolean;
  onWorkingChange?: (sessionId: string, working: boolean) => void;
  onAssistantReply?: (sessionId: string, at: number) => void;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  // Sockets viewing a session that has no process; promoted to clients when it wakes.
  private watchers = new Map<string, Set<WebSocket>>();
  // A brand-new session's attach hints, held until its first wake.
  private spawnHints = new Map<string, { cwd: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string; runtime: RuntimeId }>();
  private waking = new Map<string, Promise<void>>();
  private readonly switching = new Map<string, Promise<void>>();
  private readonly workSubmissions = new Map<string, number>();
  // The id each socket attached under, so a /clear rekey doesn't move it to a session it never opened.
  private socketIds = new Map<WebSocket, string>();
  // Persists across the session's lifetime so getCwd() works after the process exits (hook may fire mid-session).
  private sessionCwds = new Map<string, string>();
  // In-memory; lost on daemon restart. Only set when a session is spawned via the
  // agent / skill edit endpoints. Used by GET /api/sessions to surface kind for
  // PWA-side filtering of the Projects view.
  private sessionKinds = new Map<string, SessionKind>();

  tagKind(sessionId: string, kind: SessionKind): void {
    this.sessionKinds.set(sessionId, kind);
  }

  getKind(sessionId: string): SessionKind | undefined {
    return this.sessionKinds.get(sessionId);
  }

  constructor(private opts: SessionManagerOpts) {}

  // Refuse an attach the daemon can never satisfy. `fatal` is what tells the client this close
  // is a verdict on the URL rather than a dropped connection — it reconnects with backoff on an
  // ordinary close, and re-sending the identical query would be refused identically, forever.
  private rejectAttach(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: 'daemon_error', fatal: true, message }));
    ws.close();
  }

  // Never spawns: with no live process the socket watches until wake(); a new session's hints are checked now and held.
  attach(sessionId: string, ws: WebSocket, opts: { cwd?: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string; since?: number; epoch?: string; model?: SessionModel; runtime?: string } = {}): void {
    // Sticky per-session: applied on this spawn and any later idle-reap respawn.
    if (opts.model) this.sessionModels.set(sessionId, opts.model);
    const s = this.active.get(sessionId);
    if (s) {
      this.trackSocket(sessionId, ws);
      this.attachClient(s, ws, opts.since ?? 0, opts.epoch);
      return;
    }
    let spawnCwd = this.resumeCwd(sessionId);
    if (!spawnCwd) {
      const existing = this.spawnHints.get(sessionId);
      if (existing) {
        spawnCwd = existing.cwd;
      } else {
        const refusal = this.validateHints(sessionId, opts);
        if (refusal) {
          this.rejectAttach(ws, refusal);
          return;
        }
        const runtime = this.opts.sessionStore.readRuntime(sessionId) ?? opts.runtime ?? 'claude';
        if (!isRuntimeId(runtime) || (runtime !== 'claude' && !this.opts.runtimes.get(runtime)?.available)) {
          this.rejectAttach(ws, `Runtime ${runtime} is unavailable`);
          return;
        }
        spawnCwd = opts.cwd!;
        this.spawnHints.set(sessionId, { cwd: spawnCwd, spawnMode: opts.spawnMode, baseBranch: opts.baseBranch, runtime });
      }
    }
    this.trackSocket(sessionId, ws);
    this.addWatcher(sessionId, ws);
    ws.send(JSON.stringify({
      type: 'session_state', latestSeq: 0, earliestSeq: 0, spawnCwd, working: false, workingSince: null, live: false,
      epoch: this.opts.sessionStore.currentSegment(sessionId) ? this.runtimeVersion(sessionId) : undefined,
    }));
  }

  // Start the session's process if it has none and hand it every watching socket.
  wake(sessionId: string): Promise<void> {
    const switching = this.switching.get(sessionId);
    if (switching) return switching.then(() => this.wake(sessionId));
    const s = this.active.get(sessionId);
    if (s && !s.closeReason) {
      s.lastActivity = Date.now();
      return Promise.resolve();
    }
    let pending = this.waking.get(sessionId);
    if (!pending) {
      pending = (s ? s.exited : Promise.resolve())
        .then(() => this.spawnForWake(sessionId))
        .finally(() => this.waking.delete(sessionId));
      this.waking.set(sessionId, pending);
    }
    return pending;
  }

  private async spawnForWake(sessionId: string): Promise<void> {
    const hints = this.spawnHints.get(sessionId);
    let cwd = this.resumeCwd(sessionId);
    if (!cwd) {
      if (!hints) throw new Error(`session ${sessionId.slice(0, 8)} has no live process and no transcript to resume`);
      cwd = hints.cwd;
      if (hints.spawnMode === 'worktree') {
        try {
          const rec = await this.opts.worktreeManager!.create({ sessionId, projectCwd: hints.cwd, baseBranch: hints.baseBranch! });
          cwd = rec.worktreePath;
        } catch (e) {
          throw new Error(`worktree creation failed: ${(e as Error).message}`);
        }
      }
    }
    if (this.active.has(sessionId)) return;
    const switching = this.switching.get(sessionId);
    if (switching) await switching;
    if (this.active.has(sessionId)) return;
    if (hints) this.bindRuntime(sessionId, hints.runtime);
    this.spawnHints.delete(sessionId);
    this.spawn(sessionId, cwd);
  }

  private resumeCwd(sessionId: string): string | undefined {
    const wt = this.opts.worktreeManager?.get(sessionId);
    if (wt && !wt.archivedAt && wt.worktreePath) return wt.worktreePath;
    return this.opts.sessionStore.findSession(sessionId)?.cwd ?? this.sessionCwds.get(sessionId);
  }

  private validateHints(sessionId: string, opts: { cwd?: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string }): string | null {
    if (!opts.cwd || !opts.cwd.startsWith('/')) {
      return opts.cwd
        ? `cwd must be absolute: ${opts.cwd}`
        : `session ${sessionId.slice(0, 8)} has no live process and no transcript to resume`;
    }
    try {
      if (!statSync(opts.cwd).isDirectory()) return `cwd is not a directory: ${opts.cwd}`;
    } catch {
      return `cwd does not exist: ${opts.cwd}`;
    }
    if (opts.spawnMode === 'worktree') {
      if (!this.opts.worktreeManager) return 'worktreeManager not configured but spawnMode=worktree requested';
      if (!opts.baseBranch) return 'baseBranch required for spawnMode=worktree';
    }
    return null;
  }

  private trackSocket(sessionId: string, ws: WebSocket): void {
    this.socketIds.set(ws, sessionId);
    ws.on('close', () => this.dropSocket(ws));
  }

  private addWatcher(sessionId: string, ws: WebSocket): void {
    let set = this.watchers.get(sessionId);
    if (!set) this.watchers.set(sessionId, set = new Set());
    set.add(ws);
  }

  private dropSocket(ws: WebSocket): void {
    this.socketIds.delete(ws);
    for (const s of this.active.values()) s.clients.delete(ws);
    for (const [id, set] of this.watchers) {
      set.delete(ws);
      if (set.size > 0) continue;
      this.watchers.delete(id);
      if (!this.waking.has(id)) this.spawnHints.delete(id);
    }
  }

  // The process is gone but its viewers stay attached, ready for the next wake.
  private demoteClients(s: ActiveSession): void {
    for (const ws of s.clients) this.addWatcher(this.socketIds.get(ws) ?? s.id, ws);
    s.clients.clear();
  }

  // Replays missed events from `since`; if `since` predates earliestSeq, emits replay_gap so the client falls back to the HTTP transcript endpoint.
  private attachClient(s: ActiveSession, ws: WebSocket, since: number, epoch?: string): void {
    s.clients.add(ws);

    // Protocol frame, no _seq. `working`/`workingSince` are the authoritative turn state:
    // the client's thinking strip is otherwise a pure guess derived from the event stream,
    // and a reconnect that lands past the replay window (or after a respawn, which resets
    // the log) never sees the turn's terminal event — leaving the strip spinning forever
    // on a session that finished minutes ago.
    ws.send(JSON.stringify({
      type: 'session_state',
      latestSeq: s.eventLog.latestSeq(),
      earliestSeq: s.eventLog.earliestSeq(),
      spawnCwd: s.spawnCwd,
      working: this.isWorking(s.id),
      workingSince: this.workingSince(s.id),
      live: true,
      epoch: s.replayEpoch,
    }));

    if (s.replayEpoch && epoch !== s.replayEpoch) since = 0;
    if (since > 0 && since < s.eventLog.earliestSeq() - 1) {
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
  }

  sendTurn(sessionId: string, turn: TurnInput): void {
    if (this.switching.has(sessionId)) throw new Error('Runtime switch in progress');
    const s = this.active.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not active`);
    const refusal = this.opts.runtimeRefusal?.(sessionId, this.runtimeOf(sessionId));
    if (refusal) throw new Error(refusal);
    const segment = this.opts.sessionStore.currentSegment(sessionId);
    let seed: FirstTurnSeed | undefined;
    if (segment?.seedPending && this.opts.sessionStore.hasClaudeSeedRecord(segment)) {
      this.opts.sessionStore.updateSegment(sessionId, segment.id, { seedPending: false, seedAttempt: 'accepted' });
      s.seedInFlight = undefined;
    } else if (segment?.seedPending) {
      if (s.seedInFlight) throw new Error('Waiting for the runtime to accept its first turn');
      if (segment.seedToken && segment.seedAttempt !== 'rejected' && turn.retryDelivery === false) {
        throw new Error('First turn acceptance is unknown. Resume explicitly to continue.');
      }
      seed = this.prepareSeed(s, segment);
    }
    s.lastActivity = Date.now();
    // Don't restamp a turn already in flight — a queued follow-up message would
    // otherwise reset the strip's elapsed clock mid-turn.
    this.startWorking(sessionId);
    this.opts.onTurnStart?.(sessionId);
    s.session.sendTurn(turn, seed);
  }

  private prepareSeed(s: ActiveSession, segment: TranscriptSegment): FirstTurnSeed {
    const token = randomUUID();
    const block = buildHandoffSeed(this.opts.sessionStore.readItems(s.id, segment.id, true), token);
    const retiredSeedTokens = segment.seedToken ? [...(segment.retiredSeedTokens ?? []), segment.seedToken] : segment.retiredSeedTokens;
    this.opts.sessionStore.updateSegment(s.id, segment.id, { seedToken: token, seedAttempt: 'admitted', retiredSeedTokens });
    s.seedInFlight = token;
    return { token, block };
  }

  // Routed through eventLog so reconnects replay daemon-originated messages (e.g. approval_mode changes) like any other event.
  broadcast(sessionId: string, message: unknown): void {
    const s = this.active.get(sessionId);
    if (!s) {
      const payload = JSON.stringify(message);
      for (const ws of this.watchers.get(sessionId) ?? []) ws.send(payload);
      return;
    }
    const evt = s.eventLog.push(message);
    const payload = JSON.stringify({ ...(message as object), _seq: evt.seq });
    for (const ws of s.clients) ws.send(payload);
  }

  interrupt(sessionId: string): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    s.session.interrupt();
  }

  // Lets allowlist lookups work before the session's JSONL is flushed (first tool call of a new session).
  getCwd(sessionId: string): string | undefined {
    return this.sessionCwds.get(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  // Active and not being torn down: a message sent now reaches a process that will answer it.
  isLive(sessionId: string): boolean {
    const s = this.active.get(sessionId);
    return !!s && !s.closeReason;
  }

  // Cleared at the Stop hook: the assistant ended its turn. The proc may stay
  // alive (resume/replan), but it is no longer working.
  markTurnEnded(sessionId: string): void {
    this.stopWorking(sessionId);
    if (this.reloadWhenIdle.delete(sessionId)) void this.close(sessionId, 'reauth');
  }

  // Recycle live sessions so they pick up a credential that was just re-authorized — Claude's
  // own or an MCP server's. A running session reads neither again: the keychain is read at
  // startup and MCP servers are connected there too, so the grant the user just repaired from
  // their phone reaches nothing already in flight.
  //
  // Closing is the whole mechanism — sendOrResume respawns with --resume on the next message,
  // which is the same contract idle-reaping already relies on (engine.ts:416). A session
  // mid-turn is deliberately left alone and closed at its Stop hook instead: killing it would
  // discard the in-flight turn and fail the step that owns it, and credentials only matter at
  // the next spawn anyway.
  reloadForReauth(): { closed: string[]; deferred: string[] } {
    const closed: string[] = [];
    const deferred: string[] = [];
    for (const id of [...this.active.keys()]) {
      if (this.isWorking(id)) {
        this.reloadWhenIdle.add(id);
        deferred.push(id);
      } else {
        void this.close(id, 'reauth');
        closed.push(id);
      }
    }
    return { closed, deferred };
  }

  // Live subprocess AND currently mid-turn. This — not isActive — is the PWA
  // "Running" signal, so a finished-but-not-yet-reaped session reads as idle.
  isWorking(sessionId: string): boolean {
    return this.active.has(sessionId) && this.working.has(sessionId);
  }

  workingCount(): number {
    let n = 0;
    for (const id of this.working.keys()) if (this.active.has(id)) n++;
    return n;
  }

  // When the in-flight turn started, or null if the session isn't working. Lets a
  // client that attached mid-turn show a truthful elapsed time instead of restarting
  // the clock at whatever moment it happened to reconnect.
  workingSince(sessionId: string): number | null {
    if (!this.isWorking(sessionId)) return null;
    return this.working.get(sessionId) ?? null;
  }

  // 'foreground' = live proc with a PWA client attached; 'background' = live proc,
  // no client (detached step sessions, backgrounded tabs); 'idle' = no proc.
  runState(sessionId: string): 'foreground' | 'background' | 'idle' {
    const s = this.active.get(sessionId);
    if (!s) return 'idle';
    return s.clients.size > 0 ? 'foreground' : 'background';
  }

  // Every live session, at once — the daemon's shutdown. The SDK force-kills each process a
  // couple of seconds after its input closes, so this settles quickly whatever the sessions are doing.
  async closeAll(reason: SessionCloseReason): Promise<number> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.close(id, reason)));
    return ids.length;
  }

  async close(sessionId: string, reason: SessionCloseReason = 'archived'): Promise<void> {
    const switching = this.switching.get(sessionId);
    if (switching && reason !== 'runtime-switch') await switching;
    const s = this.active.get(sessionId);
    if (!s) return;
    s.closeReason = reason;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    await s.session.kill();
    if (reason === 'runtime-switch') {
      s.finish?.(null);
      return;
    }
    this.demoteClients(s);
    if (this.active.get(sessionId) !== s) return;
    this.active.delete(sessionId);
    this.stopWorking(sessionId);
  }

  // Spawn a session with no WS attached. Orchestrator uses this for child sessions
  // (investigator, implementer, responder), prompted via sendTurn. Idempotent — no-op if already active.
  // `runtime` binds a new session's harness; a session that already has one keeps it.
  spawnDetached(
    sessionId: string, cwd: string, extraEnv?: Record<string, string>, permissionMode?: PermissionMode, runtime?: RuntimeId,
  ): void {
    if (this.active.has(sessionId)) return;
    if (extraEnv) this.opts.onLaunch?.(sessionId, cwd, extraEnv);
    if (permissionMode) this.permissionModes.set(sessionId, permissionMode);
    if (runtime) this.bindRuntime(sessionId, runtime);
    this.spawn(sessionId, cwd, extraEnv);
    this.startWorking(sessionId);
  }

  // Send a turn; respawn first if idle-reaped. extraEnv is applied only on respawn.
  sendOrResume(sessionId: string, cwd: string, turn: TurnInput, extraEnv?: Record<string, string>, runtime?: RuntimeId): void {
    if (extraEnv) this.opts.onLaunch?.(sessionId, cwd, extraEnv);
    if (runtime) this.bindRuntime(sessionId, runtime);
    if (!this.active.has(sessionId)) this.spawn(sessionId, cwd, extraEnv);
    this.sendTurn(sessionId, turn);
  }

  runtimeOf(sessionId: string): RuntimeId {
    return this.opts.sessionStore.readRuntime(sessionId) ?? 'claude';
  }

  runtimeVersion(sessionId: string): string {
    const segment = this.opts.sessionStore.currentSegment(sessionId);
    return segment ? createHash('sha256').update(segment.id).digest('hex') : sessionId;
  }

  replayPosition(sessionId: string): { epoch?: string; cursor: number } {
    const active = this.active.get(sessionId);
    const epoch = active ? active.replayEpoch
      : this.opts.sessionStore.currentSegment(sessionId) ? this.runtimeVersion(sessionId) : undefined;
    return { epoch, cursor: active?.eventLog.latestSeq() ?? 0 };
  }

  runtimeSwitchPending(sessionId: string): Promise<void> | undefined {
    return this.switching.get(sessionId);
  }

  acceptsWorkSubmission(sessionId: string, credential: string | undefined): boolean {
    if (this.switching.has(sessionId)) return false;
    return credential !== undefined && this.active.get(sessionId)?.launchCredential === credential;
  }

  async submitWork<T>(sessionId: string, submit: () => Promise<T>): Promise<T> {
    this.workSubmissions.set(sessionId, (this.workSubmissions.get(sessionId) ?? 0) + 1);
    try { return await submit(); }
    finally {
      const count = this.workSubmissions.get(sessionId)! - 1;
      if (count) this.workSubmissions.set(sessionId, count);
      else this.workSubmissions.delete(sessionId);
    }
  }

  switchRuntime(sessionId: string, target: RuntimeId, version: string, validate: () => void): Promise<void> {
    if (this.switching.has(sessionId)) throw new Error('Runtime switch in progress');
    if (this.workSubmissions.has(sessionId)) throw new Error('Wait for the active work submission to finish');
    const runtime = this.opts.runtimes.get(target);
    if (!runtime?.available) throw new Error(`Runtime ${target} is unavailable`);
    if (this.runtimeOf(sessionId) === target) return Promise.resolve();
    if (this.runtimeVersion(sessionId) !== version) throw new Error('The selected runtime has changed');
    if (this.active.get(sessionId)?.session.hasPendingTools?.()) throw new Error('Wait for admitted tools to finish before switching runtimes');
    validate();
    const cwd = this.resumeCwd(sessionId);
    if (!cwd) throw new Error('Session has no workspace');
    const pending = Promise.resolve().then(async () => {
      const source = this.active.get(sessionId);
      if (source && this.isWorking(sessionId)) source.session.interrupt();
      const closed = this.close(sessionId, 'runtime-switch');
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Could not confirm the source runtime stopped')), 15_000);
          timeout.unref();
        })]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      validate();
      this.opts.sessionStore.appendSegment(sessionId, {
        id: randomUUID(), runtime: target, projectDir: runtime.transcripts.projectDirFor(cwd), seedPending: true,
      }, cwd);
      this.broadcast(sessionId, { type: 'session_runtime_changed', runtime: target, version: this.runtimeVersion(sessionId) });
      this.opts.onSessionRegistered?.(sessionId);
    }).finally(() => { this.switching.delete(sessionId); });
    this.switching.set(sessionId, pending);
    return pending;
  }

  private bindRuntime(sessionId: string, runtime: RuntimeId): void {
    if (!this.opts.sessionStore.readRuntime(sessionId)) this.opts.sessionStore.writeRuntime(sessionId, runtime);
  }

  private readonly permissionModes = new Map<string, PermissionMode>();
  private readonly sessionModels = new Map<string, SessionModel>();
  // Sessions currently executing a turn → the ms timestamp that turn started. Set
  // when a session is spawned or sent a prompt; cleared at the Stop hook
  // (markTurnEnded) or when the proc goes away. This is the liveness signal for the
  // PWA Tracked "Running" bucket — a session kept alive after finishing its turn
  // (idle-reap is 15 min out) must NOT read as working.
  private readonly working = new Map<string, number>();
  // Sessions that were mid-turn when a credential was re-authorized — closed at their Stop
  // hook instead. See reloadForReauth.
  private readonly reloadWhenIdle = new Set<string>();

  // `extraEnv` is sticky: a caller that has none (attach, from the PWA) inherits what this
  // session was last spawned with, so a step session keeps its `$OUTPOST_ENVELOPE` no matter
  // which door respawns it. Persisted rather than held in memory — a daemon restart followed
  // by a PWA attach is the same loss.
  private spawn(sessionId: string, cwd: string, extraEnv?: Record<string, string>): ActiveSession {
    if (extraEnv) this.opts.sessionStore.writeSpawnEnv(sessionId, extraEnv);
    const env = extraEnv ?? this.opts.sessionStore.readSpawnEnv(sessionId) ?? {};
    this.sessionCwds.set(sessionId, cwd);
    const s: ActiveSession = {
      id: sessionId,
      clients: new Set(),
      eventLog: new EventLog({
        maxEvents: this.opts.eventLogMaxEvents ?? DEFAULT_EVENT_LOG_MAX_EVENTS,
        maxAgeMs: this.opts.eventLogMaxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS,
      }),
      lastActivity: Date.now(),
      exited: null!,
      session: null!,
      spawnCwd: cwd,
      registeredIds: new Set(),
      stderrTail: '',
      launchCredential: randomUUID(),
    };
    let markExited!: () => void;
    s.exited = new Promise((resolve) => { markExited = resolve; });
    let segment = this.opts.sessionStore.currentSegment(sessionId);
    if (segment?.runtime === 'claude' && segment.seedPending === false && !this.opts.sessionStore.hasSegmentTranscript(segment)) {
      segment = { id: randomUUID(), runtime: segment.runtime, projectDir: segment.projectDir, seedPending: true };
      this.opts.sessionStore.appendSegment(sessionId, segment, cwd);
    }
    const mode = segment
      ? (segment.nativeId || this.opts.sessionStore.hasSegmentTranscript(segment) ? 'resume' : 'new')
      : (this.opts.sessionStore.findSession(sessionId) ? 'resume' : 'new');
    const permissionMode = this.permissionModes.get(sessionId);
    const runtimeId = this.runtimeOf(sessionId);
    const refusal = this.opts.runtimeRefusal?.(sessionId, runtimeId);
    if (refusal) throw new Error(refusal);
    const model = runtimeId === 'claude' ? this.sessionModels.get(sessionId) : undefined;
    const systemPrompt = this.opts.sessionStore.readSystemPrompt(sessionId);
    const log: NdjsonLog | undefined = this.opts.runtimeLogDir ? openNdjsonLog(this.opts.runtimeLogDir, sessionId) : undefined;
    const runtime = runtimeId === 'claude' ? this.opts.runtimes.claude : this.opts.runtimes.get(runtimeId);
    if (!runtime || runtime.available === false) {
      log?.close();
      throw new Error(`Runtime ${runtimeId} is unavailable`);
    }
    const current = () => this.active.get(s.id) === s;
    if (segment) s.replayEpoch = randomUUID();
    s.session = runtime.start({
      sessionId,
      ...(segment ? {
        transcriptId: segment.id, nativeId: segment.nativeId,
        redactSeeds: [...(segment.retiredSeedTokens ?? []), ...(segment.seedToken ? [segment.seedToken] : [])],
      } : {}),
      saveNativeId: (nativeId: string) => {
        if (!current()) return;
        if (segment) this.opts.sessionStore.updateSegment(sessionId, segment.id, { nativeId });
        else this.opts.sessionStore.writeNativeSessionId(sessionId, nativeId);
      },
      ...(runtimeId !== 'claude' ? { newTranscriptSegment: () => {
        if (!current()) throw new Error('The runtime launch was retired');
        const id = randomUUID();
        const replacement = { id, runtime: runtimeId, projectDir: runtime.transcripts.projectDirFor(cwd), seedPending: true };
        this.opts.sessionStore.appendSegment(sessionId, replacement, cwd);
        segment = replacement;
        s.seedInFlight = undefined;
        s.replayEpoch = randomUUID();
        this.broadcast(sessionId, { type: 'session_runtime_changed', runtime: runtimeId, version: s.replayEpoch });
        return { id, prepareSeed: (queuedSeed?: FirstTurnSeed) => queuedSeed && queuedSeed.token === s.seedInFlight
          ? queuedSeed : this.prepareSeed(s, replacement) };
      } } : {}),
      acceptsCallbacks: current,
      canStartTool: () => current() && s.closeReason !== 'runtime-switch' && !this.switching.has(s.id),
      launchCredential: s.launchCredential,
      mode,
      cwd,
      env,
      isAction: !!env.OUTPOST_ENVELOPE,
      ...(permissionMode ? { permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(systemPrompt ? { appendSystemPrompt: systemPrompt } : {}),
      ...(log ? { log } : {}),
    }, {
      onSeedAccepted: (token) => {
        if (!current() || !segment || token !== s.seedInFlight) return;
        s.seedInFlight = undefined;
        this.opts.sessionStore.updateSegment(sessionId, segment.id, { seedPending: false, seedAttempt: 'accepted' });
      },
      onSeedRejected: (token) => {
        if (!current() || !segment || token !== s.seedInFlight) return;
        s.seedInFlight = undefined;
        this.opts.sessionStore.updateSegment(sessionId, segment.id, { seedAttempt: 'rejected' });
      },
      onSeedUncertain: (token) => {
        if (current() && token === s.seedInFlight) s.seedInFlight = undefined;
      },
      onEvent: (e) => {
        if (!current()) return;
        if (segment && (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed')) {
          e = { ...e, item: segmentItem(e.item, sessionId, segment.id) };
        }
        s.lastActivity = Date.now();
        // Deltas are already in the native log, and they are most of a turn's frames
        if (e.type !== 'content.delta') log?.canonical(e);
        this.handleSessionStarted(s, e);
        if (e.type === 'item.completed' && e.item.type === 'assistant_message' && !e.subagent && e.item.text.trim()) {
          this.opts.onAssistantReply?.(s.id, s.lastActivity);
        }
        const evt = s.eventLog.push(e);
        const payload = JSON.stringify({ ...e, _seq: evt.seq });
        for (const ws of s.clients) ws.send(payload);
        // Fires once per id, /clear's rekey included, after the runtime has the transcript on disk
        if (e.type === 'session.started' && !e.subagent && !s.registeredIds.has(s.id)) {
          s.registeredIds.add(s.id);
          this.opts.onSessionRegistered?.(s.id);
        }
      },
      onError: (errMsg) => {
        if (!current()) return;
        // A detached session has no client to show this to, so it would otherwise vanish
        console.warn(`[session ${s.id.slice(0, 8)}] ${errMsg.trimEnd()}`);
        s.stderrTail = (s.stderrTail + errMsg).slice(-STDERR_TAIL_CHARS);
        if (isAuthFailure(errMsg)) this.opts.onAuthFailure?.(s.id, errMsg);
        for (const ws of s.clients) {
          ws.send(JSON.stringify({ type: 'daemon_error', message: errMsg }));
        }
      },
      onExit: (code) => s.finish?.(code),
    });
    s.finish = (code) => {
      if (!current()) return;
      log?.close();
      const expected = s.closeReason;
      for (const ws of s.clients) {
        ws.send(JSON.stringify(expected
          ? { type: 'daemon_proc_exit', code, expected: true, reason: expected }
          : { type: 'daemon_proc_exit', code }));
      }
      this.demoteClients(s);
      if (s.idleTimer) clearTimeout(s.idleTimer);
      this.active.delete(s.id);
      this.stopWorking(s.id);
      this.reloadWhenIdle.delete(s.id);
      markExited();
      this.opts.onSessionExit?.(s.id, code, { expected, stderrTail: s.stderrTail });
    };
    this.active.set(sessionId, s);
    this.startIdleTimer(s);
    const watching = this.watchers.get(sessionId);
    this.watchers.delete(sessionId);
    for (const ws of watching ?? []) this.attachClient(s, ws, 0);
    return s;
  }

  // /clear creates a fresh internal session id while the process keeps running. Re-key the
  // active session, tell attached clients to snap to the new id, and reset the event log
  // so reconnects to the new id don't replay pre-/clear history. The first start event
  // (where the id matches s.id) is a no-op.
  private handleSessionStarted(s: ActiveSession, e: CanonicalEvent): void {
    if (e.type !== 'session.started' || e.subagent) return;
    const newId = e.sessionId;
    if (newId === s.id) return;
    const oldId = s.id;
    this.active.delete(oldId);
    s.id = newId;
    this.active.set(newId, s);
    const workingSince = this.working.get(oldId);
    if (workingSince !== undefined) {
      this.working.delete(oldId);
      this.working.set(newId, workingSince);
    }
    if (this.reloadWhenIdle.delete(oldId)) this.reloadWhenIdle.add(newId);
    this.sessionCwds.set(newId, s.spawnCwd);
    const model = this.sessionModels.get(oldId);
    if (model) this.sessionModels.set(newId, model);
    this.opts.worktreeManager?.softArchive(oldId, newId, s.spawnCwd);
    s.eventLog = new EventLog({
      maxEvents: this.opts.eventLogMaxEvents ?? DEFAULT_EVENT_LOG_MAX_EVENTS,
      maxAgeMs: this.opts.eventLogMaxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS,
    });
    const renamedPayload = JSON.stringify({ type: 'daemon_session_renamed', oldId, newId });
    for (const ws of s.clients) ws.send(renamedPayload);
  }

  private startIdleTimer(s: ActiveSession): void {
    s.idleTimer = setTimeout(() => {
      // Never reap a session that's still mid-turn. A long subagent run keeps the
      // parent proc's stdout quiet — subagent activity surfaces via the PreToolUse
      // hook, which doesn't refresh lastActivity — so lastActivity goes stale while
      // real work continues. Reap only once the turn has ended (Stop hook →
      // markTurnEnded clears `working`).
      const since = Date.now() - s.lastActivity;
      if (since < IDLE_TIMEOUT_MS || this.working.has(s.id) || this.opts.hasPendingApproval?.(s.id)) {
        this.startIdleTimer(s);
        return;
      }
      void this.close(s.id, 'idle');
    }, IDLE_TIMEOUT_MS);
  }

  private startWorking(sessionId: string): void {
    if (this.working.has(sessionId)) return;
    this.working.set(sessionId, Date.now());
    this.opts.onWorkingChange?.(sessionId, true);
  }

  private stopWorking(sessionId: string): void {
    if (this.working.delete(sessionId)) this.opts.onWorkingChange?.(sessionId, false);
  }
}
