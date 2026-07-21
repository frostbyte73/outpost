import { nav } from '../../state/nav.js';
import { approvals } from '../../state/approvals.js';
import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { schedulesStore, enabledScheduleCount } from '../../state/schedules.js';
import { usage } from '../../state/usage.js';
import { usageTier, clampPct, usagePopoverHtml } from '../../utils/usage-bar.js';
import { fmtRemaining } from '../../utils/formatting.js';
import { needsYou, isTerminalJob } from '../../vm/work-predicates.js';

// Sidebar taxonomy per the redesign spec: Cockpit / Tracked / Sessions /
// Schedules, a Library group (Skills / Runs history), Settings pinned at the
// foot with the account-usage widget beneath it. Replaces activity-rail.js's
// 4-item icon-only nav.
//
// Tier math + popover markup live in utils/usage-bar.js — the mobile header's
// compact usage widget reuses both rather than re-deriving them.

const TOP_ITEMS = [
  { key: 'cockpit',   label: 'Cockpit',   icon: iconCockpit,   count: cockpitCount,   hot: true },
  { key: 'tracked',   label: 'Tracked',   icon: iconTracked,   count: trackedCount },
  { key: 'sessions',  label: 'Sessions',  icon: iconSessions,  count: sessionsCount },
  { key: 'schedules', label: 'Schedules', icon: iconSchedules, count: schedulesCount },
];
const LIBRARY_ITEMS = [
  { key: 'skills', label: 'Skills',       icon: iconSkills, count: null },
  { key: 'runs',   label: 'Runs history', icon: iconRuns,   count: null },
];

function cockpitCount() {
  const approvalCount = (approvals.get().pending ?? []).length;
  const jobBlockers = (work.get().jobs ?? []).filter(needsYou).length;
  return approvalCount + jobBlockers;
}
function trackedCount() {
  return (work.get().jobs ?? []).filter((j) => !isTerminalJob(j)).length;
}
function sessionsCount() {
  let n = 0;
  for (const slice of sessions.get().sessionsById.values()) {
    if (slice.runState === 'foreground' || slice.runState === 'background') n++;
  }
  return n;
}
function schedulesCount() {
  return enabledScheduleCount(schedulesStore.get());
}

export function mountSidebar(root) {
  root.classList.add('o-sidebar');
  root.setAttribute('role', 'navigation');
  root.setAttribute('aria-label', 'Sidebar');
  root.innerHTML = `
    <div class="o-sidebar-brand"><span class="o-sidebar-dot" aria-hidden="true"></span><span class="o-sidebar-word">Outpost</span></div>
    <nav class="o-sidebar-top" aria-label="Surfaces"></nav>
    <div class="o-sidebar-section">Library</div>
    <nav class="o-sidebar-lib" aria-label="Library"></nav>
    <div class="o-sidebar-foot">
      <button type="button" class="o-sidebar-item" id="sb-settings" data-surface="settings">
        <span class="o-sidebar-icon">${iconSettings()}</span>
        <span class="o-sidebar-label">Settings</span>
      </button>
      <button type="button" class="o-usage" id="sb-usage" aria-haspopup="true" aria-expanded="false" aria-label="Account usage">
        <span class="o-usage-row">
          <span class="o-usage-label" id="sb-usage-5h-lbl">5h</span>
          <span class="o-usage-bar"><span class="o-usage-fill" id="sb-usage-5h-fill"></span></span>
          <span class="o-usage-pct" id="sb-usage-5h-pct">&mdash;</span>
        </span>
        <span class="o-usage-row">
          <span class="o-usage-label" id="sb-usage-7d-lbl">7d</span>
          <span class="o-usage-bar"><span class="o-usage-fill" id="sb-usage-7d-fill"></span></span>
          <span class="o-usage-pct" id="sb-usage-7d-pct">&mdash;</span>
        </span>
      </button>
    </div>
  `;

  const top = root.querySelector('.o-sidebar-top');
  const lib = root.querySelector('.o-sidebar-lib');
  for (const item of TOP_ITEMS) top.appendChild(buildItem(item));
  for (const item of LIBRARY_ITEMS) lib.appendChild(buildItem(item));
  root.querySelector('#sb-settings').addEventListener('click', () => nav.setSurface('settings'));

  const applyActive = () => {
    const cur = nav.get().surface;
    for (const el of root.querySelectorAll('.o-sidebar-item')) {
      const on = el.dataset.surface === cur;
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  };
  const applyCollapsed = () => {
    root.classList.toggle('is-collapsed', !!nav.get().sidebarCollapsed);
  };
  const paintCounts = () => {
    for (const item of [...TOP_ITEMS, ...LIBRARY_ITEMS]) {
      if (!item.count) continue;
      paintBadge(root, item.key, item.count(), !!item.hot);
    }
  };

  const paintUsage = () => paintUsageWidget(root);

  applyActive();
  applyCollapsed();
  paintCounts();
  paintUsage();

  const unsubNav = nav.subscribe(() => { applyActive(); applyCollapsed(); });
  const unsubApprovals = approvals.subscribe(paintCounts);
  const unsubWork = work.subscribe(paintCounts);
  const unsubSessions = sessions.subscribe(paintCounts);
  const unsubSchedules = schedulesStore.subscribe(paintCounts);
  const unsubUsage = usage.subscribe(paintUsage);
  const teardownPopover = installUsagePopover(root);
  schedulesStore.load();

  return () => {
    unsubNav(); unsubApprovals(); unsubWork(); unsubSessions(); unsubSchedules();
    unsubUsage(); teardownPopover();
  };
}

// ── Account-usage widget: two compact bars (5h / weekly) + a detail popover.
// Tier math + popover markup are shared via utils/usage-bar.js.
function paintUsageWidget(root) {
  const au = usage.get().accountUsage;
  paintBar(root, '5h', au?.five_hour?.used_percentage, au?.five_hour?.resets_at, '5h');
  paintBar(root, '7d', au?.seven_day?.used_percentage, au?.seven_day?.resets_at, '7d');
}

function paintBar(root, key, pct, resetsAt, staticLabel) {
  const fill = root.querySelector(`#sb-usage-${key}-fill`);
  const pctEl = root.querySelector(`#sb-usage-${key}-pct`);
  const lblEl = root.querySelector(`#sb-usage-${key}-lbl`);
  // Label shows time-until-reset when known, falling back to the window's static label.
  if (lblEl) lblEl.textContent = fmtRemaining(resetsAt) ?? staticLabel;
  if (!fill || !pctEl) return;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    fill.style.width = '0%';
    fill.className = 'o-usage-fill';
    pctEl.textContent = '—';
    return;
  }
  const clamped = clampPct(pct);
  const tier = usageTier(clamped);
  fill.style.width = `${clamped}%`;
  fill.className = `o-usage-fill${tier === 'ok' ? '' : ` ${tier}`}`;
  pctEl.textContent = `${Math.round(clamped)}%`;
}

