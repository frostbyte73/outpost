// Shared "⋯" overflow-menu wiring (mobile action-collapse pattern, D6/P3).
// Renderers keep rendering every action inline (desktop keeps seeing a flat
// row via `.o-menu { display: contents }` in primitives.css) — this only
// wires the toggle behavior that mobile's CSS switches on. One tiny module
// instead of re-deriving the same open/close/outside-click logic in
// thread-card.js, schedules/detail.js, and runs-view.js.
//
// At most one menu is open at a time across the whole page — a single
// module-level `openMenu` plus one document-level click listener (registered
// once, not per open) tracks it. Each toggle's click handler closes whatever
// is currently open before opening its own, so a click on a *different*
// toggle's `.o-menu-toggle` can't be starved by the first toggle's
// `stopPropagation()` — the closing happens directly, not via bubbling.

let openMenu = null;

function closeOpenMenu() {
  if (!openMenu) return;
  openMenu.menu.setAttribute('hidden', '');
  openMenu.toggle.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

document.addEventListener('click', closeOpenMenu);

export function wireOverflowMenu(root) {
  root.querySelectorAll('[data-menu-toggle]').forEach((toggle) => {
    const menu = toggle.closest('.o-menu')?.querySelector('.o-menu-body');
    if (!menu) return;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menu.hasAttribute('hidden');
      closeOpenMenu();
      if (opening) {
        menu.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        openMenu = { menu, toggle };
      }
    });
  });
}
