// Browser-history integration for the mobile shell: hardware/gesture back
// pops one mobile screen (session view → whence it came, drill-in → list,
// More sub-screen → More root) instead of exiting the PWA.
//
// Model: the app's navigation depth is DERIVED from state (nav selections +
// mobile-shell's More drill state + sessions.view), and the history stack is
// reconciled to hold exactly that many entries above the base one, each
// tagged { __mnav: depth }. UI-initiated backs shrink the app depth →
// syncHistory() trims history via history.go(); hardware back moves history
// first → the popstate handler pops app levels down to match. Deriving depth
// (rather than pairing push/pop callbacks) means the two can never drift no
// matter which side moved first, so re-entrant store cascades stay safe.
// Tab switches don't change depth, keeping the stack shallow.

import { nav } from '../../state/nav.js';
import { sessions } from '../../state/sessions.js';
import { isDesktop } from '../../layout/index.js';
import { leaveSession } from '../../app-bridge.js';

let deps = null;
// Count of popstate events we caused ourselves (history.go() in
// syncHistory) — those must not be re-interpreted as user backs.
let pendingPops = 0;
// True while a user back is being applied to app state, so the store
// notifications it cascades don't re-push entries mid-transition.
let poppingApp = false;

// Overlays/sheets that want hardware back to close them instead of popping a
// screen (diff overlay, command palette, sheet-utils' generic sheets) register
// their close function here. LIFO: hardware back closes only the topmost one.
// Importing/calling this is safe with no side effects even when wireHistory()
// was never called (desktop never mounts the mobile shell) — the array just
// sits unused since onPopstate is never wired to the window in that case.
const backHandlers = [];
export function registerBackHandler(closeFn) {
  backHandlers.push(closeFn);
  return () => {
    const i = backHandlers.lastIndexOf(closeFn);
    if (i !== -1) backHandlers.splice(i, 1);
  };
}

function appDepth() {
  if (isDesktop()) return 0;
  const inSession = sessions.get().view === 'session';
  return (deps?.getShellDepth() ?? 0) + (inSession ? 1 : 0);
}

function historyDepth() {
  return history.state?.__mnav ?? 0;
}

function popSessionView() {
  // Runs app.js's full leaveSession() cleanup (git viewer reset, sheets,
  // fromTicketId re-select) via the app-bridge — app.js can't be imported
  // from here directly (cycle).
  leaveSession();
}

function popOne() {
  if (sessions.get().view === 'session') { popSessionView(); return; }
  deps?.popShell();
}

export function syncHistory() {
  if (!deps || poppingApp || pendingPops > 0) return;
  const want = appDepth();
  let have = historyDepth();
  while (have < want) {
    have += 1;
    history.pushState({ __mnav: have }, '');
  }
  if (have > want) {
    pendingPops = have - want;
    history.go(want - have);
  }
}

function onPopstate(event) {
  if (pendingPops > 0) {
    pendingPops -= 1;
    if (pendingPops === 0) syncHistory();
    return;
  }
  // An open overlay/sheet claims this back press: close it and restore the
  // history entry the browser just consumed (app depth hasn't changed, only
  // the overlay closed) so the underlying screen isn't also popped.
  if (backHandlers.length > 0) {
    const closeFn = backHandlers[backHandlers.length - 1];
    closeFn();
    history.pushState({ __mnav: appDepth() }, '');
    return;
  }
  const have = event.state?.__mnav ?? 0;
  poppingApp = true;
  try {
    // Usually one level; a multi-entry jump (long-press back) pops several.
    // The guard breaks out if a pop ever fails to reduce depth.
    let guard = 16;
    while (appDepth() > have && guard-- > 0) {
      const before = appDepth();
      popOne();
      if (appDepth() >= before) break;
    }
  } finally {
    poppingApp = false;
  }
  // Covers the remaining mismatches: forward button (nothing to restore —
  // trim history back down) and a pop that couldn't fully apply.
  syncHistory();
}

// Idempotent: first call wires the listener + store subscriptions for the
// life of the page (the session view outlives shell unmounts, so this is
// deliberately never torn down); later calls just refresh the handlers.
export function wireHistory(handlers) {
  const first = deps === null;
  deps = handlers;
  if (!first) return;
  window.addEventListener('popstate', onPopstate);
  nav.subscribe(syncHistory);
  sessions.subscribe(syncHistory);
  syncHistory();
}
