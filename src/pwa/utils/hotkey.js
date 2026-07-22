// Pure combo <-> KeyboardEvent helpers. The sole place a KeyboardEvent becomes
// a normalized combo string, so keymap.matches() and the settings recorder can
// never diverge. No DOM, no store reads.

export function isMac() {
  const p = (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '';
  return /mac|iphone|ipad/i.test(p);
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph']);

// Canonical special-key names (the raw KeyboardEvent.key on the left).
function keyName(raw) {
  if (raw === ' ') return 'space';
  return raw.toLowerCase();
}

export function normalizeEvent(event, mac = isMac()) {
  const raw = event.key;
  if (raw == null || MODIFIER_KEYS.has(raw)) return null;
  const parts = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(keyName(raw));
  return parts.join('+');
}

const MAC_MOD = { mod: '⌘', alt: '⌥', shift: '⇧' };
const PC_MOD = { mod: 'Ctrl', alt: 'Alt', shift: '⇧' };
const KEY_GLYPH = { enter: '↵', space: 'Space', tab: '⇥', escape: 'Esc' };

export function formatCombo(combo, mac = isMac()) {
  const mods = mac ? MAC_MOD : PC_MOD;
  const parts = combo.split('+');
  const key = parts.pop();
  const out = parts.map((m) => mods[m] ?? m);
  out.push(KEY_GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return out.join('');
}
