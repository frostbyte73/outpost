import { schedulesStore } from '../../state/schedules.js';
import { nav } from '../../state/nav.js';
import { scheduleCards, filterScheduleCards, systemScheduleCards } from '../../vm/schedules.js';
import { escapeHtml } from '../../util.js';
import { createSwitch } from './switch.js';
import { startScheduleDraft } from './draft.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'cron', label: 'Cron' },
  { id: 'once', label: 'Once' },
  { id: 'token', label: 'Token' },
  { id: 'event', label: 'Event' },
  { id: 'system', label: 'System' },
];

export function renderList(mount) {
  mount.textContent = '';
  mount.classList.add('sched-list');

  let tab = 'all';
  let filter = '';

  const hdr = document.createElement('div');
  hdr.className = 'sched-list-hdr';
  const filterbar = document.createElement('div');
  filterbar.className = 'o-list-filterbar sched-list-searchbar';
  filterbar.innerHTML = '<input type="search" class="o-list-filter sched-list-search" placeholder="Filter schedules…" aria-label="Filter schedules">';
  const body = document.createElement('div');
  body.className = 'sched-list-body';
  // Keyboard activation for the div-based cards. Not utils/row-activation.js:
  // its delegate would also swallow Enter/Space aimed at the card's embedded
  // pause switch (a real <button role="switch">), so skip interactive targets.
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    const card = e.target.closest('.sched-card[role="button"]');
    if (!card) return;
    e.preventDefault();
    card.click();
  });
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'sched-new-btn';
  newBtn.textContent = '+ New schedule';
  newBtn.addEventListener('click', () => startScheduleDraft());
  mount.appendChild(hdr);
  mount.appendChild(filterbar);
  mount.appendChild(body);
  mount.appendChild(newBtn);

  filterbar.querySelector('.sched-list-search').addEventListener('input', (e) => {
    filter = e.target.value;
    paint();
  });

  function paintHeader(schedules) {
    const activeCount = schedules.filter((s) => s.enabled).length;
    const pausedCount = schedules.length - activeCount;
    hdr.innerHTML = `
      <div class="sched-list-hdr-row">
        <h2>Schedules</h2>
        <span class="sched-list-count">${activeCount} active · ${pausedCount} paused</span>
      </div>
      <div class="sched-tabs" role="tablist">
        ${TABS.map((t) => `<button type="button" class="sched-tab${t.id === tab ? ' active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === tab}">${t.label}</button>`).join('')}
      </div>
    `;
    for (const btn of hdr.querySelectorAll('.sched-tab')) {
      btn.addEventListener('click', () => { tab = btn.dataset.tab; paint(); });
    }
  }

  function matchesFilter(c, needle) {
    return [c.name, c.when, c.descriptor, c.what?.label ?? '']
      .some((v) => v.toLowerCase().includes(needle));
  }

  function matchesSystemFilter(c, needle) {
    return [c.name, c.description ?? '', c.intervalLabel].some((v) => v.toLowerCase().includes(needle));
  }

  // Read-only card for a built-in poller: interval + last/next run + last error, plus a
  // run-now button. No enable toggle, cron edit, delete, or navigation — not user-owned.
  function renderSystemCard(c) {
    const card = document.createElement('div');
    card.className = 'sched-card sched-card--system';
    card.innerHTML = `
      <div class="sched-hdr">
        <span class="sched-source-icon">⚙</span>
        <span class="sched-name">${escapeHtml(c.name)}</span>
        <span class="o-pill sched-system-pill">system</span>
      </div>
      ${c.description ? `<div class="sched-when">${escapeHtml(c.description)}</div>` : ''}
      <div class="sched-descriptor">${escapeHtml(c.intervalLabel)}</div>
      <div class="sched-sys-status">
        <span>Last run ${escapeHtml(c.lastRunSummary)}</span>
        ${c.nextRunSummary ? `<span>· Next ${escapeHtml(c.nextRunSummary)}</span>` : ''}
      </div>
      ${c.lastError ? `<div class="sched-sys-error" role="alert">⚠ ${escapeHtml(c.lastError)}</div>` : ''}
      <div class="sched-sys-actions">
        <button type="button" class="o-btn o-btn--default sched-sys-run">Run now</button>
      </div>
    `;
    const runBtn = card.querySelector('.sched-sys-run');
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      try { await schedulesStore.runNowSystem(c.id); }
      finally { await schedulesStore.load(); }
    });
    return card;
  }

  function sectionHeader(label) {
    const el = document.createElement('div');
    el.className = 'sched-section-hdr';
    el.textContent = label;
    return el;
  }

  function renderCard(c, active) {
    const card = document.createElement('div');
    card.className = `sched-card${active ? ' active' : ''}${c.dimmed ? ' disabled' : ''}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', () => nav.select('schedules', c.id));
    card.innerHTML = `
      <div class="sched-hdr">
        <span class="sched-source-icon">${c.sourceKind === 'event' ? '◆' : c.sourceKind === 'once' ? '◷' : c.sourceKind === 'token' ? '⚡' : '↻'}</span>
        <span class="sched-name">${escapeHtml(c.name)}</span>
      </div>
      <div class="sched-when">${escapeHtml(c.when)}</div>
      <div class="sched-descriptor">${escapeHtml(c.descriptor)}</div>
      ${c.what?.label ? `<span class="o-pill${c.what.mono ? ' code' : ''} sched-skill-pill">${c.what.kind === 'skill' ? '' : `${escapeHtml(c.what.kind)} · `}${escapeHtml(c.what.label)}</span>` : ''}
      ${c.nextRunSummary ? `<div class="sched-next${c.enabled ? '' : ' paused'}"><span class="dot"></span>${escapeHtml(c.nextRunSummary)}</div>` : ''}
    `;
    const toggle = createSwitch(c.enabled, async (next) => {
      try { await schedulesStore.update(c.id, { enabled: next }); }
      catch { toggle.set(!next); }
    }, `${c.enabled ? 'Pause' : 'Resume'} ${c.name}`);
    card.querySelector('.sched-hdr').appendChild(toggle);
    return card;
  }

  function paint() {
    const { schedules, system, loaded, loading } = schedulesStore.get();
    paintHeader(schedules);
    const now = Date.now();
    const needle = filter.trim().toLowerCase();

    let cards = filterScheduleCards(scheduleCards(schedules, now), tab);
    if (needle) cards = cards.filter((c) => matchesFilter(c, needle));

    // System pollers show in their own tab and inline in "All"; the trigger-kind
    // tabs (cron/once/event) are about user-owned schedules only.
    const showSystem = tab === 'all' || tab === 'system';
    let sysCards = showSystem ? systemScheduleCards(system ?? [], now) : [];
    if (needle) sysCards = sysCards.filter((c) => matchesSystemFilter(c, needle));

    body.textContent = '';
    if (!loaded && loading) {
      const el = document.createElement('div');
      el.className = 'o-frame-empty';
      el.textContent = 'Loading schedules…';
      body.appendChild(el);
      return;
    }

    if (cards.length === 0 && sysCards.length === 0) {
      const el = document.createElement('div');
      el.className = 'o-frame-empty';
      const nothing = schedules.length === 0 && (system?.length ?? 0) === 0;
      el.textContent = nothing ? 'No schedules yet.' : 'No schedules match this filter.';
      body.appendChild(el);
      return;
    }

    const selected = nav.get().selectionBySurface.schedules ?? null;
    // In "All", user schedules lead and system pollers follow under a divider; in the
    // dedicated "System" tab, only the pollers show (no header needed).
    if (tab === 'system') {
      for (const c of sysCards) body.appendChild(renderSystemCard(c));
      return;
    }
    for (const c of cards) body.appendChild(renderCard(c, c.id === selected));
    if (sysCards.length) {
      if (cards.length) body.appendChild(sectionHeader('System'));
      for (const c of sysCards) body.appendChild(renderSystemCard(c));
    }
  }

  paint();
  const unsubStore = schedulesStore.subscribe(paint);
  const unsubNav = nav.subscribe(paint);
  if (!schedulesStore.get().loaded && !schedulesStore.get().loading) schedulesStore.load();
  return () => { unsubStore(); unsubNav(); };
}
