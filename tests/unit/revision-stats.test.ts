import { describe, it, expect } from 'vitest';
import { buildRevisionStats, regressionVerdict, revisionWindows, spentRunIds } from '../../src/actions/revision-stats.js';
import type { ActionEvent } from '../../src/storage/action-revisions-store.js';
import type { ActionRunOutcome, ActionRunRecord } from '../../src/storage/action-runs-store.js';

let seq = 0;
function ev(over: Partial<ActionEvent> & Pick<ActionEvent, 'kind' | 'at'>): ActionEvent {
  return { id: `e${++seq}`, action: 'a', author: 'user', bodySha: `sha-${seq}`, bodyBytes: 400, ...over };
}
function run(skillSha: string | undefined, startedAt: number, outcome?: ActionRunOutcome, over: Partial<ActionRunRecord> = {}): ActionRunRecord {
  return {
    id: `r${++seq}`, action: 'a', round: 'r', attempt: 1, jobId: 'j', startedAt,
    ...(skillSha ? { skillSha } : {}), ...(outcome ? { outcome, verdictAt: startedAt } : {}), ...over,
  };
}
function runs(skillSha: string, from: number, outcomes: ActionRunOutcome[]): ActionRunRecord[] {
  return outcomes.map((o, i) => run(skillSha, from + i, o));
}
const many = (o: ActionRunOutcome, n: number): ActionRunOutcome[] => Array<ActionRunOutcome>(n).fill(o);

describe('revisionWindows', () => {
  it('counts a run toward a revision only when it ran that body while it was head', () => {
    const v1 = ev({ kind: 'created', at: 100, bodySha: 'A' });
    const v2 = ev({ kind: 'applied', at: 200, bodySha: 'B' });
    const w = revisionWindows([v2, v1], [
      run('A', 150, 'accepted'),
      run('A', 210, 'accepted'),
      run('B', 220, 'edited'),
      run(undefined, 230, 'accepted'),
    ]);
    expect(w.map((x) => [x.event.id, x.end, x.runs.length])).toEqual([[v1.id, 200, 1], [v2.id, null, 1]]);
  });

  it('gives a body that returns via revert its own window', () => {
    const a1 = ev({ kind: 'created', at: 100, bodySha: 'A' });
    const b = ev({ kind: 'applied', at: 200, bodySha: 'B' });
    const a2 = ev({ kind: 'reverted', at: 300, bodySha: 'A' });
    const w = revisionWindows([a2, b, a1], [run('A', 150, 'accepted'), run('A', 350, 'denied')]);
    expect(w.map((x) => x.runs.map((r) => r.outcome))).toEqual([['accepted'], [], ['denied']]);
  });

  it('ends the last window at a deletion and opens none for it', () => {
    const a = ev({ kind: 'created', at: 100, bodySha: 'A' });
    const d = ev({ kind: 'deleted', at: 200, bodySha: 'A' });
    const w = revisionWindows([d, a], []);
    expect(w).toHaveLength(1);
    expect(w[0]!.end).toBe(200);
  });
});

describe('genesis and drift windows', () => {
  it('credits a body recorded only at the next write with the runs that ran it before', () => {
    const genesis = ev({ kind: 'created', at: 1000, bodySha: 'A', author: 'system' });
    const edit = ev({ kind: 'applied', at: 1003, bodySha: 'B' });
    const drift = ev({ kind: 'drifted', at: 2000, bodySha: 'C', author: 'external' });
    const next = ev({ kind: 'applied', at: 2003, bodySha: 'D' });
    const w = revisionWindows([next, drift, edit, genesis], [
      run('A', 10, 'accepted'), run('C', 1500, 'accepted'), run('C', 900, 'accepted'),
    ]);
    expect(w.map((x) => x.runs.length)).toEqual([1, 0, 1, 0]);
  });
});

describe('buildRevisionStats', () => {
  it('scores verbatim and failure rates, tokens and the delta, newest first', () => {
    const v1 = ev({ kind: 'created', at: 100, bodySha: 'A', bodyBytes: 4000 });
    const v2 = ev({ kind: 'applied', at: 200, bodySha: 'B', bodyBytes: 4400, author: 'improver', rationale: 'tighten' });
    const stats = buildRevisionStats([v2, v1], [
      ...runs('B', 210, ['accepted', 'accepted', 'edited', 'failed', 'submitted', 'superseded']),
      run('B', 300, 'accepted', { costUsd: 0.5 }),
    ]);
    expect(stats.map((s) => s.eventId)).toEqual([v2.id, v1.id]);
    const s = stats[0]!;
    expect(s.runs).toBe(7);
    expect(s.adjudicated).toBe(4);
    expect(s.verbatimRate).toBeCloseTo(3 / 4);
    expect(s.failureRate).toBeCloseTo(1 / 5);
    expect(s.avgCostUsd).toBeCloseTo(0.5);
    expect(s.tokens).toBe(1100);
    expect(s.tokenDelta).toBe(100);
    expect(s.rationale).toBe('tighten');
    expect(stats[1]!.verbatimRate).toBeNull();
    expect(stats[1]!.tokenDelta).toBeNull();
  });
});

