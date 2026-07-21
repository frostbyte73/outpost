// Shared theme-grid + light/dark mode toggle — migrated out of the mobile
// settings sheet's static markup (index.html) so the desktop Settings surface
// and the mobile sheet render the same 9-theme grid from one source instead
// of duplicating the label/subtitle copy and the select/active-state wiring.
// Markup + classnames (`.theme-grid`, `.theme-card`, `.mode-toggle`) match
// what's already styled in css/mobile.css — reused as-is, no new CSS needed.

import { escapeHtml } from '../util.js';
import { settings } from '../state/settings.js';

export const THEMES = [
  { key: 'halcyon', label: 'Halcyon', sub: 'Cyan · Lavender' },
  { key: 'almanac', label: 'Almanac', sub: 'Amber · Teal' },
  { key: 'terminal', label: 'Terminal', sub: 'Phosphor · Slate' },
  { key: 'nordic', label: 'Nordic', sub: 'Aurora · Heather' },
  { key: 'ink', label: 'Ink', sub: 'Vermillion · Indigo' },
  { key: 'botanical', label: 'Botanical', sub: 'Sage · Terracotta' },
  { key: 'plasma', label: 'Plasma', sub: 'Magenta · Violet' },
  { key: 'atlas', label: 'Atlas', sub: 'Gold · Ocean' },
  { key: 'library', label: 'Library', sub: 'Sage · Burgundy' },
];

function themeCardHtml(t) {
  return `<button class="theme-card" data-theme-key="${t.key}" type="button">
    <div class="preview-stripe">
      <span class="swatch s1"></span><span class="swatch s2"></span><span class="swatch s3"></span><span class="swatch s4"></span>
    </div>
    <div class="preview-text">${escapeHtml(t.label)}</div>
    <div class="preview-sub">${escapeHtml(t.sub)}</div>
  </button>`;
}

// Keep <meta name="theme-color"> in sync with the active theme's --bg so the iOS
// Safari address bar / PWA status bar tint matches when the user switches palette.
export function syncThemeColorMeta() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

function paintThemeSelection(container) {
  const theme = settings.get().theme;
  for (const card of container.querySelectorAll('.theme-card')) {
    card.classList.toggle('selected', card.dataset.themeKey === theme);
  }
}

// Renders the 9-card grid into `container` (any element — gets `.theme-grid`
// added if not already present) and keeps it live against settings changes.
// Returns an unmount function.
export function renderThemeGrid(container) {
  container.classList.add('theme-grid');
  container.innerHTML = THEMES.map(themeCardHtml).join('');
  const onClick = (e) => {
    const card = e.target.closest('.theme-card');
    if (!card?.dataset.themeKey) return;
    settings.setTheme(card.dataset.themeKey);
    syncThemeColorMeta();
  };
  container.addEventListener('click', onClick);
  paintThemeSelection(container);
  const unsub = settings.subscribe(() => paintThemeSelection(container));
  return () => { container.removeEventListener('click', onClick); unsub(); };
}

function paintModeSelection(container) {
  const mode = settings.get().mode;
  for (const btn of container.querySelectorAll('button[data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

// Renders the light/dark segmented toggle into `container`. Returns an unmount.
export function renderModeToggle(container) {
  container.classList.add('mode-toggle');
  container.innerHTML = `
    <button data-mode="light" type="button"><span class="glyph"></span>Light</button>
    <button data-mode="dark" type="button"><span class="glyph"></span>Dark</button>
  `;
  const onClick = (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn?.dataset.mode) return;
    settings.setMode(btn.dataset.mode);
    syncThemeColorMeta();
  };
  container.addEventListener('click', onClick);
  paintModeSelection(container);
  const unsub = settings.subscribe(() => paintModeSelection(container));
  return () => { container.removeEventListener('click', onClick); unsub(); };
}
