// "More" tab root — a pushed list screen (not a sheet) holding Skills / Runs
// history / Settings rows with counts (P3 brief: "More tab — a pushed list
// screen"). Rows are the shared .o-row primitive; selecting one hands off to
// the real surface via nav so deep-links and back-navigation stay uniform.

import { actions } from '../../state/actions.js';
import { runs } from '../../state/runs.js';
import { grantsStore, mcpHasWarning } from '../../state/grants.js';
import { nav } from '../../state/nav.js';
import { escapeHtml } from '../../util.js';
import { bindRowActivation } from '../../utils/row-activation.js';

const ROWS = [
  { key: 'skills', label: 'Skills', icon: '◆', desc: 'Browse actions and their permissions.' },
  { key: 'runs', label: 'Runs history', icon: '☰', desc: 'Every session, tracked step, and scheduled run.' },
  { key: 'settings', label: 'Settings', icon: '⚙', desc: 'Theme, density, permissions, notifications.' },
];

function countFor(key) {
  if (key === 'skills') {
    const s = actions.get();
    return s.loaded ? String(s.actions.length) : '';
  }
  if (key === 'runs') {
    const s = runs.get();
    return !s.loading && s.runs.length ? String(s.runs.length) : '';
  }
  if (key === 'settings') {
    return mcpHasWarning(grantsStore.get()) ? '!' : '';
  }
  return '';
}

function rowHtml(row) {
  const count = countFor(row.key);
  return `
    <div class="o-row" data-more-key="${row.key}" role="button" tabindex="0">
      <span class="o-row-icon" aria-hidden="true">${row.icon}</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.label)}</div>
        <div class="o-row-sub">${escapeHtml(row.desc)}</div>
      </div>
      <div class="o-row-time">${escapeHtml(count)}</div>
    </div>
  `;
}

// mount: container to render into. onSelect(key): called when a row is
// tapped — the caller (mobile-shell/index.js) owns nav.setSurface + the
// moreAtRoot flip so this module stays pure presentation.
export function renderMoreRoot(mount, { onSelect }) {
  mount.innerHTML = `<div class="o-row-group m-more-rows">${ROWS.map(rowHtml).join('')}</div>`;
  mount.querySelectorAll('[data-more-key]').forEach((el) => {
    el.addEventListener('click', () => onSelect(el.dataset.moreKey));
  });
  bindRowActivation(mount);

  function refresh() {
    mount.innerHTML = `<div class="o-row-group m-more-rows">${ROWS.map(rowHtml).join('')}</div>`;
    mount.querySelectorAll('[data-more-key]').forEach((el) => {
      el.addEventListener('click', () => onSelect(el.dataset.moreKey));
    });
  }

  const unsubActions = actions.subscribe(refresh);
  const unsubRuns = runs.subscribe(refresh);
  const unsubGrants = grantsStore.subscribe(refresh);
  if (!actions.get().loaded && !actions.get().loading) actions.load();
  return () => { unsubActions(); unsubRuns(); unsubGrants(); };
}
