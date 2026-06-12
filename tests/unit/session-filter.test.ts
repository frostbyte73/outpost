import { describe, it, expect } from 'vitest';
import { partitionSessions } from '../../src/pwa/session-filter.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function mkSessions(specs: Array<{
  id?: string;
  ageDays: number;
  worktreePath?: string;
  archived?: boolean;
}>) {
  return specs.map((s, i) => ({
    id: s.id ?? `s${i}`,
    title: `Session ${i}`,
    lastModified: NOW - s.ageDays * DAY,
    path: `/tmp/s${i}.jsonl`,
    ...(s.worktreePath ? { worktreePath: s.worktreePath } : {}),
    ...(s.archived ? { archived: true } : {}),
  }));
}

describe('partitionSessions', () => {
  it('returns nothing visible and 0 hidden for an empty list', () => {
    const out = partitionSessions([], 0, NOW);
    expect(out.visible).toEqual([]);
    expect(out.hiddenRemaining).toBe(0);
  });

  it('shows everything when there are <= 3 recent sessions', () => {
    const sessions = mkSessions([{ ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 }]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible).toHaveLength(3);
    expect(out.hiddenRemaining).toBe(0);
  });

  it('shows all sessions when all are within the 7-day window', () => {
    const sessions = mkSessions([0, 1, 2, 3, 4].map((d) => ({ ageDays: d })));
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible).toHaveLength(5);
    expect(out.hiddenRemaining).toBe(0);
  });

  it('hides sessions past position 3 that are older than 7 days', () => {
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 },
      { ageDays: 10 }, { ageDays: 20 },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(out.hiddenRemaining).toBe(2);
  });

  it('always surfaces a session with an active worktree, regardless of age/position', () => {
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 },
      { ageDays: 30 }, { ageDays: 40 },
      { id: 'wt', ageDays: 50, worktreePath: '/tmp/wt' },
      { ageDays: 60 },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible.map((s) => s.id)).toEqual(['s0', 's1', 's2', 'wt']);
    expect(out.hiddenRemaining).toBe(3);
  });

  it('does NOT give archived worktrees a carve-out', () => {
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 },
      { ageDays: 30, worktreePath: '/tmp/wt', archived: true },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(out.hiddenRemaining).toBe(1);
  });

  it('reveals hidden sessions in newest-of-hidden first order as extraRevealed grows', () => {
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 },
      { id: 'h1', ageDays: 10 },
      { id: 'h2', ageDays: 20 },
      { id: 'h3', ageDays: 30 },
    ]);
    const out = partitionSessions(sessions, 2, NOW);
    expect(out.visible.map((s) => s.id)).toEqual(['s0', 's1', 's2', 'h1', 'h2']);
    expect(out.hiddenRemaining).toBe(1);
  });

  it('preserves newest-first order across always-show, age-visible, and revealed buckets', () => {
    const sessions = mkSessions([
      { id: 'a', ageDays: 0 },
      { id: 'b', ageDays: 1 },
      { id: 'c', ageDays: 3 },
      { id: 'd', ageDays: 10, worktreePath: '/tmp/d' },
      { id: 'e', ageDays: 15 },
      { id: 'f', ageDays: 20 },
    ]);
    const out = partitionSessions(sessions, 1, NOW);
    expect(out.visible.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.hiddenRemaining).toBe(1);
  });

  it('clamps extraRevealed: an oversized value yields all-visible and 0 hidden', () => {
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 },
      { ageDays: 10 }, { ageDays: 20 },
    ]);
    const out = partitionSessions(sessions, 999, NOW);
    expect(out.visible).toHaveLength(5);
    expect(out.hiddenRemaining).toBe(0);
  });

  it('treats lastModified exactly 7 days old as visible (inclusive boundary)', () => {
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 2 },
      { id: 'edge', ageDays: 7 },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible.map((s) => s.id)).toContain('edge');
    expect(out.hiddenRemaining).toBe(0);
  });
});
