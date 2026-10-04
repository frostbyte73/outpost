import { describe, it, expect } from 'vitest';
import { evaluateHeadroom, evaluateJobBudget, nextOpening, type TokenUsageSnapshot } from '../../src/schedules/headroom.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function snap(sevenUsed: number, msUntilReset: number, fiveUsed = 10): TokenUsageSnapshot {
  return {
    five_hour: { used_percentage: fiveUsed, resets_at: Math.floor((NOW + 5 * 60 * 60 * 1000) / 1000) },
    seven_day: { used_percentage: sevenUsed, resets_at: Math.floor((NOW + msUntilReset) / 1000) },
  };
}

describe('evaluateHeadroom codes', () => {
  it('no-data when the snapshot is missing', () => {
    const decision = evaluateHeadroom(undefined, NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('no-data');
  });

  it('no-data when the 7d reset is already in the past (stale snapshot)', () => {
    const decision = evaluateHeadroom(snap(30, -DAY), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('no-data');
  });

  it('five-hour-ceiling when the 5h window is at/over the ceiling', () => {
    const decision = evaluateHeadroom(snap(40, 3 * 60 * 60 * 1000, 80), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('five-hour-ceiling');
  });

  it('ahead-of-pace when 7d spending is ahead of the elapsed fraction', () => {
    const decision = evaluateHeadroom(snap(60, 5 * DAY), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('ahead-of-pace');
  });

  it('ok when there is headroom to launch', () => {
    const decision = evaluateHeadroom(snap(40, 3 * 60 * 60 * 1000), NOW);
    expect(decision.launch).toBe(true);
    expect(decision.code).toBe('ok');
  });
});

// Jobs' rule: hold work only when the week is on course to run out.
describe('evaluateJobBudget', () => {
  const HOUR = 60 * 60 * 1000;

  it('lets jobs run early in a window that the pace rule still holds (the 1%-used case)', () => {
    const s = snap(1, 7 * DAY - 6 * HOUR);
    expect(evaluateHeadroom(s, NOW).launch).toBe(false);
    expect(evaluateJobBudget(s, NOW)).toMatchObject({ launch: true, code: 'ok' });
  });

  it('holds jobs when the window\'s average rate would cross 90% by reset', () => {
    // 60% in 3 days → 20%/day, 4 days left → ~140%.
    const d = evaluateJobBudget(snap(60, 4 * DAY), NOW);
    expect(d).toMatchObject({ launch: false, code: 'over-budget' });
    expect(d.reason).toContain('on course for 140%');
  });

  it('averages over at least a day, so an early burst is not projected as a runaway week', () => {
    // 5% in the first 2h would be 420% if projected raw; floored at 24h it is ~39%.
    expect(evaluateJobBudget(snap(5, 7 * DAY - 2 * HOUR), NOW).launch).toBe(true);
  });

  it('keeps the shared 5h ceiling and no-data checks', () => {
    expect(evaluateJobBudget(snap(1, 6 * DAY, 85), NOW).code).toBe('five-hour-ceiling');
    expect(evaluateJobBudget(undefined, NOW).code).toBe('no-data');
  });
});

describe('nextOpening', () => {
  const HOUR = 60 * 60 * 1000;

  it('finds when the pace rule opens if nothing more is spent', () => {
    // 1% used, 6h into the week: opens once elapsed ≥ 6% (~10.1h in), so ~4h from now.
    const at = nextOpening(evaluateHeadroom, snap(1, 7 * DAY - 6 * HOUR), NOW)!;
    expect(at - NOW).toBeGreaterThanOrEqual(4 * HOUR);
    expect(at - NOW).toBeLessThanOrEqual(4.5 * HOUR);
  });

  it('returns the first step the rule passes, and the step before it does not', () => {
    const s = snap(60, 4 * DAY);
    const at = nextOpening(evaluateJobBudget, s, NOW)!;
    expect(at).toBeGreaterThan(NOW);
    const fiveAt = (t: number) => ({ ...s, five_hour: { used_percentage: 0, resets_at: Math.floor((t + HOUR) / 1000) } });
    expect(evaluateJobBudget(fiveAt(at), at).launch).toBe(true);
    expect(evaluateJobBudget(fiveAt(at - 15 * 60_000), at - 15 * 60_000).launch).toBe(false);
  });

  it('waits out a hot 5h window by emptying it at its reset', () => {
    const at = nextOpening(evaluateJobBudget, snap(1, 6 * DAY, 95), NOW)!;
    expect(at).toBeGreaterThanOrEqual(NOW + 5 * HOUR);
    expect(at).toBeLessThanOrEqual(NOW + 5 * HOUR + 15 * 60_000);
  });

  it('is null without data', () => {
    expect(nextOpening(evaluateJobBudget, undefined, NOW)).toBeNull();
  });
});
