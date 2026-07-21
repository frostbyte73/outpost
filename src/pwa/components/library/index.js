// Library surfaces: Skills catalog (list+detail) and Runs history (main-only).
// Split into skills-list.js / skills-detail.js / runs-view.js to keep each
// file focused; this module is just the registry-facing barrel plus the one
// piece of cross-surface wiring that has to happen somewhere at boot.

export { renderList as renderSkillsList } from './skills-list.js';
export { renderDetail as renderSkillsDetail } from './skills-detail.js';
export { renderDetail as renderRunsDetail } from './runs-view.js';

import { installAppBridge, openScheduleDetail } from '../../app-bridge.js';
import { nav } from '../../state/nav.js';

// Fills the app-bridge's `openRunDetail` key (reserved in app-bridge.js for
// whichever P2 agent owns Runs history). This module is imported eagerly by
// shell/surfaces.js's top-level imports, so the registration below always
// runs during boot's synchronous import cascade — well before any row click
// could fire — meaning no other file needs to touch app-bridge.js's install
// call site to wire this up.
installAppBridge({
  openRunDetail(run) {
    const refs = run?.refs ?? {};
    if (refs.sessionId) { nav.select('sessions', refs.sessionId); return; }
    if (refs.jobId) { nav.select('tracked', refs.jobId); return; }
    if (refs.scheduleId) { openScheduleDetail(refs.scheduleId); return; }
  },
});
