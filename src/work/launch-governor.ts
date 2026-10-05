import { evaluateJobBudget, nextOpening, type TokenUsageSnapshot } from '../schedules/headroom.js';

// `user` is an explicit click (Launch orchestrator, replan, redraft) and always fires. `immediate`
// (a high-priority job, a reactive round like fix-ci) skips the budget and the slot cap but not a
// pause — pausing means "start nothing on your own", and those are still the daemon's own starts.
// `queued` waits on all three.
export type LaunchPriority = 'queued' | 'immediate' | 'user';

export interface LaunchRequest {
  key: string;
  jobId: string;
  stepId?: string;
  sessionId: string;
  priority: LaunchPriority;
  enqueuedAt: number;
  jobInProgress: boolean;
  label?: string;
  // Performs the actual spawn/send. Returns true if it started a turn (so the occupied slot
  // will be released by that turn's Stop hook), or false if it bailed without starting one
  // (step cancelled/invalidated while parked) — on false the governor frees the slot itself,
  // since no Stop will ever fire to release it.
  run: () => boolean;
}

export interface LaunchGovernorDeps {
  // The user's pause (Settings-free, from the usage meter). Read through deps rather than held
  // here so it persists in preferences.json and survives a daemon restart.
  isPaused?: () => boolean;
  setPaused?: (paused: boolean) => void;
  getSnapshot: () => TokenUsageSnapshot | undefined;
  getConcurrency: () => number;
  now?: () => number;
  onChange?: () => void;
}

// The queue as one app-wide fact, for the PWA's usage meter: per-job labels were the only place a
// pause ever showed, so a queue holding six jobs read as six unrelated quirks. `opensAt` is the
// earliest the budget gate lets work through if nothing more is spent (null while the hold is
// slots, which free on a turn end rather than on a clock).
export interface LaunchQueueSummary {
  paused: boolean;
  parked: number;
  // Turns holding a slot right now, and the configured cap. `active` can exceed `slots`: a user
  // launch and an `immediate` take a slot without waiting for one.
  active: number;
  slots: number;
  reason: string | null;
  opensAt: number | null;
  // Which usage window the budget gate is closed on, whether or not anything is parked behind it —
  // the meter tints that window's bar. Still reported while the user ignores it, so the popover
  // can say what is being ignored.
  blocker: UsageWindow | null;
  // Until when (epoch ms) the user told the queue to launch past the budget gate. Null when not.
  ignoreBudgetUntil: number | null;
}

export type UsageWindow = 'five_hour' | 'seven_day';
const BLOCKER: Partial<Record<string, UsageWindow>> = { 'five-hour-ceiling': 'five_hour', 'over-budget': 'seven_day' };

export type LaunchState =
  | { state: 'running' }
  | { state: 'queued'; reason: string }
  | { state: 'idle' };

export class LaunchGovernor {
  private parked = new Map<string, LaunchRequest>();
  private active = new Map<string, string>();
  private evaluating = false;
  // In memory on purpose: an override is an hour long, and a daemon bounce re-closing the gate
  // early is the safe side to err on.
  private ignoreBudgetUntil = 0;
  private ignoreTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: LaunchGovernorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private budget(): { ok: boolean; reason: string; blocker: UsageWindow | null } {
    const snap = this.deps.getSnapshot();
    if (!snap) return { ok: true, reason: 'No usage data — headroom gate off', blocker: null };
    const d = evaluateJobBudget(snap, this.now());
    return { ok: d.launch || d.code === 'no-data', reason: d.reason, blocker: d.launch ? null : BLOCKER[d.code] ?? null };
  }

  private ignoringBudget(): boolean {
    return this.now() < this.ignoreBudgetUntil;
  }

  private headroom(): { ok: boolean; reason: string } {
    const b = this.budget();
    return b.ok || !this.ignoringBudget() ? b : { ok: true, reason: 'Usage limit ignored' };
  }

  private slotOk(): boolean {
    return this.active.size < this.deps.getConcurrency();
  }

  private paused(): boolean {
    return this.deps.isPaused?.() ?? false;
  }

