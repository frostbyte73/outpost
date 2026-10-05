import { describe, it, expect } from 'vitest';
import { LaunchGovernor, type LaunchRequest } from '../../src/work/launch-governor.js';
import { evaluateHeadroom, type TokenUsageSnapshot } from '../../src/schedules/headroom.js';

const NOW = 1_700_000_000_000;
const NOW_S = NOW / 1000;

const healthy: TokenUsageSnapshot = {
  five_hour: { used_percentage: 10, resets_at: NOW_S + 3600 },
  seven_day: { used_percentage: 10, resets_at: NOW_S + 3 * 86400 },
};
const hot5h: TokenUsageSnapshot = {
  five_hour: { used_percentage: 95, resets_at: NOW_S + 3600 },
  seven_day: { used_percentage: 10, resets_at: NOW_S + 3 * 86400 },
};

function req(partial: Partial<LaunchRequest> & { key: string; sessionId: string }): LaunchRequest {
  return {
    jobId: 'j1',
    priority: 'queued',
    enqueuedAt: 0,
    jobInProgress: false,
    run: () => true,
    ...partial,
  };
}

function harness(initialSnapshot: TokenUsageSnapshot | undefined = healthy, initialConcurrency = 1) {
  let snapshot: TokenUsageSnapshot | undefined = initialSnapshot;
  let concurrency = initialConcurrency;
  const fired: string[] = [];
  let changes = 0;
  const gov = new LaunchGovernor({
    getSnapshot: () => snapshot,
    getConcurrency: () => concurrency,
    now: () => NOW,
    onChange: () => { changes++; },
  });
  return {
    gov,
    fired,
    setSnapshot: (s: TokenUsageSnapshot | undefined) => { snapshot = s; },
    setConcurrency: (c: number) => { concurrency = c; },
    changeCount: () => changes,
    makeReq: (partial: Partial<LaunchRequest> & { key: string; sessionId: string }) =>
      req({ ...partial, run: () => { fired.push(partial.sessionId); return true; } }),
  };
}

