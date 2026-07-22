import { nav, KNOWN_SURFACES } from '../../state/nav.js';
import { isDesktop } from '../../layout/index.js';
import { openPalette, isPaletteOpen, closePalette } from '../palette/index.js';
import { keymap } from '../../state/keymap.js';

// Desktop shell keymap. Replaces the tab/pane-era bindings (⌘T/⌘W/⌘P/⌘\/⌘⇧T
// and pane-focus arrows) — there's nothing left to tab/split/close now that
// each surface shows one thing at a time.

// Sidebar order == ⌘1..7 jump order (top items, then Library, then Settings).
const JUMP_ORDER = ['cockpit', 'tracked', 'sessions', 'schedules', 'skills', 'runs', 'settings'];

let installed = false;

export function installKeyboard() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onKey);
}

// Esc-closes-popovers isn't handled here — each popover (usage widget, the
// palette to come) installs its own document-level Esc/outside-click listener
// so it closes correctly even when this module isn't the active shell (mobile
// has its own sheets/popovers with the same self-managed pattern).
function onKey(e) {
  if (!isDesktop()) return;

  // The palette owns the keymap while it's open (its own Esc/⌘⇧D handlers are
  // self-installed) — only togglePalette is honored underneath it.
  if (isPaletteOpen() && !keymap.matches(e, 'shell.togglePalette')) return;

  if (keymap.matches(e, 'shell.togglePalette')) return openPaletteShortcut(e);
  if (keymap.matches(e, 'shell.toggleSidebar')) return toggleSidebar(e);
  if (keymap.matches(e, 'shell.focusFilter')) return focusListFilter(e);
  for (let i = 0; i < JUMP_ORDER.length; i++) {
    if (keymap.matches(e, `shell.jump.${JUMP_ORDER[i]}`)) return jumpToSurface(e, i + 1);
  }
}

// ⌘K toggles: standard command-palette behavior, not open-only.
function openPaletteShortcut(e) {
  e.preventDefault();
  if (isPaletteOpen()) closePalette();
  else openPalette();
}

function toggleSidebar(e) {
  e.preventDefault();
  nav.toggleSidebarCollapsed();
}

function focusListFilter(e) {
  // Some list columns render their own search field (e.g. Skills'
  // .lib-search-input) without the shared class — any search input in the
  // list column is a valid ⌘F target.
  const input = document.querySelector('.o-frame-list .o-list-filter')
    ?? document.querySelector('.o-frame-list input[type="search"]');
  if (!input) return;
  e.preventDefault();
  input.focus();
  input.select?.();
}

function jumpToSurface(e, n) {
  const key = JUMP_ORDER[n - 1];
  if (!key || !KNOWN_SURFACES.includes(key)) return;
  e.preventDefault();
  nav.setSurface(key);
}
