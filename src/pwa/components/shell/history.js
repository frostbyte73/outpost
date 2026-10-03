// Browser back/forward for the desktop shell. A page is the active surface plus its selection,
// both held by the nav store, so every change of that pair pushes one history entry and popstate
// restores it — which is what makes mouse side buttons, trackpad swipe, Alt+← and ⌘[ work, the
// installed app window included. Store changes that don't move the page (list width, density,
// collapsing a pane) push nothing.
//
// Mobile owns history through mobile-shell/history.js (a depth model, tagged __mnav). Both stay
// wired across layout flips, so this side acts only while the layout is desktop, and its entries
// carry no __mnav — mobile reads those as depth 0, which is what desktop always is to it.

import { nav } from '../../state/nav.js';
import { isDesktop } from '../../layout/index.js';

const page = (s) => ({ surface: s.surface, id: s.selectionBySurface[s.surface] ?? null });
const samePage = (a, b) => !!b && a.surface === b.surface && a.id === b.id;

let installed = false;
let restoring = false;

function onNav(s) {
  if (restoring || !isDesktop()) return;
  const p = page(s);
  if (samePage(p, history.state?.__page)) return;
  // The first page claims the entry it lands on instead of stacking a second one above it. Any
  // __mnav it held is dropped on purpose: on desktop, mobile's depth is 0, i.e. no tag at all.
  if (history.state?.__page) history.pushState({ __page: p }, '');
  else history.replaceState({ __page: p }, '');
}

function onPopstate(e) {
  const p = e.state?.__page;
  if (!p || !isDesktop()) return;
  restoring = true;
  try { nav.select(p.surface, p.id); } finally { restoring = false; }
}

// Idempotent + document-scoped, like installKeyboard: installed once, left running across flips.
export function installHistory() {
  if (installed) return;
  installed = true;
  window.addEventListener('popstate', onPopstate);
  nav.subscribe(onNav);
  onNav(nav.get());
}
