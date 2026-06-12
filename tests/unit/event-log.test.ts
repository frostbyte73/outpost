import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventLog } from '../../src/event-log.js';

describe('EventLog', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('starts empty: latestSeq=0, earliestSeq=1 (next-to-be-assigned)', () => {
    const log = new EventLog({ maxEvents: 100, maxAgeMs: 60_000 });
    expect(log.latestSeq()).toBe(0);
    expect(log.earliestSeq()).toBe(1);
    expect(log.replayFrom(0)).toEqual([]);
  });

  it('push assigns monotonically increasing seq starting at 1', () => {
    const log = new EventLog({ maxEvents: 100, maxAgeMs: 60_000 });
    const a = log.push({ kind: 'a' });
    const b = log.push({ kind: 'b' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.latestSeq()).toBe(2);
    expect(log.earliestSeq()).toBe(1);
  });

  it('replayFrom is exclusive of `since` and returns events in order', () => {
    const log = new EventLog({ maxEvents: 100, maxAgeMs: 60_000 });
    log.push({ kind: 'a' });
    log.push({ kind: 'b' });
    log.push({ kind: 'c' });
    const out = log.replayFrom(1);
    expect(out.map((e) => e.seq)).toEqual([2, 3]);
    expect(out.map((e) => (e.message as { kind: string }).kind)).toEqual(['b', 'c']);
  });

  it('replayFrom(0) returns everything still in the buffer', () => {
    const log = new EventLog({ maxEvents: 100, maxAgeMs: 60_000 });
    log.push({ kind: 'a' });
    log.push({ kind: 'b' });
    expect(log.replayFrom(0).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('gc by count: drops oldest when buffer exceeds maxEvents', () => {
    const log = new EventLog({ maxEvents: 3, maxAgeMs: 60_000 });
    log.push({ i: 1 });
    log.push({ i: 2 });
    log.push({ i: 3 });
    log.push({ i: 4 });
    expect(log.earliestSeq()).toBe(2);
    expect(log.latestSeq()).toBe(4);
    expect(log.replayFrom(0).map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('gc by age: drops events older than maxAgeMs (boundary kept)', () => {
    const log = new EventLog({ maxEvents: 100, maxAgeMs: 1000 });
    log.push({ i: 1 });               // at t=1_000_000
    vi.setSystemTime(1_000_500);
    log.push({ i: 2 });               // at t=1_000_500
    vi.setSystemTime(1_001_500);
    log.push({ i: 3 });               // pushed at t=1_001_500, cutoff=t-1000=1_000_500
    // #1 is at 1_000_000 < 1_000_500 → dropped. #2 is at 1_000_500, NOT less-than cutoff → kept.
    expect(log.replayFrom(0).map((e) => (e.message as { i: number }).i)).toEqual([2, 3]);
    expect(log.earliestSeq()).toBe(2);
  });

  it('earliestSeq after full eviction returns next-to-be-assigned', () => {
    const log = new EventLog({ maxEvents: 100, maxAgeMs: 100 });
    log.push({ i: 1 });
    vi.setSystemTime(2_000_000);
    log.push({ i: 2 });
    expect(log.earliestSeq()).toBe(2);
    vi.setSystemTime(4_000_000);
    log.push({ i: 3 });
    expect(log.earliestSeq()).toBe(3);
  });
});
