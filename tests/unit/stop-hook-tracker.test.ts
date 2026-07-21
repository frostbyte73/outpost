import { describe, it, expect } from 'vitest';
import { StopHookTracker } from '../../src/storage/stop-hook-tracker.js';

describe('StopHookTracker', () => {
  it('shouldNotify=false when there is no recorded turn start', () => {
    const t = new StopHookTracker({ thresholdMs: 30_000, now: () => 1000 });
    expect(t.consume('session-x')).toEqual({ shouldNotify: false, turnDurationMs: null });
  });

  it('shouldNotify=true when turn duration >= threshold', () => {
    let clock = 0;
    const t = new StopHookTracker({ thresholdMs: 30_000, now: () => clock });
    t.recordTurnStart('s1');
    clock = 31_000;
    expect(t.consume('s1')).toEqual({ shouldNotify: true, turnDurationMs: 31_000 });
  });

  it('shouldNotify=false when turn duration < threshold', () => {
    let clock = 0;
    const t = new StopHookTracker({ thresholdMs: 30_000, now: () => clock });
    t.recordTurnStart('s1');
    clock = 5_000;
    expect(t.consume('s1')).toEqual({ shouldNotify: false, turnDurationMs: 5_000 });
  });

  it('consume() clears the recorded start (next consume returns null)', () => {
    let clock = 0;
    const t = new StopHookTracker({ thresholdMs: 30_000, now: () => clock });
    t.recordTurnStart('s1');
    clock = 31_000;
    t.consume('s1');
    expect(t.consume('s1')).toEqual({ shouldNotify: false, turnDurationMs: null });
  });

  it('tracks turns per session independently', () => {
    let clock = 0;
    const t = new StopHookTracker({ thresholdMs: 30_000, now: () => clock });
    t.recordTurnStart('s1');
    clock = 100;
    t.recordTurnStart('s2');
    clock = 60_000;
    expect(t.consume('s2').turnDurationMs).toBe(59_900);
    expect(t.consume('s1').turnDurationMs).toBe(60_000);
  });

  it('recordTurnStart twice overwrites the first (latest message wins)', () => {
    let clock = 0;
    const t = new StopHookTracker({ thresholdMs: 30_000, now: () => clock });
    t.recordTurnStart('s1');
    clock = 5_000;
    t.recordTurnStart('s1');
    clock = 10_000;
    expect(t.consume('s1')).toEqual({ shouldNotify: false, turnDurationMs: 5_000 });
  });
});
