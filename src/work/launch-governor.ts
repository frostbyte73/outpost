import { evaluateJobBudget, nextOpening, type TokenUsageSnapshot } from '../schedules/headroom.js';

export type LaunchPriority = 'queued' | 'immediate';

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
  parked: number;
  reason: string | null;
  opensAt: number | null;
}

export type LaunchState =
  | { state: 'running' }
  | { state: 'queued'; reason: string }
  | { state: 'idle' };

export class LaunchGovernor {
  private parked = new Map<string, LaunchRequest>();
  private active = new Map<string, string>();
  private evaluating = false;

  constructor(private deps: LaunchGovernorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private headroom(): { ok: boolean; reason: string } {
    const snap = this.deps.getSnapshot();
    if (!snap) return { ok: true, reason: 'No usage data — headroom gate off' };
    const d = evaluateJobBudget(snap, this.now());
    return { ok: d.launch || d.code === 'no-data', reason: d.reason };
  }

  private slotOk(): boolean {
    return this.active.size < this.deps.getConcurrency();
  }

  private canLaunchQueued(): boolean {
    return this.headroom().ok && this.slotOk();
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
    if (req.priority === 'immediate') {
      this.parked.delete(req.key);
      this.fire(req);
      return;
    }
    if (this.canLaunchQueued()) {
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
    if (this.parked.size === 0) return { parked: 0, reason: null, opensAt: null };
    const slotsBusy = !this.slotOk();
    const snap = this.deps.getSnapshot();
    return {
      parked: this.parked.size,
      reason: this.queuedReason(),
      opensAt: slotsBusy || this.headroom().ok ? null : nextOpening(evaluateJobBudget, snap, this.now()),
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
    if (!this.slotOk()) return `${this.active.size}/${this.deps.getConcurrency()} slots busy`;
    return this.headroom().reason;
  }

  private drain(): void {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      while (this.parked.size > 0 && this.canLaunchQueued()) {
        const [next] = [...this.parked.values()].sort(
          (a, b) => (b.jobInProgress ? 1 : 0) - (a.jobInProgress ? 1 : 0) || a.enqueuedAt - b.enqueuedAt,
        );
        this.fire(next!); // guarded by parked.size > 0 above
      }
    } finally {
      this.evaluating = false;
    }
  }

  private emit(): void {
    this.deps.onChange?.();
  }
}