describe('LaunchGovernor', () => {
  it('arrange-check: healthy snapshot passes headroom, hot5h fails', () => {
    expect(evaluateHeadroom(healthy, NOW).launch).toBe(true);
    expect(evaluateHeadroom(hot5h, NOW).launch).toBe(false);
    expect(evaluateHeadroom(hot5h, NOW).code).toBe('five-hour-ceiling');
  });

  it('fires immediately when queued + healthy + a free slot', () => {
    const { gov, fired, makeReq } = harness(healthy, 1);
    const r = makeReq({ key: 'j1#orchestrator', sessionId: 's1' });
    gov.submit(r);
    expect(fired).toEqual(['s1']);
    expect(gov.describe('j1#orchestrator')).toEqual({ state: 'running' });
  });

  it('parks when headroom is blocked (hot 5h ceiling)', () => {
    const { gov, fired, makeReq } = harness(hot5h, 1);
    const r = makeReq({ key: 'j1#orchestrator', sessionId: 's1' });
    gov.submit(r);
    expect(fired).toEqual([]);
    const state = gov.describe('j1#orchestrator');
    expect(state.state).toBe('queued');
    expect((state as { reason: string }).reason).toMatch(/5h/);
    expect((state as { reason: string }).reason.startsWith('Queued —')).toBe(false);
  });

  it('parks on slot exhaustion even when headroom is healthy', () => {
    const { gov, fired, makeReq } = harness(healthy, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    expect(fired).toEqual(['a']);
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b' }));
    expect(fired).toEqual(['a']);
    const state = gov.describe('j2#b');
    expect(state.state).toBe('queued');
    // BARE reason — the "Queued — " prefix is the PWA's job (vm/tracked.js), added once there.
    expect((state as { reason: string }).reason).toBe('1/1 slots busy');
    expect((state as { reason: string }).reason.startsWith('Queued —')).toBe(false);
  });

  it('immediate priority fires even with hot headroom and full slots, occupying a slot', () => {
    const { gov, fired, makeReq } = harness(hot5h, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a', priority: 'immediate' }));
    expect(fired).toEqual(['a']);

    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', priority: 'queued' }));
    expect(fired).toEqual(['a']);
    expect(gov.describe('j2#b').state).toBe('queued');
  });

  it('turnEnded frees a slot and drains a parked queued request', () => {
    const { gov, fired, makeReq } = harness(healthy, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    expect(fired).toEqual(['a']);

    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b' }));
    expect(fired).toEqual(['a']);
    expect(gov.describe('j2#b').state).toBe('queued');

    gov.turnEnded('a');
    expect(gov.describe('j1#a').state).toBe('idle');
    expect(fired).toEqual(['a', 'b']);
    expect(gov.describe('j2#b')).toEqual({ state: 'running' });
  });

  it('drain orders jobInProgress before FIFO enqueuedAt', () => {
    const { gov, fired, makeReq, setSnapshot } = harness(hot5h, 5);
    gov.submit(makeReq({ key: 'A', sessionId: 'A', jobInProgress: false, enqueuedAt: 1 }));
    gov.submit(makeReq({ key: 'B', sessionId: 'B', jobInProgress: true, enqueuedAt: 2 }));
    expect(fired).toEqual([]);

    setSnapshot(healthy);
    gov.onUsageSnapshot();
    expect(fired).toEqual(['B', 'A']);
  });

  it('fails open with no usage data and a free slot', () => {
    const { gov, fired, makeReq } = harness(undefined, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    expect(fired).toEqual(['a']);
  });

  it('forceFire launches a parked request bypassing the gate and occupies a slot', () => {
    const { gov, fired, makeReq } = harness(hot5h, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    expect(fired).toEqual([]);
    expect(gov.describe('j1#a').state).toBe('queued');

    const ok = gov.forceFire('j1#a');
    expect(ok).toBe(true);
    expect(fired).toEqual(['a']);
    expect(gov.describe('j1#a')).toEqual({ state: 'running' });

    expect(gov.forceFire('nonexistent')).toBe(false);
  });

  it('re-submitting a parked key replaces it, only the latest run fires', () => {
    const { gov, fired, makeReq } = harness(hot5h, 1);
    const firstRun: string[] = [];
    const secondRun: string[] = [];
    gov.submit({ ...makeReq({ key: 'j1#a', sessionId: 'a' }), run: () => { firstRun.push('first'); return true; } });
    gov.submit({ ...makeReq({ key: 'j1#a', sessionId: 'a' }), run: () => { secondRun.push('second'); return true; } });

    expect(fired).toEqual([]);
    const ok = gov.forceFire('j1#a');
    expect(ok).toBe(true);
    expect(firstRun).toEqual([]);
    expect(secondRun).toEqual(['second']);
  });

  it('cancel drops a job\'s parked requests so they never fire on later drain', () => {
    const { gov, fired, makeReq, setSnapshot } = harness(hot5h, 5);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a', jobId: 'j1' }));
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    expect(fired).toEqual([]);

    gov.cancel('j1');
    setSnapshot(healthy);
    gov.onUsageSnapshot();

    expect(fired).toEqual(['b']);
    expect(gov.describe('j1#a').state).toBe('idle');
  });

  it('forceFireJob fires exactly the named job\'s parked requests, leaving others parked', () => {
    const { gov, fired, makeReq } = harness(hot5h, 5);
    gov.submit(makeReq({ key: 'A#1', sessionId: 'a1', jobId: 'A' }));
    gov.submit(makeReq({ key: 'A#2', sessionId: 'a2', jobId: 'A' }));
    gov.submit(makeReq({ key: 'B#1', sessionId: 'b1', jobId: 'B' }));
    expect(fired).toEqual([]);

    const n = gov.forceFireJob('A');
    expect(n).toBe(2);
    expect(fired.sort()).toEqual(['a1', 'a2']);
    expect(gov.describe('B#1').state).toBe('queued');
  });

  it('a run that returns false frees the slot (no leak); a later queued request still fires', () => {
    const { gov, fired, makeReq } = harness(healthy, 1);
    // First launch's run bails without starting a turn → must not hold the slot.
    gov.submit({ ...makeReq({ key: 'j1#a', sessionId: 'a' }), run: () => false });
    expect(gov.describe('j1#a').state).toBe('idle');   // not running — slot released

    // A second queued request must still be able to fire (slot wasn't permanently consumed).
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    expect(fired).toEqual(['b']);
    expect(gov.describe('j2#b').state).toBe('running');
  });

  it('a run that returns true occupies the slot until turnEnded', () => {
    const { gov, makeReq } = harness(healthy, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    expect(gov.describe('j1#a').state).toBe('running');   // slot held
    // Concurrency 1: a second queued request parks behind the held slot.
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    expect(gov.describe('j2#b').state).toBe('queued');
    gov.turnEnded('a');
    expect(gov.describe('j2#b').state).toBe('running');   // freed → drained
  });

  it('invokes onChange on fire, park, turnEnded, and cancel', () => {
    const { gov, makeReq, changeCount } = harness(healthy, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    expect(changeCount()).toBe(1);

    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b' }));
    expect(changeCount()).toBe(2);

    gov.turnEnded('a');
    expect(changeCount()).toBe(4);

    gov.submit(makeReq({ key: 'j3#c', sessionId: 'c', jobId: 'j3' }));
    gov.cancel('j3');
    expect(changeCount()).toBe(6);
  });
});

describe('LaunchGovernor — app-wide queue summary', () => {
  // 60% used with 4 days left projects to ~140%: the jobs' budget rule holds.
  const overBudget: TokenUsageSnapshot = {
    five_hour: { used_percentage: 10, resets_at: NOW_S + 3600 },
    seven_day: { used_percentage: 60, resets_at: NOW_S + 4 * 86400 },
  };

  it('is empty while nothing waits', () => {
    const { gov } = harness();
    expect(gov.summary()).toEqual({ paused: false, parked: 0, reason: null, opensAt: null, active: 0, slots: 1, blocker: null, ignoreBudgetUntil: null });
  });

  it('names the window the budget gate is closed on, and ignoring it lets work through for an hour', () => {
    let now = NOW;
    let snapshot: TokenUsageSnapshot = overBudget;
    const fired: string[] = [];
    const gov = new LaunchGovernor({ getSnapshot: () => snapshot, getConcurrency: () => 4, now: () => now });
    const submit = (id: string) => gov.submit(req({ key: `j#${id}`, sessionId: id, run: () => { fired.push(id); return true; } }));
    expect(gov.summary().blocker).toBe('seven_day');
    snapshot = hot5h;
    expect(gov.summary().blocker).toBe('five_hour');
    submit('a');
    expect(fired).toEqual([]);

    gov.ignoreBudget(60 * 60_000);
    expect(fired).toEqual(['a']);
    // Still named while ignored, so the popover can say what's being ignored.
    expect(gov.summary()).toMatchObject({ blocker: 'five_hour', ignoreBudgetUntil: NOW + 60 * 60_000 });
    submit('b');
    expect(fired).toEqual(['a', 'b']);

    now = NOW + 60 * 60_000;
    expect(gov.summary().ignoreBudgetUntil).toBeNull();
    submit('c');
    expect(fired).toEqual(['a', 'b']);
    gov.ignoreBudget(60 * 60_000);
    gov.ignoreBudget(0);
    expect(gov.summary().ignoreBudgetUntil).toBeNull();
  });

  it('counts what the budget holds, says why, and when it opens', () => {
    const { gov, makeReq } = harness(overBudget, 4);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    const s = gov.summary();
    expect(s.parked).toBe(2);
    expect(s.reason).toContain('on course for');
    expect(s.opensAt).toBeGreaterThan(NOW);
  });

  it('gives no opening time when the hold is busy slots (those free on a turn end, not a clock)', () => {
    const { gov, makeReq } = harness(healthy, 1);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    expect(gov.summary()).toMatchObject({ parked: 1, reason: '1/1 slots busy', opensAt: null });
  });

  it('reports slot occupancy against the cap', () => {
    const { gov, makeReq } = harness(healthy, 3);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    expect(gov.summary()).toMatchObject({ active: 2, slots: 3, parked: 0 });
    gov.turnEnded('a');
    expect(gov.summary()).toMatchObject({ active: 1, slots: 3 });
  });

  it('forceFireAll launches everything parked', () => {
    const { gov, makeReq, fired } = harness(overBudget, 4);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    gov.submit(makeReq({ key: 'j2#b', sessionId: 'b', jobId: 'j2' }));
    expect(gov.forceFireAll()).toBe(2);
    expect(fired).toEqual(['a', 'b']);
    expect(gov.summary().parked).toBe(0);
  });

  it('re-emits on a usage update while work still waits, so the meter\'s line stays current', () => {
    const { gov, makeReq, changeCount } = harness(overBudget, 4);
    gov.submit(makeReq({ key: 'j1#a', sessionId: 'a' }));
    const before = changeCount();
    gov.onUsageSnapshot();
    expect(changeCount()).toBe(before + 1);
  });
});

describe('LaunchGovernor — the user pause', () => {
  function pausable(snapshot: TokenUsageSnapshot = healthy) {
    let paused = false;
    const fired: string[] = [];
    const gov = new LaunchGovernor({
      getSnapshot: () => snapshot, getConcurrency: () => 4, now: () => NOW,
      isPaused: () => paused, setPaused: (p) => { paused = p; },
    });
    const sub = (key: string, priority: LaunchRequest['priority'], extra: Partial<LaunchRequest> = {}) =>
      gov.submit(req({ key, sessionId: key, priority, run: () => { fired.push(key); return true; }, ...extra }));
    return { gov, fired, sub, isPaused: () => paused };
  }

  it('holds the daemon\'s own starts, queued and immediate alike, but never an explicit click', () => {
    const { gov, fired, sub, isPaused } = pausable();
    gov.setPaused(true);
    expect(isPaused()).toBe(true);
    sub('q', 'queued');
    sub('i', 'immediate');
    sub('u', 'user');
    expect(fired).toEqual(['u']);
    expect(gov.summary()).toMatchObject({ paused: true, parked: 2, reason: 'Job queue paused', opensAt: null });
    expect(gov.describe('q')).toEqual({ state: 'queued', reason: 'Job queue paused' });
  });

  it('resuming drains what the pause held: immediates first and past the budget, queued only within it', () => {
    const overBudget: TokenUsageSnapshot = {
      five_hour: { used_percentage: 10, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 60, resets_at: NOW_S + 4 * 86400 },
    };
    const { gov, fired, sub } = pausable(overBudget);
    gov.setPaused(true);
    sub('q', 'queued', { enqueuedAt: 1 });
    sub('i', 'immediate', { enqueuedAt: 2 });
    gov.setPaused(false);
    expect(fired).toEqual(['i']);
    expect(gov.summary()).toMatchObject({ paused: false, parked: 1 });
  });

  it('Run all still fires everything while paused', () => {
    const { gov, fired, sub } = pausable();
    gov.setPaused(true);
    sub('a', 'queued');
    sub('b', 'immediate');
    expect(gov.forceFireAll()).toBe(2);
    expect(fired.sort()).toEqual(['a', 'b']);
  });
});
