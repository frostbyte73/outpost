import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import * as L from '../../src/pwa/vm/cockpit-layout.js';

const W = 1400;
const two = () => L.defaultLayout(W);
const sum = (layout: any) => layout.columns.reduce((a: number, c: any) => a + c.width, 0);
const ids = (layout: any) => layout.columns.map((c: any) => c.sections);

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key, kind: key.split(':')[0], id: key.split(':')[1], actions: [], tone: 'idle', ...over,
});
const board = (over: Record<string, unknown> = {}) => ({
  started: [row('job:a'), row('job:b', { actions: [{ kind: 'gate' }] })],
  notStarted: [row('job:c')],
  backlog: [row('job:d')],
  sessions: [row('session:s1'), row('session:s2', { actions: [{ kind: 'approval' }] })],
  other: [row('other:o1', { tone: 'you' }), row('other:o2', { tone: 'failed' })],
  ...over,
});
const withPin = (rows: string[], col = 1, title = 'Pinned') => {
  const l = two();
  l.pinned.p1 = { title, rows };
  l.columns[col].sections.push('pin:p1');
  return l;
};

describe('defaultLayout', () => {
  it('two columns at 1400px', () => {
    expect(ids(L.defaultLayout(1400))).toEqual([['jobs'], ['other', 'sessions']]);
  });
  it('one column at 700px', () => {
    expect(ids(L.defaultLayout(700))).toEqual([['jobs', 'other', 'sessions']]);
    expect(L.defaultLayout(700).columns[0].width).toBe(1);
  });
});

describe('normalizeLayout', () => {
  it('garbage input yields the default', () => {
    for (const raw of [null, 7, 'x', {}, { columns: 'no' }]) expect(L.normalizeLayout(raw, W)).toEqual(two());
  });
  it('drops unknown section ids', () => {
    const l = L.normalizeLayout({ columns: [{ width: 1, sections: ['jobs', 'bogus', 'sessions', 'other'] }], pinned: {} }, W);
    expect(ids(l)).toEqual([['jobs', 'sessions', 'other']]);
  });
  it('drops unknown row-key kinds from pins', () => {
    const l = L.normalizeLayout(withPin(['other:x', 'foo:y', 'job:a']), W);
    expect(l.pinned.p1.rows).toEqual(['job:a']);
  });
  it('dedupes a row key across two pins, first wins', () => {
    const l = withPin(['job:a']);
    l.pinned.p2 = { title: 'B', rows: ['job:a', 'session:s1'] };
    l.columns[1].sections.push('pin:p2');
    const n = L.normalizeLayout(l, W);
    expect(n.pinned.p1.rows).toEqual(['job:a']);
    expect(n.pinned.p2.rows).toEqual(['session:s1']);
  });
  it('dedupes a repeated section id', () => {
    const n = L.normalizeLayout({ columns: [{ width: 0.5, sections: ['jobs', 'other'] }, { width: 0.5, sections: ['jobs', 'sessions'] }], pinned: {} }, W);
    expect(ids(n)).toEqual([['jobs', 'other'], ['sessions']]);
  });
  it('drops a column entry naming a missing pin', () => {
    const l = two();
    l.columns[0].sections.push('pin:ghost');
    expect(ids(L.normalizeLayout(l, W))).toEqual([['jobs'], ['other', 'sessions']]);
  });
  it('drops pinned entries placed in no column', () => {
    const l = two();
    l.pinned.lost = { title: 'x', rows: ['job:a'] };
    expect(L.normalizeLayout(l, W).pinned).toEqual({});
  });
  it('drops a pin with no rows', () => {
    const n = L.normalizeLayout(withPin([]), W);
    expect(n.pinned).toEqual({});
    expect(ids(n)).toEqual([['jobs'], ['other', 'sessions']]);
  });
  it('keeps a renamed pin with no rows', () => {
    const n = L.normalizeLayout(withPin([], 1, 'Replay'), W);
    expect(n.pinned.p1).toEqual({ title: 'Replay', rows: [] });
    expect(ids(n)).toEqual([['jobs'], ['other', 'sessions', 'pin:p1']]);
  });
  it('re-adds a missing built-in to the first column', () => {
    const n = L.normalizeLayout({ columns: [{ width: 0.5, sections: ['jobs'] }, { width: 0.5, sections: ['sessions'] }], pinned: {} }, W);
    expect(ids(n)).toEqual([['jobs', 'other'], ['sessions']]);
  });
  it('renormalises bad widths to equal shares', () => {
    for (const bad of [[NaN, 0.5], [0, 1], [-1, 2], [0.4, 0.3]]) {
      const n = L.normalizeLayout({ columns: [{ width: bad[0], sections: ['jobs'] }, { width: bad[1], sections: ['other', 'sessions'] }], pinned: {} }, W);
      expect(n.columns.map((c: any) => c.width)).toEqual([0.5, 0.5]);
    }
  });
  it('keeps good widths', () => {
    const n = L.normalizeLayout({ columns: [{ width: 0.3, sections: ['jobs'] }, { width: 0.7, sections: ['other', 'sessions'] }], pinned: {} }, W);
    expect(n.columns.map((c: any) => c.width)).toEqual([0.3, 0.7]);
  });
  it('coerces a non-string title to Pinned and truncates to 40', () => {
    expect(L.normalizeLayout(withPin(['job:a'], 1, 42 as any), W).pinned.p1.title).toBe('Pinned');
    expect(L.normalizeLayout(withPin(['job:a'], 1, 'x'.repeat(60)), W).pinned.p1.title).toHaveLength(40);
  });
  it('keeps an empty column — only a completed drop removes one', () => {
    const n = L.normalizeLayout({ columns: [{ width: 0.5, sections: ['jobs', 'other', 'sessions'] }, { width: 0.5, sections: [] }], pinned: {} }, W);
    expect(ids(n)).toEqual([['jobs', 'other', 'sessions'], []]);
  });
  it('an empty column list becomes one column holding the built-ins', () => {
    expect(ids(L.normalizeLayout({ columns: [], pinned: {} }, W))).toEqual([['jobs', 'sessions', 'other']]);
  });
});

