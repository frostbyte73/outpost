// Cockpit layout: which sections sit in which column and which rows are pinned where. Zero DOM.

export const BUILTINS = ['jobs', 'sessions', 'other'];
export const MIN_COLUMN_PX = 360;
export const GUTTER_PX = 24;
export const PIN_TITLE_MAX = 40;
export const DEFAULT_PIN_TITLE = 'Pinned';

const BUILTIN_TITLE = { jobs: 'Jobs', sessions: 'Sessions', other: 'Other' };
const PIN_ID = /^[\w-]{1,64}$/;
const PINNABLE = /^(job|session):./;

const pinSection = (id) => `pin:${id}`;
const pinIdOf = (sectionId) => (sectionId.startsWith('pin:') ? sectionId.slice(4) : null);

export function isPinnableKey(key) {
  return typeof key === 'string' && PINNABLE.test(key);
}

// A renamed pin outlives its rows; only the user's × removes it then.
export function isNamedPin(pin) {
  return pin.title !== DEFAULT_PIN_TITLE;
}

export function newPinId() {
  return crypto.randomUUID().slice(0, 8);
}

export function defaultLayout(boardWidthPx) {
  const fitsTwo = boardWidthPx >= 2 * MIN_COLUMN_PX + GUTTER_PX;
  return fitsTwo
    ? { columns: [{ width: 0.5, sections: ['jobs'] }, { width: 0.5, sections: ['other', 'sessions'] }], pinned: {} }
    : { columns: [{ width: 1, sections: ['jobs', 'other', 'sessions'] }], pinned: {} };
}

export function clampTitle(title) {
  const t = typeof title === 'string' ? title.trim().slice(0, PIN_TITLE_MAX).trim() : '';
  return t || DEFAULT_PIN_TITLE;
}

function widthsValid(widths) {
  if (!widths.length || !widths.every((w) => Number.isFinite(w) && w > 0)) return false;
  return Math.abs(widths.reduce((a, b) => a + b, 0) - 1) <= 0.01;
}

function scaleToOne(columns) {
  const total = columns.reduce((a, c) => a + c.width, 0);
  if (!(total > 0)) return equalize(columns);
  return columns.map((c) => ({ ...c, width: c.width / total }));
}

function equalize(columns) {
  return columns.map((c) => ({ ...c, width: 1 / columns.length }));
}

// Repairs anything a stale, hand-edited or concurrently-written layout can hold.
export function normalizeLayout(raw, boardWidthPx) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.columns)) return defaultLayout(boardWidthPx);
  const rawPinned = raw.pinned && typeof raw.pinned === 'object' ? raw.pinned : {};
  const seenSections = new Set();
  const seenRows = new Set();
  const pinned = {};
  const rawWidths = raw.columns.map((c) => Number(c?.width));
  let columns = raw.columns.map((c, i) => {
    const sections = [];
    for (const id of Array.isArray(c?.sections) ? c.sections : []) {
      if (typeof id !== 'string' || seenSections.has(id)) continue;
      const pinId = pinIdOf(id);
      if (pinId === null) {
        if (!BUILTINS.includes(id)) continue;
      } else {
        const p = PIN_ID.test(pinId) ? rawPinned[pinId] : null;
        if (!p || typeof p !== 'object') continue;
        const rows = (Array.isArray(p.rows) ? p.rows : []).filter((k) => isPinnableKey(k) && !seenRows.has(k));
        const pin = { title: clampTitle(p.title), rows };
        if (!rows.length && !isNamedPin(pin)) continue;
        for (const k of rows) seenRows.add(k);
        pinned[pinId] = pin;
      }
      seenSections.add(id);
      sections.push(id);
    }
    return { width: rawWidths[i], sections };
  });
  if (!columns.length) columns = [{ width: 1, sections: [] }];
  for (const b of BUILTINS) if (!seenSections.has(b)) columns[0].sections.push(b);
  const valid = widthsValid(rawWidths) && rawWidths.length === columns.length;
  return { columns: valid ? columns : equalize(columns), pinned };
}

function needYouOf(rows, kind) {
  return rows.filter((r) => (kind === 'other' ? r.tone === 'you' : r.actions.length > 0)).length;
}

