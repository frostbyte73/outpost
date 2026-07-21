import { mountSidebar } from './sidebar.js';
import { mountSurfaceFrame } from './surfaces.js';
import { installKeyboard } from './keyboard.js';
import { installTitleObserver } from './title-observer.js';

// Desktop shell root: a single [sidebar | frame] row. Replaces the old
// activity-rail / list-rail / workspace(pane-tree) / usage-strip mount (D1 of
// the UX redesign) — those modules were deleted in P4. The persistent topbar
// (⌘K command bar / running pill / avatar) was removed too: ⌘K opens the
// palette, the running count lives on the sidebar's Sessions item, and the
// account-usage widget sits at the sidebar foot.
//
// app.js's #header/#root are `const`-captured once at boot and handed to
// mobile-shell/session-view on every mobile render — they can never be
// reassigned, so a desktop mount can't just discard them. mountShell stashes
// whatever #app's children were (first boot: the static #header/#root pair;
// any later mount: same two nodes, just repopulated by mobile-shell) and
// unmountShell() puts them back verbatim, so a desktop→mobile flip resumes
// mounting into the SAME nodes app.js already holds references to instead of
// leaving them detached (the prior bug: a blank mobile view after a
// mobile→desktop→mobile round trip).

let mounted = false;
let stashedNodes = null;
let unmountSidebar = null;
let unmountFrame = null;

export function mountShell(root) {
  if (mounted) return;
  mounted = true;

  stashedNodes = [...root.childNodes];
  for (const n of stashedNodes) root.removeChild(n);

  const body = document.createElement('div');
  body.className = 'o-shell-body';
  const sidebar = document.createElement('aside');
  const frame = document.createElement('div');
  body.appendChild(sidebar);
  body.appendChild(frame);
  root.appendChild(body);

  unmountSidebar = mountSidebar(sidebar) ?? null;
  unmountFrame = mountSurfaceFrame(frame) ?? null;
  // Idempotent + document-scoped (not tied to any node this module owns) —
  // installed once and left running across layout flips by design.
  installKeyboard();
  installTitleObserver();
}

export function unmountShell(root) {
  if (!mounted) return;
  mounted = false;

  try { unmountSidebar?.(); } catch { /* ignore */ }
  try { unmountFrame?.(); } catch { /* ignore */ }
  unmountSidebar = null; unmountFrame = null;

  root.textContent = '';
  if (stashedNodes) {
    for (const n of stashedNodes) root.appendChild(n);
    stashedNodes = null;
  }
}
