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

export type HeadroomCode = 'no-data' | 'five-hour-ceiling' | 'ahead-of-pace' | 'over-budget' | 'ok';

export interface HeadroomDecision {
  launch: boolean;
  reason: string;
  code: HeadroomCode;
}

// Coarse duration label for the status strings the schedules UI shows ("3d to reset",
// "next in 22h"). Shared with token-scheduler.ts's debounce reason.
export function humanizeMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// The checks both rules share, in order: data present, the 5h ceiling, a 7d window not yet past
// its reset. Returns the blocking decision, or what the 7d rule needs to decide.
function sevenDayWindow(snapshot: TokenUsageSnapshot | undefined, now: number):
  HeadroomDecision | { seven: TokenWindowUsage; msUntilReset: number } {
  const seven = snapshot?.seven_day;
  const five = snapshot?.five_hour;
  if (!seven || !five || !Number.isFinite(seven.resets_at) || seven.resets_at <= 0) {
    return { launch: false, reason: 'Waiting — no usage data yet', code: 'no-data' };
  }
  if (five.used_percentage >= FIVE_HOUR_CEILING) {
    return { launch: false, reason: `Waiting — 5h usage at ${Math.round(five.used_percentage)}%`, code: 'five-hour-ceiling' };
  }
  const msUntilReset = seven.resets_at * 1000 - now;
  if (msUntilReset <= 0) return { launch: false, reason: 'Waiting — awaiting usage refresh', code: 'no-data' };
  return { seven, msUntilReset };
}

// Routines' rule (token-opportunistic schedules): spend only budget the week is behind pace on.
// Fails closed: any missing/stale signal yields `launch: false`. Never launches on partial data.
export function evaluateHeadroom(snapshot: TokenUsageSnapshot | undefined, now: number): HeadroomDecision {
  const w = sevenDayWindow(snapshot, now);
  if ('code' in w) return w;
  const { seven, msUntilReset } = w;

  const elapsedFrac = Math.min(1, Math.max(0, (SEVEN_DAY_MS - msUntilReset) / SEVEN_DAY_MS));
  const usedFrac = Math.min(1, Math.max(0, seven.used_percentage / 100));
  const headroom = elapsedFrac - usedFrac;
  const used = Math.round(seven.used_percentage);
  const until = humanizeMs(msUntilReset);
  if (headroom < PACE_MARGIN) {
    return { launch: false, reason: `Waiting — 7d usage ahead of pace (${used}% used, ${until} to reset)`, code: 'ahead-of-pace' };
  }
  return { launch: true, reason: `Headroom — 7d at ${used}% used, ${until} to reset`, code: 'ok' };
}

// Jobs' rule: the user asked for this work, so hold it back only when the week is on course to run
// out. The pace rule above is the wrong question for that — its margin alone held every job for
// the first 8.4h of each window, which is how "1% used" read as ahead of pace. This projects the
// window's own average rate over what's left of it, so jobs' spend counts against them and the
// gate closes before the cap rather than at it. The rate is averaged over at least a day: a window
// a few hours old has seen one session, and 5% in its first two hours is not a 420% week.
const JOB_BUDGET_TARGET = 90;
const MIN_RATE_SPAN_MS = 24 * 60 * 60 * 1000;

export function evaluateJobBudget(snapshot: TokenUsageSnapshot | undefined, now: number): HeadroomDecision {
  const w = sevenDayWindow(snapshot, now);
  if ('code' in w) return w;
  const { seven, msUntilReset } = w;
  const elapsedMs = Math.max(0, SEVEN_DAY_MS - msUntilReset);
  const projected = seven.used_percentage
    + (seven.used_percentage / Math.max(elapsedMs, MIN_RATE_SPAN_MS)) * msUntilReset;
  const used = Math.round(seven.used_percentage);
  const until = humanizeMs(msUntilReset);
  if (projected >= JOB_BUDGET_TARGET) {
    return { launch: false, reason: `Waiting — 7d on course for ${Math.round(projected)}% by reset (${used}% used, ${until} left)`, code: 'over-budget' };
  }
  return { launch: true, reason: `Budget — 7d on course for ${Math.round(projected)}% by reset`, code: 'ok' };
}

const OPENING_STEP_MS = 15 * 60_000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// When `evaluate` first lets a launch through if nothing more is spent: steps forward in 15m
// increments, emptying the 5h window as it passes its reset, up to the 7d reset — which always
// opens it. Null without the data to say. "If nothing more is spent" is the honest bound: it is
// the earliest the gate can open, and any spend before then only pushes it later.
export function nextOpening(
  evaluate: (s: TokenUsageSnapshot | undefined, now: number) => HeadroomDecision,
  snapshot: TokenUsageSnapshot | undefined,
  now: number,
): number | null {
  const seven = snapshot?.seven_day;
  if (!seven || !snapshot?.five_hour) return null;
  const sevenReset = seven.resets_at * 1000;
  for (let t = now + OPENING_STEP_MS; t < sevenReset; t += OPENING_STEP_MS) {
    let five = snapshot.five_hour;
    while (t >= five.resets_at * 1000) five = { used_percentage: 0, resets_at: five.resets_at + FIVE_HOUR_MS / 1000 };
    if (evaluate({ ...snapshot, five_hour: five }, t).launch) return t;
  }
  return sevenReset > now ? sevenReset : null;
}
