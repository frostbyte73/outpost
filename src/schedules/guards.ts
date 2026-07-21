import type { Guard, ScheduleRecord } from './types.js';
import { whatCwd } from './types.js';

// Minimal shape of what a guard needs from the account usage snapshot — matches
// `UsagePoller`'s `AccountUsageSnapshot` (src/integrations/usage-poller.ts) without importing
// it, keeping src/schedules/ dependency-free for standalone testing/wiring.
export interface UsageSnapshotLike {
  five_hour?: { used_percentage: number };
  seven_day?: { used_percentage: number };
}

export interface GuardProviders {
  getUsageSnapshot: () => UsageSnapshotLike | undefined;
  // repo defaults to the guard's own `repo`, then the schedule's working dir (skill repo or cwd).
  // Returns epoch ms of the most recent change (commit or working-tree dirty timestamp),
  // or null if unknown/unavailable.
  getRepoLastChange: (repo: string | undefined) => Promise<number | null> | number | null;
}

export interface GuardContext {
  schedule: ScheduleRecord;
  // startedAt of the schedule's most recent non-skipped run; undefined on first run.
  lastRunAt?: number;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

async function evaluateOne(guard: Guard, ctx: GuardContext, providers: GuardProviders): Promise<GuardResult> {
  if (guard.kind === 'usage-threshold') {
    const snapshot = providers.getUsageSnapshot();
    const pct = guard.window === '5h' ? snapshot?.five_hour?.used_percentage : snapshot?.seven_day?.used_percentage;
    if (pct === undefined) return { ok: true }; // no data — fail open rather than block forever
    const triggered = guard.op === '>' ? pct > guard.value : pct >= guard.value;
    if (!triggered) return { ok: true };
    return { ok: false, reason: `Skipped — ${guard.window} usage was at ${pct}%` };
  }

  // 'no-repo-changes'
  const repo = guard.repo ?? whatCwd(ctx.schedule.what);
  if (!ctx.lastRunAt) return { ok: true }; // nothing to compare against on a first run
  const lastChange = await providers.getRepoLastChange(repo);
  if (lastChange === null) return { ok: true }; // unknown — fail open
  if (lastChange > ctx.lastRunAt) return { ok: true }; // changed since last run
  return {
    ok: false,
    reason: repo ? `Skipped — no changes in ${repo} since last run` : 'Skipped — no repo changes since last run',
  };
}

// Evaluates guards in order, short-circuiting on the first failure (matches the UI showing a
// single skip reason per run).
export async function evaluateGuards(guards: Guard[], ctx: GuardContext, providers: GuardProviders): Promise<GuardResult> {
  for (const guard of guards) {
    const result = await evaluateOne(guard, ctx, providers);
    if (!result.ok) return result;
  }
  return { ok: true };
}