// Turns the board VM into columns → sections → rows; dead pin keys are skipped, never pruned here.
export function resolveBoard(board, layout) {
  const byKey = new Map([...board.started, ...board.notStarted, ...board.sessions].map((r) => [r.key, r]));
  const pinnedKeys = new Set(Object.values(layout.pinned).flatMap((p) => p.rows));
  const free = (rows) => rows.filter((r) => !pinnedKeys.has(r.key));
  const resolveSection = (id) => {
    if (id === 'jobs') {
      const groups = { started: free(board.started), notStarted: free(board.notStarted) };
      const needYou = needYouOf([...groups.started, ...groups.notStarted], 'jobs');
      return { id, kind: 'jobs', title: BUILTIN_TITLE.jobs, needYou, groups };
    }
    if (id === 'sessions' || id === 'other') {
      const rows = id === 'sessions' ? free(board.sessions) : board.other;
      return { id, kind: id, title: BUILTIN_TITLE[id], needYou: needYouOf(rows, id), rows };
    }
    const pin = layout.pinned[pinIdOf(id)];
    const rows = pin.rows.map((k) => byKey.get(k)).filter(Boolean);
    if (!rows.length && !isNamedPin(pin)) return null;
    return { id, kind: 'pinned', pinId: pinIdOf(id), title: pin.title, needYou: needYouOf(rows, 'pinned'), rows };
  };
  return {
    columns: layout.columns.map((c) => ({ width: c.width, sections: c.sections.map(resolveSection).filter(Boolean) })),
  };
}

export function liveKeys(board) {
  return new Set([...board.started, ...board.notStarted, ...board.sessions].map((r) => r.key));
}

function clone(layout) {
  return {
    columns: layout.columns.map((c) => ({ width: c.width, sections: [...c.sections] })),
    pinned: Object.fromEntries(Object.entries(layout.pinned).map(([id, p]) => [id, { title: p.title, rows: [...p.rows] }])),
  };
}

function dropPin(l, pinId) {
  delete l.pinned[pinId];
  for (const c of l.columns) c.sections = c.sections.filter((s) => s !== pinSection(pinId));
}

function removeRow(l, rowKey, { keep } = {}) {
  for (const [id, p] of Object.entries(l.pinned)) {
    if (!p.rows.includes(rowKey)) continue;
    p.rows = p.rows.filter((k) => k !== rowKey);
    if (!p.rows.length && id !== keep && !isNamedPin(p)) dropPin(l, id);
  }
}

export function prunedLayout(layout, live) {
  const l = clone(layout);
  for (const [id, p] of Object.entries(l.pinned)) {
    p.rows = p.rows.filter((k) => live.has(k));
    if (!p.rows.length && !isNamedPin(p)) dropPin(l, id);
  }
  return l;
}

export function moveSection(layout, sectionId, toCol, toIndex) {
  const l = clone(layout);
  for (const c of l.columns) c.sections = c.sections.filter((s) => s !== sectionId);
  l.columns[toCol].sections.splice(toIndex, 0, sectionId);
  return l;
}

// target is { pinId, index } to join (or reorder within) a pin, or { newAt: { col, index } } to start one.
export function pinRow(layout, rowKey, target) {
  if (!isPinnableKey(rowKey)) return { layout, pinId: null };
  const l = clone(layout);
  if (target.pinId) {
    removeRow(l, rowKey, { keep: target.pinId });
    l.pinned[target.pinId].rows.splice(target.index, 0, rowKey);
    return { layout: l, pinId: target.pinId };
  }
  removeRow(l, rowKey);
  const pinId = newPinId();
  l.pinned[pinId] = { title: DEFAULT_PIN_TITLE, rows: [rowKey] };
  l.columns[target.newAt.col].sections.splice(target.newAt.index, 0, pinSection(pinId));
  return { layout: l, pinId };
}

export function removePin(layout, pinId) {
  const l = clone(layout);
  dropPin(l, pinId);
  return l;
}

export function unpinRow(layout, rowKey) {
  const l = clone(layout);
  removeRow(l, rowKey);
  return l;
}

export function addColumn(layout) {
  const l = clone(layout);
  const n = l.columns.length + 1;
  l.columns = [...l.columns.map((c) => ({ ...c, width: (c.width * (n - 1)) / n })), { width: 1 / n, sections: [] }];
  return l;
}

export function dropEmptyColumns(layout, isEmpty = (c) => c.sections.length === 0) {
  const kept = layout.columns.filter((c) => !isEmpty(c));
  const columns = kept.length ? kept : [layout.columns[0]];
  return { ...layout, columns: scaleToOne(columns.map((c) => ({ width: c.width, sections: [...c.sections] }))) };
}

export function resizePair(layout, leftCol, deltaFraction, minFraction) {
  const l = clone(layout);
  const a = l.columns[leftCol];
  const b = l.columns[leftCol + 1];
  const pair = a.width + b.width;
  a.width = Math.min(pair - minFraction, Math.max(minFraction, a.width + deltaFraction));
  b.width = pair - a.width;
  return l;
}

export function equalizeWidths(layout) {
  return { ...clone(layout), columns: equalize(clone(layout).columns) };
}

export function renamePinned(layout, pinId, title) {
  const l = clone(layout);
  if (l.pinned[pinId]) l.pinned[pinId].title = clampTitle(title);
  return l;
}