  private canLaunch(req: LaunchRequest): boolean {
    if (req.priority === 'user') return true;
    if (this.paused()) return false;
    return req.priority === 'immediate' || (this.headroom().ok && this.slotOk());
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused()) return;
    this.deps.setPaused?.(paused);
    this.emit();
    if (!paused) this.drain();
  }

  // The meter's "Ignore for 1h": the budget gate stays open until `ms` from now; 0 restores it.
  // Slots and a pause still hold — this is about usage only.
  ignoreBudget(ms: number): void {
    clearTimeout(this.ignoreTimer);
    this.ignoreBudgetUntil = ms > 0 ? this.now() + ms : 0;
    // Expiry re-closes the gate, which fires nothing, so only the meter needs telling.
    if (ms > 0) {
      this.ignoreTimer = setTimeout(() => this.emit(), ms);
      this.ignoreTimer.unref?.();
    }
    this.emit();
    if (ms > 0) this.drain();
  }

  private fire(req: LaunchRequest): void {
    this.parked.delete(req.key);
    // Occupy the slot before run() so a re-entrant gate check sees it taken.
    this.active.set(req.sessionId, req.key);
    let started = false;
    try {
      started = req.run();
    } catch (err) {
      this.active.delete(req.sessionId);
      throw err;
    }
    // A run that bailed without starting a turn (or threw) never triggers a Stop hook, so
    // turnEnded would never fire to free this slot — release it now or it leaks forever.
    if (!started) this.active.delete(req.sessionId);
    this.emit();
  }

  submit(req: LaunchRequest): void {
    if (this.canLaunch(req)) {
      this.fire(req);
    } else {
      this.parked.set(req.key, req);
      this.emit();
    }
  }

  turnEnded(sessionId: string): void {
    this.active.delete(sessionId);
    this.emit();
    this.drain();
  }

  onUsageSnapshot(): void {
    this.drain();
    // Still holding work: the reason and the opening estimate moved with the usage, even though
    // nothing fired to emit for it.
    if (this.parked.size > 0) this.emit();
  }

  summary(): LaunchQueueSummary {
    const paused = this.paused();
    const occupancy = {
      active: this.active.size,
      slots: this.deps.getConcurrency(),
      blocker: this.budget().blocker,
      ignoreBudgetUntil: this.ignoringBudget() ? this.ignoreBudgetUntil : null,
    };
    if (this.parked.size === 0) return { paused, parked: 0, reason: null, opensAt: null, ...occupancy };
    const slotsBusy = !this.slotOk();
    const snap = this.deps.getSnapshot();
    return {
      paused,
      ...occupancy,
      parked: this.parked.size,
      reason: this.queuedReason(),
      // A pause has no clock to open on, and neither do busy slots (they free on a turn end).
      opensAt: paused || slotsBusy || this.headroom().ok ? null : nextOpening(evaluateJobBudget, snap, this.now()),
    };
  }

  // Everything parked, now — the meter's "Run all". Snapshots first: fire() mutates the map.
  forceFireAll(): number {
    const all = [...this.parked.values()];
    for (const req of all) this.fire(req);
    return all.length;
  }

  forceFire(key: string): boolean {
    const req = this.parked.get(key);
    if (!req) return false;
    this.fire(req);
    return true;
  }

  // Force-fires every parked launch belonging to a job (used when a job is marked
  // high-priority). Returns how many fired. Snapshots the matches first — fire()
  // mutates the parked map.
  forceFireJob(jobId: string): number {
    const matches = [...this.parked.values()].filter((r) => r.jobId === jobId);
    for (const req of matches) this.fire(req);
    return matches.length;
  }

  cancel(jobId: string): void {
    let removed = false;
    for (const [key, req] of this.parked) {
      if (req.jobId === jobId) {
        this.parked.delete(key);
        removed = true;
      }
    }
    if (removed) this.emit();
  }

  // Drops every parked launch scoped to one step — its own resume-round launch
  // (`${jobId}#${stepId}`) and any dispatch children keyed `${jobId}#${stepId}#${dispatchId}`
  // — without touching the job's other steps. `cancel(jobId)` is job-wide (abandon/delete/
  // reset); a step-level settle (mark-resolved, or the step resolving/failing) needs this
  // narrower scope.
  cancelStep(jobId: string, stepId: string): void {
    const scope = `${jobId}#${stepId}`;
    let removed = false;
    for (const key of this.parked.keys()) {
      if (key === scope || key.startsWith(`${scope}#`)) {
        this.parked.delete(key);
        removed = true;
      }
    }
    if (removed) this.emit();
  }

  describe(key: string): LaunchState {
    for (const activeKey of this.active.values()) {
      if (activeKey === key) return { state: 'running' };
    }
    if (this.parked.has(key)) return { state: 'queued', reason: this.queuedReason() };
    return { state: 'idle' };
  }

  // Bare reason — the "Queued — " prefix is added once by the PWA (vm/tracked.js).
  private queuedReason(): string {
    if (this.paused()) return 'Job queue paused';
    if (!this.slotOk()) return `${this.active.size}/${this.deps.getConcurrency()} slots busy`;
    return this.headroom().reason;
  }

  private drain(): void {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      // Whatever may go now, in order: an `immediate` held only by a pause goes first and past
      // the budget, then in-progress jobs before new ones, then FIFO.
      for (;;) {
        const next = [...this.parked.values()].filter((r) => this.canLaunch(r)).sort(
          (a, b) => (a.priority === 'immediate' ? 0 : 1) - (b.priority === 'immediate' ? 0 : 1)
            || (b.jobInProgress ? 1 : 0) - (a.jobInProgress ? 1 : 0) || a.enqueuedAt - b.enqueuedAt,
        )[0];
        if (!next) break;
        this.fire(next);
      }
    } finally {
      this.evaluating = false;
    }
  }

  private emit(): void {
    this.deps.onChange?.();
  }
}
