// Cockpit surface (main-only layout) — the home/triage view. Renders the four
// fixed-order groups from vm/cockpit.js fed by approvals + work + sessions +
// schedules + runs, all of which are already loaded at boot (see app.js).
//
// Re-render strategy: every subscribed store notifies far more often than the
// cockpit's own content actually changes (sessions.js in particular mutates on
// every streamed token while a session is thinking). Store ticks are coalesced
// into one paint per animation frame, and each of the four sections compares a
// content signature (excludes the volatile `time` field) against its last
// paint — a tick that doesn't change what a group contains never touches the
// DOM. Row timestamps are refreshed independently on a 30s interval so "3m
// ago" labels don't go stale between content changes.

import { cockpitGroups, sentimentSummary } from '../../vm/cockpit.js';
import { approvals } from '../../state/approvals.js';
import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { schedulesStore } from '../../state/schedules.js';
import { runs } from '../../state/runs.js';
import { nav } from '../../state/nav.js';
import { openScheduleDetail, openRunDetail } from '../../app-bridge.js';
import { escapeHtml } from '../../util.js';
import { relPast, relFuture } from '../../utils/formatting.js';
import { bindRowActivation } from '../../utils/row-activation.js';

const GROUP_DEFS = [
  { key: 'waiting', label: 'Waiting on you', empty: 'Nothing waiting on you.' },
  { key: 'inFlight', label: 'In flight', empty: 'Nothing running right now.' },
  { key: 'upcoming', label: 'Upcoming', empty: 'Nothing scheduled.' },
  { key: 'finished', label: 'Recently finished', empty: 'Nothing finished in the last 24h.' },
];

const TONE_GLYPH = { hot: '●', warn: '◆', busy: '▶', ok: '✓', idle: '↻' };

const TIME_REFRESH_MS = 30_000;

const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);

function glyphFor(tone) {
  return TONE_GLYPH[tone] ?? '○';
}

function fmtRowTime(t, now) {
  if (!t) return '';
  return (t > now ? relFuture(t, now) : relPast(t, now)) ?? '';
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function fmtDate(d) {
  const day = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${clock}`;
}

function pillHtml(p) {
  return `<span class="o-pill ${escapeHtml(p.variant ?? '')}">${escapeHtml(p.label ?? '')}</span>`;
}

function rowHtml(row, now) {
  const ref = row.ref ? `<span class="o-ref">${escapeHtml(row.ref)}</span>` : '';
  const pills = (row.pills ?? []).map(pillHtml).join('');
  return `
    <div class="o-row" data-row-id="${escapeHtml(row.id)}" role="button" tabindex="0">
      <span class="o-row-icon ${escapeHtml(row.tone ?? '')}">${glyphFor(row.tone)}</span>
      <div>
        <div class="o-row-title">${ref}${escapeHtml(row.title ?? '')}</div>
        ${pills ? `<div class="o-row-sub">${pills}</div>` : ''}
      </div>
      <div class="o-row-time" data-time="${row.time ?? 0}">${escapeHtml(fmtRowTime(row.time, now))}</div>
    </div>`;
}

// Excludes `time` on purpose — session/job rows recompute `time` as
// `Date.now()` on every paint, which would defeat any signature comparison.
function rowSignature(row) {
  return [row.id, row.tone, row.title, row.ref, JSON.stringify(row.pills)].join('|');
}

function handleRowClick(row) {
  if (!row) return;
  if (row.kind === 'schedule') { openScheduleDetail(row.open?.id ?? null); return; }
  if (row.kind === 'run') { openRunDetail(row.raw ?? null); return; }
  if (row.open?.surface) nav.select(row.open.surface, row.open.id);
}

function buildSkeleton() {
  return `
    <div class="cockpit-hdr">
      <h1 class="cockpit-greeting"></h1>
      <span class="cockpit-date"></span>
    </div>
    <div class="cockpit-sub"></div>
    ${GROUP_DEFS.map((def) => `
      <div class="cockpit-group" data-group="${def.key}">
        <div class="o-group-hdr">
          <h2>${escapeHtml(def.label)}</h2>
          <span class="o-group-count"></span>
          <span class="o-group-rule"></span>
        </div>
        <div class="cockpit-group-body"></div>
      </div>`).join('')}
  `;
}

function refreshSectionTimes(bodyEl, now) {
  bodyEl.querySelectorAll('.o-row-time[data-time]').forEach((el) => {
    el.textContent = fmtRowTime(Number(el.dataset.time), now);
  });
}

function renderSection(state, rows, now) {
  state.rowsById = new Map(rows.map((r) => [r.id, r]));
  state.countEl.textContent = rows.length ? String(rows.length) : '';

  const nextSig = rows.map(rowSignature).join('\n');
  if (state.sig === nextSig) {
    refreshSectionTimes(state.bodyEl, now);
    return;
  }
  state.sig = nextSig;
  state.bodyEl.innerHTML = rows.length
    ? `<div class="o-row-group">${rows.map((r) => rowHtml(r, now)).join('')}</div>`
    : `<div class="cockpit-empty">${escapeHtml(state.emptyText)}</div>`;
}

export function renderDetail(mount) {
  mount.textContent = '';
  const root = document.createElement('div');
  root.className = 'cockpit-view';
  root.innerHTML = buildSkeleton();
  mount.appendChild(root);

  const greetingEl = root.querySelector('.cockpit-greeting');
  const dateEl = root.querySelector('.cockpit-date');
  const subEl = root.querySelector('.cockpit-sub');

  const sections = new Map(GROUP_DEFS.map((def) => {
    const groupEl = root.querySelector(`[data-group="${def.key}"]`);
    const state = {
      emptyText: def.empty,
      countEl: groupEl.querySelector('.o-group-count'),
      bodyEl: groupEl.querySelector('.cockpit-group-body'),
      rowsById: new Map(),
      sig: null,
    };
    state.bodyEl.addEventListener('click', (e) => {
      const rowEl = e.target.closest('.o-row');
      if (!rowEl) return;
      handleRowClick(state.rowsById.get(rowEl.dataset.rowId));
    });
    bindRowActivation(state.bodyEl);
    return [def.key, state];
  }));

  function paintHeader() {
    greetingEl.textContent = greeting();
    dateEl.textContent = fmtDate(new Date());
  }

  function paint() {
    const now = Date.now();
    const groups = cockpitGroups({
      pendingApprovals: approvals.get().pending,
      jobs: work.get().jobs,
      sessionsById: sessions.get().sessionsById,
      schedules: schedulesStore.get().schedules,
      runs: runs.get().runs,
      now,
    });
    subEl.textContent = sentimentSummary(groups);
    for (const def of GROUP_DEFS) renderSection(sections.get(def.key), groups[def.key] ?? [], now);
  }

  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    raf(() => { scheduled = false; paint(); });
  }

  paintHeader();
  paint();

  const unsubs = [
    approvals.subscribe(scheduleRender),
    work.subscribe(scheduleRender),
    sessions.subscribe(scheduleRender),
    schedulesStore.subscribe(scheduleRender),
    runs.subscribe(scheduleRender),
  ];
  const timer = setInterval(() => {
    paintHeader();
    for (const state of sections.values()) refreshSectionTimes(state.bodyEl, Date.now());
  }, TIME_REFRESH_MS);

  return () => {
    clearInterval(timer);
    for (const unsub of unsubs) unsub();
  };
}
