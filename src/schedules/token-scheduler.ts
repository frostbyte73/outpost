import type { SchedulesStore } from './schedules-store.js';
import type { ScheduleRecord } from './types.js';

// Minimal shape of the account usage snapshot this controller needs — mirrors
// `AccountUsageSnapshot` (src/integrations/usage-poller.ts) without importing it, keeping
// src/schedules/ dependency-free. `resets_at` is unix epoch *seconds* (claude's convention).
export interface TokenWindowUsage {
  used_percentage: number;
  resets_at: number;
}
export interface TokenUsageSnapshot {
  five_hour?: TokenWindowUsage;
  seven_day?: TokenWindowUsage;
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// How far behind pace the 7d window must be before we spend on backlog. `headroom` is
// (fraction of window elapsed − fraction of budget used); a positive value means we've used
// proportionally less budget than time. The margin keeps us conservative early in a window
// (elapsed≈0, used≈0 → headroom≈0 → wait) while the pace signal itself grows more permissive
// as the window drains, so near a reset with budget to spare it launches aggressively.
const PACE_MARGIN = 0.05;
// Hard ceiling on the short window: never launch into a nearly-spent 5h bucket, so a burst of
// backlog jobs can't blow the short limit even when the 7d window looks healthy.
const FIVE_HOUR_CEILING = 80;

export interface HeadroomDecision {
  launch: boolean;
  reason: string;
}

function humanizeMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// Fails closed: any missing/stale signal yields `launch: false`. Never launches on partial data.
export function evaluateHeadroom(snapshot: TokenUsageSnapshot | undefined, now: number): HeadroomDecision {
  const seven = snapshot?.seven_day;
  const five = snapshot?.five_hour;
  if (!seven || !five || !Number.isFinite(seven.resets_at) || seven.resets_at <= 0) {
    return { launch: false, reason: 'Waiting — no usage data yet' };
  }
  if (five.used_percentage >= FIVE_HOUR_CEILING) {
    return { launch: false, reason: `Waiting — 5h usage at ${Math.round(five.used_percentage)}%` };
  }
  const msUntilReset = seven.resets_at * 1000 - now;
  if (msUntilReset <= 0) return { launch: false, reason: 'Waiting — awaiting usage refresh' };

  const elapsedFrac = Math.min(1, Math.max(0, (SEVEN_DAY_MS - msUntilReset) / SEVEN_DAY_MS));
  const usedFrac = Math.min(1, Math.max(0, seven.used_percentage / 100));
  const headroom = elapsedFrac - usedFrac;
  const used = Math.round(seven.used_percentage);
  const until = humanizeMs(msUntilReset);
  if (headroom < PACE_MARGIN) {
    return { launch: false, reason: `Waiting — 7d usage ahead of pace (${used}% used, ${until} to reset)` };
  }
  return { launch: true, reason: `Headroom — 7d at ${used}% used, ${until} to reset` };
}

export interface TokenSchedulerDeps {
  store: SchedulesStore;
  getSnapshot: () => TokenUsageSnapshot | undefined;
  // Launches one token schedule. Wired to `Scheduler.fireTokenOpportunistic` in the daemon; the
  // fired run stays `running` until its job/session completes, which is what serializes launches.
  fire: (scheduleId: string) => Promise<unknown>;
  now?: () => number;
}

export type TokenStatus = { state: 'running' | 'eligible' | 'waiting'; reason: string };

// Watches account usage and launches token-opportunistic schedules when there's spare capacity,
// serializing so at most one token-launched job runs at a time. Driven entirely by the daemon's
// usage-snapshot stream — it has no timer of its own.
export class TokenScheduler {
  private evaluating = false;

  constructor(private readonly deps: TokenSchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private tokenSchedules(): ScheduleRecord[] {
    return this.deps.store.list().filter((s) => s.enabled && s.trigger.kind === 'token-opportunistic');
  }

  // True while any token schedule (enabled or not) has a run still in flight — the serialization
  // gate. Includes disabled ones so pausing a schedule mid-run doesn't unblock a second launch.
  private anyInFlight(): boolean {
    return this.deps.store.list()
      .filter((s) => s.trigger.kind === 'token-opportunistic')
      .some((s) => this.deps.store.lastRun(s.id)?.outcome === 'running');
  }

  // Called for each account-usage snapshot. Fire-and-forget from the daemon; the `evaluating`
  // latch drops overlapping snapshots so a slow guard (getRepoLastChange shells out) can't let a
  // second snapshot double-launch before the first fire has written its `running` run row.
  async onUsageSnapshot(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try { await this.evaluate(); }
    finally { this.evaluating = false; }
  }

  private async evaluate(): Promise<void> {
    const schedules = this.tokenSchedules();
    if (schedules.length === 0) return;
    if (this.anyInFlight()) return;
    if (!evaluateHeadroom(this.deps.getSnapshot(), this.now()).launch) return;
    const target = this.pickNext(schedules);
    if (target) await this.deps.fire(target.id);
  }

  // Least-recently-run first (never-run wins) so multiple token schedules share launches fairly
  // rather than one starving the others.
  private pickNext(schedules: ScheduleRecord[]): ScheduleRecord | undefined {
    return [...schedules].sort((a, b) => {
      const la = this.deps.store.lastRun(a.id)?.startedAt ?? 0;
      const lb = this.deps.store.lastRun(b.id)?.startedAt ?? 0;
      return la - lb;
    })[0];
  }

  // UI status for GET /api/schedules. `eligible` means headroom exists and nothing's in flight —
  // the next snapshot would launch it; `waiting` covers both the serialization gate and no-headroom.
  describe(scheduleId: string): TokenStatus {
    if (this.deps.store.lastRun(scheduleId)?.outcome === 'running') return { state: 'running', reason: 'Running now' };
    if (this.anyInFlight()) return { state: 'waiting', reason: 'Waiting — another token job is running' };
    const decision = evaluateHeadroom(this.deps.getSnapshot(), this.now());
    return { state: decision.launch ? 'eligible' : 'waiting', reason: decision.reason };
  }
}