describe('regressionVerdict', () => {
  const base = () => ev({ kind: 'created', at: 100, bodySha: 'A' });
  const edit = (over: Partial<ActionEvent> = {}) => ev({ kind: 'applied', at: 1000, bodySha: 'B', author: 'improver', ...over });

  it('reverts an improver revision that drops more than 0.15 below its baseline', () => {
    const a = base(); const b = edit();
    const v = regressionVerdict([b, a], [
      ...runs('A', 200, [...many('accepted', 8), ...many('edited', 2)]),
      ...runs('B', 1100, [...many('accepted', 5), ...many('edited', 3)]),
    ]);
    expect(v).toEqual({ regressed: true, restoreEventId: a.id, regressedEventId: b.id, before: 0.8, after: 0.625 });
  });

  it('holds at a drop of 0.15 or less', () => {
    const a = base(); const b = edit();
    const v = regressionVerdict([b, a], [
      ...runs('A', 200, [...many('accepted', 8), ...many('edited', 2)]),
      ...runs('B', 1100, [...many('accepted', 6), ...many('edited', 2)]),
    ]);
    expect(v.regressed).toBe(false);
  });

  it('waits for 8 adjudicated runs and judges only the first 8', () => {
    const a = base(); const b = edit();
    const baseline = runs('A', 200, many('accepted', 10));
    expect(regressionVerdict([b, a], [...baseline, ...runs('B', 1100, many('denied', 7))]).regressed).toBe(false);
    const later = [...runs('B', 1100, many('accepted', 8)), ...runs('B', 2000, many('denied', 8))];
    expect(regressionVerdict([b, a], [...baseline, ...later]).regressed).toBe(false);
  });

  it('has no baseline under 5 adjudicated runs, and uses only the last 20', () => {
    const a = base(); const b = edit();
    const bad = runs('B', 1100, many('denied', 8));
    expect(regressionVerdict([b, a], [...runs('A', 200, many('accepted', 4)), ...bad]).regressed).toBe(false);
    const v = regressionVerdict([b, a], [...runs('A', 200, many('denied', 30)), ...runs('A', 300, many('accepted', 20)), ...bad]);
    expect(v).toMatchObject({ regressed: true, before: 1 });
  });

  it('never reverts a user, drifted, or already-reverted head', () => {
    const outcomes = [...runs('A', 200, many('accepted', 10)), ...runs('B', 1100, many('denied', 8))];
    for (const head of [
      edit({ author: 'user' }),
      ev({ kind: 'drifted', at: 1000, bodySha: 'B', author: 'external' }),
      ev({ kind: 'reverted', at: 1000, bodySha: 'B', author: 'system' }),
    ]) {
      expect(regressionVerdict([head, base()], outcomes).regressed).toBe(false);
    }
  });

  it('never reverts a deleted action', () => {
    const a = base(); const b = edit();
    const d = ev({ kind: 'deleted', at: 5000, bodySha: 'B' });
    const outcomes = [...runs('A', 200, many('accepted', 10)), ...runs('B', 1100, many('denied', 8))];
    expect(regressionVerdict([d, b, a], outcomes).regressed).toBe(false);
  });

  it('never reverts an action whose runs carry no draft verdicts', () => {
    const a = base(); const b = edit();
    const outcomes = [...runs('A', 200, many('merged', 10)), ...runs('B', 1100, many('failed', 8))];
    expect(regressionVerdict([b, a], outcomes).regressed).toBe(false);
  });
});

describe('verbatim rate counts only runs the user ruled on', () => {
  it('ignores rounds that closed accepted with no verdict', () => {
    const a = ev({ kind: 'created', at: 100, bodySha: 'A' });
    const unruled = Array.from({ length: 6 }, (_, i) => run('A', 150 + i, 'accepted', { verdictAt: undefined }));
    const [s] = buildRevisionStats([a], [...unruled, run('A', 200, 'denied'), run('A', 201, 'accepted')]);
    expect(s!.adjudicated).toBe(2);
    expect(s!.verbatimRate).toBeCloseTo(0.5);
  });
});

describe('spentRunIds', () => {
  it('collects runs cited by an improver revision that was then reverted', () => {
    const a = ev({ kind: 'created', at: 100 });
    const kept = ev({ kind: 'applied', at: 200, author: 'improver', citedRunIds: ['r-keep'] });
    const lost = ev({ kind: 'applied', at: 300, author: 'improver', citedRunIds: ['r-a', 'r-b'] });
    const rev = ev({ kind: 'reverted', at: 400, author: 'system' });
    expect([...spentRunIds([rev, lost, kept, a])].sort()).toEqual(['r-a', 'r-b']);
  });
});
