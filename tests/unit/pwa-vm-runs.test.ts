import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { runsRows } from '../../src/pwa/vm/runs.js';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;

// RunRecord (src/storage/runs-store.ts) has no `skill` field — the invoking
// skill is folded into `sub` (see vm/runs.js's runSkill), so fixtures carry
// `sub` rather than a bespoke `skill` property.
function runs() {
  return [
    { id: 'r1', kind: 'sess', title: 'Session A', cwd: '/repo-a', verdict: 'Client-side · closed', startedAt: NOW - HOUR, durationMs: 60_000, costUsd: 0.5, sub: 'read.investigate' },
    { id: 'r2', kind: 'track', title: 'Tracked B', cwd: '/repo-b', verdict: 'Merged cleanly', startedAt: NOW - 2 * HOUR, durationMs: 120_000, costUsd: 1.25, sub: 'code.implement' },
    { id: 'r3', kind: 'sched', title: 'Scheduled C', cwd: '/repo-a', verdict: 'Skipped — usage 96%', startedAt: NOW - 30 * HOUR, durationMs: 0, costUsd: 0, sub: 'read.investigate' },
  ];
}

describe('runsRows', () => {
  it('sorts newest first with no filters', () => {
    const { rows } = runsRows(runs(), {}, NOW);
    expect(rows.map((r: any) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('filters by window', () => {
    const { rows } = runsRows(runs(), { window: '24h' }, NOW);
    expect(rows.map((r: any) => r.id)).toEqual(['r1', 'r2']);
  });

  it('filters by kind', () => {
    const { rows } = runsRows(runs(), { kind: 'track' }, NOW);
    expect(rows.map((r: any) => r.id)).toEqual(['r2']);
  });

  it('filters by skill', () => {
    const { rows } = runsRows(runs(), { skill: 'read.investigate' }, NOW);
    expect(rows.map((r: any) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('filters by repo (cwd)', () => {
    const { rows } = runsRows(runs(), { repo: '/repo-a' }, NOW);
    expect(rows.map((r: any) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  // Verdict is a free-form human phrase with no separate machine tone field,
  // so the filter operates on the same tone heuristic used for row coloring
  // ('ok'/'warn'/'hot'/'info') rather than an arbitrary substring — see
  // vm/runs.js's verdictTone/matchesVerdict.
  it('filters by verdict tone', () => {
    const { rows } = runsRows(runs(), { verdict: 'warn' }, NOW);
    expect(rows.map((r: any) => r.id)).toEqual(['r3']);
  });

  it('tallies count, duration, and cost over the filtered set', () => {
    const { tally } = runsRows(runs(), { window: '24h' }, NOW);
    expect(tally).toEqual({ count: 2, totalDurationMs: 180_000, totalCostUsd: 1.75 });
  });

  it('empty result set yields a zeroed tally', () => {
    const { rows, tally } = runsRows(runs(), { kind: 'nonexistent' as any }, NOW);
    expect(rows).toEqual([]);
    expect(tally).toEqual({ count: 0, totalDurationMs: 0, totalCostUsd: 0 });
  });
});