// Popover: absolute usage, reset countdown, burn rate, runway, per-model
// breakdown. Mounted into .o-shell-body (the sidebar itself scrolls/clips) and
// positioned bottom-left above the trigger via .o-usage-popover.
function installUsagePopover(root) {
  const trigger = root.querySelector('#sb-usage');
  const host = root.parentElement ?? root;
  let popEl = null;

  function close() {
    if (!popEl) return;
    popEl.remove();
    popEl = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function onOutside(e) {
    if (popEl && !popEl.contains(e.target) && e.target !== trigger) close();
  }
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }

  function open() {
    if (popEl) { close(); return; }
    popEl = document.createElement('div');
    popEl.className = 'o-usage-popover';
    popEl.setAttribute('role', 'dialog');
    popEl.setAttribute('aria-label', 'Usage detail');
    popEl.innerHTML = usagePopoverHtml(usage.get().accountUsage);
    host.appendChild(popEl);
    trigger.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  trigger.addEventListener('click', open);
  const unsub = usage.subscribe(() => { if (popEl) popEl.innerHTML = usagePopoverHtml(usage.get().accountUsage); });
  return () => { unsub(); close(); };
}

function buildItem(item) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'o-sidebar-item';
  b.dataset.surface = item.key;
  b.innerHTML = `
    <span class="o-sidebar-icon">${item.icon()}</span>
    <span class="o-sidebar-label">${item.label}</span>
    <span class="o-sidebar-count o-badge" hidden></span>
  `;
  b.addEventListener('click', () => nav.setSurface(item.key));
  return b;
}

function paintBadge(root, key, count, hot) {
  const btn = root.querySelector(`.o-sidebar-item[data-surface="${key}"]`);
  const badge = btn?.querySelector('.o-sidebar-count');
  if (!badge) return;
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = String(count > 99 ? '99+' : count);
    badge.classList.toggle('hot', !!hot);
  } else {
    badge.hidden = true;
    badge.textContent = '';
    badge.classList.remove('hot');
  }
}

// Placeholder glyph icons — the mockup uses Unicode placeholders too; swap for
// the app's inline-SVG icon convention (see activity-rail.js's iconStack()
// etc.) when a real icon set lands. Kept as simple SVGs here so they inherit
// currentColor and size consistently with the rest of the shell chrome.
function svg(path) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
function iconCockpit()  { return svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>'); }
function iconTracked()  { return svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16"/>'); }
function iconSessions() { return svg('<rect x="4" y="5" width="16" height="4" rx="1"/><rect x="4" y="11" width="16" height="4" rx="1"/><rect x="4" y="17" width="16" height="4" rx="1"/>'); }
function iconSchedules(){ return svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'); }
function iconSkills()   { return svg('<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>'); }
function iconRuns()     { return svg('<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>'); }
function iconSettings() { return svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'); }
