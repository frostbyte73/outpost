import { normalizeEvent } from '../utils/hotkey.js';
import { KEYMAP_COMMANDS, DEFAULT_BINDINGS } from './keymap-commands.js';
import { register, push } from './preferences.js';

// Registry: owns the command catalog, the user's override map, and the
// conflict/validation logic. The handlers keep their own context guards and
// only consult matches()/bindingFor(). Overrides persist as the `hotkeys` key
// in the Spec A preferences blob.

const SURFACE_BY_ID = Object.fromEntries(KEYMAP_COMMANDS.map((c) => [c.id, c.surface]));

// Platform-normalized (mod) reserved combos we refuse to bind — clearly
// destructive / un-interceptable browser & OS shortcuts only. mod+shift+a is
// here because Chrome reserves ⌘⇧A (see commit that rebound session.archive).
const RESERVED = new Set([
  'mod+w', 'mod+t', 'mod+n', 'mod+shift+t', 'mod+shift+n', 'mod+shift+a',
  'mod+q', 'mod+l', 'mod+space', 'mod+tab', 'mod+`', 'mod+=', 'mod+-', 'mod+0',
]);

let overrides = {}; // { commandId: combo }, overrides-only.
const listeners = new Set();
function notify() { for (const fn of listeners) fn(); }

function bindingFor(id) {
  return overrides[id] ?? DEFAULT_BINDINGS[id];
}

function matches(event, id) {
  const want = bindingFor(id);
  if (!want) return false; // unknown id
  return normalizeEvent(event) === want;
}

function hasModifier(combo) {
  return combo.startsWith('mod+') || combo.startsWith('alt+');
}

function isReserved(combo) {
  return RESERVED.has(combo);
}

// The id of a command that would collide with `combo` per the conflict model,
// excluding `id` itself, or null. Conflict iff same combo AND (same surface OR
// either surface is shell).
function conflictFor(combo, id) {
  const surface = SURFACE_BY_ID[id];
  if (!surface) return null;
  for (const c of KEYMAP_COMMANDS) {
    if (c.id === id) continue;
    if (bindingFor(c.id) !== combo) continue;
    if (c.surface === surface || surface === 'shell' || c.surface === 'shell') return c.id;
  }
  return null;
}

function validate(id, combo) {
  const surface = SURFACE_BY_ID[id];
  // Every surface except diff requires a modifier: diff's handler is the only
  // one that guards `!typing`, so a bare-key binding elsewhere (session,
  // palette, shell) would fire while the user is typing in a text field.
  if (surface !== 'diff' && !hasModifier(combo)) return { ok: false, reason: 'modifier' };
  if (isReserved(combo)) return { ok: false, reason: 'reserved' };
  const conflictId = conflictFor(combo, id);
  if (conflictId) return { ok: false, reason: 'conflict', conflictId };
  return { ok: true };
}

function setBinding(id, combo) {
  const result = validate(id, combo);
  if (!result.ok) return result;
  overrides = { ...overrides, [id]: combo };
  notify();
  push('hotkeys', overrides);
  return result;
}

function resetBinding(id) {
  if (!(id in overrides)) return;
  const next = { ...overrides };
  delete next[id];
  overrides = next;
  notify();
  push('hotkeys', overrides);
}

function resetAll() {
  overrides = {};
  notify();
  push('hotkeys', overrides);
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Spec A applier: set the override map from a daemon value WITHOUT pushing
// (no write-echo). Unknown ids are kept but harmlessly ignored by bindingFor.
function applyOverrides(map) {
  overrides = { ...(map ?? {}) };
  notify();
}

register({ key: 'hotkeys', apply: applyOverrides, current: () => overrides });

export const keymap = {
  bindingFor, matches, conflictFor, isReserved, validate,
  setBinding, resetBinding, resetAll, subscribe,
  overridesSnapshot: () => ({ ...overrides }),
};

// Test-only handle for driving the prefs applier directly.
export const __applyOverridesForTest = applyOverrides;
