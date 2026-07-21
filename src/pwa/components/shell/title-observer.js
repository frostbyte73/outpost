import { nav } from '../../state/nav.js';

// Reflect the active surface (+ selection) into the browser tab title so
// multi-window setups can tell them apart by tab bar alone.

const SURFACE_TITLES = {
  cockpit: 'Cockpit',
  tracked: 'Tracked',
  sessions: 'Sessions',
  schedules: 'Schedules',
  skills: 'Skills',
  runs: 'Runs history',
  settings: 'Settings',
};

let installed = false;

export function installTitleObserver() {
  if (installed) return;
  installed = true;

  const update = () => {
    const { surface } = nav.get();
    const label = SURFACE_TITLES[surface] ?? surface;
    document.title = `Outpost — ${label}`;
  };
  update();
  nav.subscribe(update);
}
