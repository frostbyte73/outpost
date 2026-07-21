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
  it('returns nothing for an empty list', () => {
    const out = partitionSessions([], 0, NOW);
    expect(out.visible).toEqual([]);
    expect(out.hiddenRemaining).toBe(0);
    expect(out.archivedCount).toBe(0);
  });

  it('shows every non-archived session regardless of age', () => {
    // The daemon stamps archived: true on anything past 7d, so by the time the PWA's
    // filter runs, any non-archived session is by definition "live" — show all of them.
    const sessions = mkSessions([
      { ageDays: 0 }, { ageDays: 1 }, { ageDays: 6 },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible).toHaveLength(3);
    expect(out.archivedCount).toBe(0);
    expect(out.hiddenRemaining).toBe(0);
  });

  it('excludes archived sessions by default, counts them in archivedCount', () => {
    const sessions = mkSessions([
      { ageDays: 0 },
      { ageDays: 1, archived: true },
      { ageDays: 2 },
      { ageDays: 30, archived: true },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible.map((s) => s.id)).toEqual(['s0', 's2']);
    expect(out.archivedCount).toBe(2);
  });

  it('merges archived sessions back into visible (in original order) when showArchived is true', () => {
    const sessions = mkSessions([
      { id: 'a', ageDays: 0 },
      { id: 'b', ageDays: 1, archived: true },
      { id: 'c', ageDays: 2 },
    ]);
    const out = partitionSessions(sessions, 0, NOW, { showArchived: true });
    expect(out.visible.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(out.archivedCount).toBe(1);
  });

  it('handles a list of only archived sessions', () => {
    // Edge case underpinning "project with only archived sessions still shows": the
    // partition itself returns 0 visible but a positive archivedCount, so the PWA
    // can render the "Show N archived" toggle.
    const sessions = mkSessions([
      { ageDays: 10, archived: true },
      { ageDays: 20, archived: true },
    ]);
    const out = partitionSessions(sessions, 0, NOW);
    expect(out.visible).toEqual([]);
    expect(out.archivedCount).toBe(2);
    const shown = partitionSessions(sessions, 0, NOW, { showArchived: true });
    expect(shown.visible).toHaveLength(2);
    expect(shown.archivedCount).toBe(2);
  });
});
