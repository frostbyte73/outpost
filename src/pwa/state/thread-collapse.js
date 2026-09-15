// Which PR review threads the user has folded away, and when. Kept per browser rather than on
// the step: this is a view preference about clutter on a long PR, not a fact about the PR, and
// it has to survive a reload without a round trip.
//
// The value is the TIMESTAMP of the fold, not a boolean — that is what makes a thread come back
// on its own when it gains a reply. A stamp older than the thread's newest message means the
// conversation moved on since you folded it; a thread you have never folded has no entry at all.
// Comment ids are GitHub node ids (`review:<node_id>`, `issue:<node_id>`), globally unique, so
// the map needs no job or step scoping.
//
// No subscribe, unlike the stores next door: a <details> updates itself, and the only other
// reader is the next repaint, which reads this fresh. Folding a thread must not cost a render.

const KEY = 'op:collapsedThreads';

// One entry per thread ever folded, across every PR, for as long as the browser keeps it.
// Trimmed by count rather than by age: an old stamp is precisely the case worth keeping — an
// old PR you folded and want to stay folded.
const MAX_ENTRIES = 1000;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { cache = {}; }
  return cache;
}

function trim(map) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ENTRIES) return map;
  const keep = keys.sort((a, b) => map[b] - map[a]).slice(0, MAX_ENTRIES);
  return Object.fromEntries(keep.map((k) => [k, map[k]]));
}

export function isThreadCollapsed(rootId, newestAt) {
  const at = load()[rootId];
  return typeof at === 'number' && Number(newestAt ?? 0) <= at;
}

export function setThreadCollapsed(rootId, collapsed, at = Date.now()) {
  const next = { ...load() };
  if (collapsed) next[rootId] = at;
  else delete next[rootId];
  cache = trim(next);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
}
