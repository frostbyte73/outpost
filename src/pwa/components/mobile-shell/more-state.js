// Pure "More" tab state transitions, extracted from index.js so the
// root-vs-drilled branching and the deep-link dedup logic are unit-testable
// without mounting DOM/stores. index.js still owns the actual `moreAtRoot`/
// `lastMoreDeepLinkKey` variables and all DOM mounting — these just compute
// what those variables (and the active screen) should become.

// Cold-boot initial value: land straight on a persisted more-surface
// selection (deep link, last session) instead of forcing the root menu.
export function initMoreAtRoot(surface, moreSurfaces) {
  return !moreSurfaces.includes(surface);
}

// Dedup key for the current nav state's More-surface selection, or null when
// there's nothing to dedup. Callers stamp this on user-initiated navigation
// (More tab tap, More root row tap) — and at boot for whatever selection was
// persisted — so computeMoreDeepLink only fires for selections that arrive
// AFTER, i.e. genuine deep links, never a stale persisted one.
export function deepLinkKeyFor(nav, moreSurfaces) {
  const surface = nav.surface;
  if (!moreSurfaces.includes(surface)) return null;
  const sel = nav.selectionBySurface[surface] ?? null;
  return sel == null ? null : `${surface}:${sel}`;
}

// One-shot dedup for "a More-owned surface just got a selection from outside"
// (deep link, notification tap) — distinct from the user deliberately
// tapping into/out of a surface, which callers apply directly. Keyed by
// surface+selection so backing out to the root (moreAtRoot=true, selection
// still set) doesn't get immediately re-overridden on the next call.
export function computeMoreDeepLink(state, nav, moreSurfaces) {
  const surface = nav.surface;
  if (!moreSurfaces.includes(surface)) {
    return state.lastMoreDeepLinkKey === null ? state : { ...state, lastMoreDeepLinkKey: null };
  }
  const sel = nav.selectionBySurface[surface] ?? null;
  if (sel == null) return state;
  const key = `${surface}:${sel}`;
  if (key === state.lastMoreDeepLinkKey) return state;
  return { moreAtRoot: false, lastMoreDeepLinkKey: key };
}

// Which screen the "more" tab should show, and what moreAtRoot should become
// afterward (the fallback branch forces it back to true — a surface landing
// here that isn't one of the three known More screens shouldn't happen, but
// defensively resolves to the root menu rather than a blank screen).
export function resolveMoreScreen(moreAtRoot, surface) {
  if (moreAtRoot) return { screen: 'more-root', nextMoreAtRoot: true };
  if (surface === 'skills' || surface === 'settings' || surface === 'runs') {
    return { screen: surface, nextMoreAtRoot: false };
  }
  return { screen: 'more-root', nextMoreAtRoot: true };
}