describe('resolveBoard', () => {
  const sec = (r: any, id: string) => r.columns.flatMap((c: any) => c.sections).find((s: any) => s.id === id);

  it('places built-ins per the default layout', () => {
    const r = L.resolveBoard(board(), two());
    expect(r.columns.map((c: any) => c.sections.map((s: any) => s.id))).toEqual([['jobs'], ['other', 'sessions']]);
    expect(sec(r, 'jobs').groups.started.map((x: any) => x.key)).toEqual(['job:a', 'job:b']);
    expect(sec(r, 'other').rows).toHaveLength(2);
  });
  it('pinned rows leave Jobs and Sessions', () => {
    const r = L.resolveBoard(board(), withPin(['session:s1', 'job:c']));
    expect(sec(r, 'sessions').rows.map((x: any) => x.key)).toEqual(['session:s2']);
    expect(sec(r, 'jobs').groups.notStarted).toEqual([]);
    expect(sec(r, 'pin:p1').rows.map((x: any) => x.key)).toEqual(['session:s1', 'job:c']);
    expect(sec(r, 'pin:p1').kind).toBe('pinned');
    expect(sec(r, 'pin:p1').title).toBe('Pinned');
  });
  it('filters a dead pin key from output without touching the layout', () => {
    const l = withPin(['job:gone', 'job:a']);
    const before = JSON.stringify(l);
    const r = L.resolveBoard(board(), l);
    expect(sec(r, 'pin:p1').rows.map((x: any) => x.key)).toEqual(['job:a']);
    expect(JSON.stringify(l)).toBe(before);
  });
  it('omits a Pinned section whose rows are all dead', () => {
    const r = L.resolveBoard(board({ started: [], notStarted: [], backlog: [], sessions: [] }), withPin(['job:a']));
    expect(sec(r, 'pin:p1')).toBeUndefined();
    expect(sec(r, 'sessions').rows).toEqual([]);
  });
  it('keeps a renamed Pinned section whose rows are all dead, empty', () => {
    const r = L.resolveBoard(board({ started: [], notStarted: [], backlog: [], sessions: [] }), withPin(['job:a'], 1, 'Replay'));
    expect(sec(r, 'pin:p1').rows).toEqual([]);
  });
  it('needYou counts rows with actions, and you-toned chips', () => {
    const r = L.resolveBoard(board(), withPin(['session:s2']));
    expect(sec(r, 'jobs').needYou).toBe(1);
    expect(sec(r, 'sessions').needYou).toBe(0);
    expect(sec(r, 'pin:p1').needYou).toBe(1);
    expect(sec(r, 'other').needYou).toBe(1);
  });
  it('liveKeys covers jobs and sessions only', () => {
    expect([...L.liveKeys(board())].sort()).toEqual(['job:a', 'job:b', 'job:c', 'job:d', 'session:s1', 'session:s2']);
  });
});

