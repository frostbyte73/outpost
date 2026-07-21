// Tab bar definitions + derived counts. Kept separate from index.js (the
// mounter) so the "what counts as which tab" logic is easy to find and test
// independent of DOM wiring.

import { approvals } from '../../state/approvals.js';
import { work } from '../../state/work.js';
import { cockpitGroups } from '../../vm/cockpit.js';

export const PRIMARY_SURFACES = ['cockpit', 'tracked', 'sessions', 'schedules'];
export const MORE_SURFACES = ['skills', 'runs', 'settings'];

export const TABS = [
  { key: 'cockpit', label: 'Cockpit', icon: '◈' },
  { key: 'tracked', label: 'Tracked', icon: '◨' },
  { key: 'sessions', label: 'Sessions', icon: '◇' },
  { key: 'schedules', label: 'Schedules', icon: '↻' },
  { key: 'more', label: 'More', icon: '≡' },
];

// Which bottom-tab a nav surface belongs under. Anything not in
// PRIMARY_SURFACES/MORE_SURFACES (shouldn't happen — nav.js sanitizes to
// KNOWN_SURFACES) falls back to cockpit rather than highlighting nothing.
export function tabForSurface(surface) {
  if (PRIMARY_SURFACES.includes(surface)) return surface;
  if (MORE_SURFACES.includes(surface)) return 'more';
  return 'cockpit';
}

// Cockpit tab badge: same "waiting on you" count the Cockpit surface itself
// leads with — one derivation (vm/cockpit.js), two presentations (badge vs.
// group header).
export function waitingOnYouCount() {
  const groups = cockpitGroups({
    pendingApprovals: approvals.get().pending,
    jobs: work.get().jobs,
    now: Date.now(),
  });
  return groups.waiting.length;
}
