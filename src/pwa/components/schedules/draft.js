import { nav } from '../../state/nav.js';

// Sentinel selection prefix for a not-yet-persisted schedule. detail.js renders a
// draft editor for any id matching this; the schedule is POSTed only once
// draftValidity passes. Each launch gets a UNIQUE id (`__new__:N`) so that
// re-launching while already on the draft pane still changes the selection value
// — the shell's list-detail frame only re-renders detail when the selection
// value changes (surfaces.js/screens.js), so a fixed sentinel would swallow a
// second "+ New" (or a palette/library launch) and strand its seed.
export const DRAFT_PREFIX = '__new__';

export function isDraftId(id) {
  return typeof id === 'string' && (id === DRAFT_PREFIX || id.startsWith(`${DRAFT_PREFIX}:`));
}

// Single-consume handoff of the seed from "+ New schedule" (or a prefill caller)
// to the detail pane's renderer — mirrors nav.js's setSessionHint/peekSessionHint.
let pendingSeed = null;
let seq = 0;

function buildSeed(prefill) {
  const seed = { name: '', trigger: null, what: null, guards: [], routing: {} };
  if (!prefill) return seed;
  if (prefill.prompt) {
    seed.name = prefill.prompt.slice(0, 60);
    seed.what = { kind: 'prompt', prompt: prefill.prompt, cwd: prefill.cwd ?? '', ...(prefill.model ? { model: prefill.model } : {}) };
  } else if (prefill.skill) {
    seed.what = { kind: 'skill', skill: prefill.skill };
  }
  return seed;
}

export function startScheduleDraft(prefill = null) {
  pendingSeed = buildSeed(prefill);
  nav.select('schedules', `${DRAFT_PREFIX}:${++seq}`);
}

export function consumeDraftSeed() {
  const seed = pendingSeed;
  pendingSeed = null;
  return seed;
}