describe('mutations', () => {
  it('pinRow newAt creates a section at that index', () => {
    const { layout, pinId } = L.pinRow(two(), 'session:s1', { newAt: { col: 1, index: 1 } });
    expect(layout.columns[1].sections).toEqual(['other', `pin:${pinId}`, 'sessions']);
    expect(layout.pinned[pinId]).toEqual({ title: 'Pinned', rows: ['session:s1'] });
  });
  it('pinRow into an existing pin inserts at index', () => {
    const { layout } = L.pinRow(withPin(['job:a', 'job:b']), 'session:s1', { pinId: 'p1', index: 1 });
    expect(layout.pinned.p1.rows).toEqual(['job:a', 'session:s1', 'job:b']);
  });
  it('reorders within the same pin', () => {
    const { layout } = L.pinRow(withPin(['job:a', 'job:b', 'job:c']), 'job:a', { pinId: 'p1', index: 2 });
    expect(layout.pinned.p1.rows).toEqual(['job:b', 'job:c', 'job:a']);
  });
  it('moving the last row of one pin into another drops the emptied pin', () => {
    const l = withPin(['job:a']);
    l.pinned.p2 = { title: 'B', rows: ['job:b'] };
    l.columns[0].sections.push('pin:p2');
    const { layout } = L.pinRow(l, 'job:a', { pinId: 'p2', index: 0 });
    expect(layout.pinned.p1).toBeUndefined();
    expect(layout.columns[1].sections).toEqual(['other', 'sessions']);
    expect(layout.pinned.p2.rows).toEqual(['job:a', 'job:b']);
  });
  it('pinRow refuses an other: key', () => {
    const l = two();
    const { layout, pinId } = L.pinRow(l, 'other:o1', { newAt: { col: 0, index: 0 } });
    expect(layout).toEqual(l);
    expect(pinId).toBeNull();
  });
  it('unpinRow removes the key and an emptied section', () => {
    const l = L.unpinRow(withPin(['job:a']), 'job:a');
    expect(l.pinned).toEqual({});
    expect(l.columns[1].sections).toEqual(['other', 'sessions']);
  });
  it('unpinning or moving out the last row keeps a renamed pin', () => {
    expect(L.unpinRow(withPin(['job:a'], 1, 'Replay'), 'job:a').pinned.p1).toEqual({ title: 'Replay', rows: [] });
    const l = withPin(['job:a'], 1, 'Replay');
    l.pinned.p2 = { title: 'B', rows: ['job:b'] };
    l.columns[0].sections.push('pin:p2');
    expect(L.pinRow(l, 'job:a', { pinId: 'p2', index: 0 }).layout.pinned.p1.rows).toEqual([]);
  });
  it('removePin drops the pin and its section', () => {
    const l = L.removePin(withPin([], 1, 'Replay'), 'p1');
    expect(l.pinned).toEqual({});
    expect(ids(l)).toEqual([['jobs'], ['other', 'sessions']]);
  });
  it('moveSection to another column and index', () => {
    const l = L.moveSection(two(), 'sessions', 0, 0);
    expect(ids(l)).toEqual([['sessions', 'jobs'], ['other']]);
  });
  it('moveSection within a column', () => {
    expect(ids(L.moveSection(two(), 'sessions', 1, 0))).toEqual([['jobs'], ['sessions', 'other']]);
  });
  it('addColumn gives the new column 1/n and scales the rest', () => {
    const l = L.addColumn({ ...two(), columns: [{ width: 0.25, sections: ['jobs'] }, { width: 0.75, sections: ['other', 'sessions'] }] });
    expect(l.columns.map((c: any) => +c.width.toFixed(4))).toEqual([0.1667, 0.5, 0.3333]);
    expect(l.columns[2].sections).toEqual([]);
  });
  it('dropEmptyColumns redistributes the removed share proportionally', () => {
    const l = L.dropEmptyColumns({ pinned: {}, columns: [
      { width: 0.2, sections: ['jobs'] }, { width: 0.5, sections: [] }, { width: 0.3, sections: ['other', 'sessions'] },
    ] });
    expect(l.columns.map((c: any) => +c.width.toFixed(4))).toEqual([0.4, 0.6]);
  });
  it('dropEmptyColumns honours a custom emptiness test and keeps one column', () => {
    const l = L.dropEmptyColumns(two(), () => true);
    expect(l.columns).toHaveLength(1);
  });
  it('resizePair keeps the pair sum and clamps at minFraction', () => {
    const l = L.resizePair(two(), 0, 0.1, 0.3);
    expect(l.columns.map((c: any) => +c.width.toFixed(4))).toEqual([0.6, 0.4]);
    const c = L.resizePair(two(), 0, 0.4, 0.3);
    expect(c.columns.map((x: any) => +x.width.toFixed(4))).toEqual([0.7, 0.3]);
    expect(sum(c)).toBeCloseTo(1);
  });
  it('equalizeWidths', () => {
    const l = L.equalizeWidths({ ...two(), columns: [{ width: 0.2, sections: ['jobs'] }, { width: 0.8, sections: ['other', 'sessions'] }] });
    expect(l.columns.map((c: any) => c.width)).toEqual([0.5, 0.5]);
  });
  it('renamePinned trims, caps at 40, empty reverts to Pinned', () => {
    expect(L.renamePinned(withPin(['job:a']), 'p1', '  Replay ').pinned.p1.title).toBe('Replay');
    expect(L.renamePinned(withPin(['job:a']), 'p1', 'y'.repeat(50)).pinned.p1.title).toHaveLength(40);
    expect(L.renamePinned(withPin(['job:a'], 1, 'X'), 'p1', '   ').pinned.p1.title).toBe('Pinned');
  });
  it('prunedLayout drops dead keys and emptied pins', () => {
    const l = withPin(['job:gone', 'job:a']);
    l.pinned.p2 = { title: 'Pinned', rows: ['session:dead'] };
    l.columns[0].sections.push('pin:p2');
    const p = L.prunedLayout(l, new Set(['job:a']));
    expect(p.pinned).toEqual({ p1: { title: 'Pinned', rows: ['job:a'] } });
    expect(ids(p)).toEqual([['jobs'], ['other', 'sessions', 'pin:p1']]);
  });
  it('prunedLayout keeps a renamed pin whose rows all died', () => {
    expect(L.prunedLayout(withPin(['job:gone'], 1, 'Replay'), new Set()).pinned.p1).toEqual({ title: 'Replay', rows: [] });
  });
  it('prunedLayout keeps an empty column — pruning is not a drop', () => {
    const p = L.prunedLayout(L.addColumn(two()), new Set());
    expect(ids(p)).toEqual([['jobs'], ['other', 'sessions'], []]);
  });
  it('mutations never mutate their input', () => {
    const l = withPin(['job:a']);
    const before = JSON.stringify(l);
    L.pinRow(l, 'job:b', { pinId: 'p1', index: 0 });
    L.unpinRow(l, 'job:a');
    L.moveSection(l, 'jobs', 1, 0);
    L.addColumn(l);
    L.renamePinned(l, 'p1', 'z');
    expect(JSON.stringify(l)).toBe(before);
  });
});
