// Schedules surface (list-detail layout). Wired into shell/surfaces.js's
// registry — see list.js/detail.js for the real renderers; this file is just
// the thin re-export surfaces.js imports from.

export { renderList } from './list.js';
export { renderDetail } from './detail.js';
