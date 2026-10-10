import { nav } from '../../state/nav.js';
import { approvals } from '../../state/approvals.js';
import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { schedulesStore, enabledScheduleCount } from '../../state/schedules.js';
import { usage } from '../../state/usage.js';
import { usageTier, clampPct, usagePopoverHtml, queueActionFor, queueToggle, queueTag, heldWindow } from '../../utils/usage-bar.js';
import { fmtRemaining } from '../../utils/formatting.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { needsYou, isTerminalJob } from '../../vm/work-predicates.js';
import { updateStore, updateAvailable } from '../../state/update.js';

// Sidebar taxonomy per the redesign spec: Cockpit / Tracked / Sessions /
// Schedules, a Library group (Skills / Runs history), Settings pinned at the
// foot with the job queue's pause/resume beneath it, then the account-usage widget. Replaces activity-rail.js's
// 4-item icon-only nav.
//
// Tier math + popover markup live in utils/usage-bar.js — the mobile header's
// compact usage widget reuses both rather than re-deriving them.

const TOP_ITEMS = [
  { key: 'cockpit',   label: 'Cockpit (WIP)',   icon: iconCockpit,   count: cockpitCount,   hot: true },
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
    <div class="o-sidebar-brand"><span class="o-sidebar-dot" aria-hidden="true"></span><span class="o-sidebar-word">Outpost</span><span class="o-sidebar-queue" hidden></span></div>
    <nav class="o-sidebar-top" aria-label="Surfaces"></nav>
    <div class="o-sidebar-section">Library</div>
    <nav class="o-sidebar-lib" aria-label="Library"></nav>
    <div class="o-sidebar-foot">
      <button type="button" class="o-sidebar-item o-sidebar-update" id="sb-update" hidden>
        <span class="o-sidebar-icon">${iconUpdate()}</span>
        <span class="o-sidebar-label">Update available</span>
      </button>
      <button type="button" class="o-sidebar-item" id="sb-settings" data-surface="settings">
        <span class="o-sidebar-icon">${iconSettings()}</span>
        <span class="o-sidebar-label">Settings</span>
      </button>
      <button type="button" class="o-sidebar-item" id="sb-queue" data-queue-action="pause">
        <span class="o-sidebar-icon"></span>
        <span class="o-sidebar-label"></span>
        <span class="o-sidebar-count o-badge" hidden></span>
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
  const updateBtn = root.querySelector('#sb-update');
  updateBtn.addEventListener('click', () => nav.select('settings', 'updates'));
  const paintUpdate = () => { updateBtn.hidden = !updateAvailable(updateStore.get().status); };

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
  const tagEl = root.querySelector('.o-sidebar-queue');
  const queueBtn = root.querySelector('#sb-queue');
  // A nav item, not a surface: it carries data-queue-action, so the foot's delegated click below
  // handles it like the status line's own buttons, and applyActive never marks it current.
  const paintQueue = () => {
    const q = work.get().launchQueue;
    // Paused, the brand dot takes --warn too — in the collapsed rail it is all that's left.
    const tag = queueTag(q);
    tagEl.hidden = !tag;
    tagEl.textContent = tag?.text ?? '';
    tagEl.title = tag?.title ?? '';
    if (tag) tagEl.dataset.tone = tag.tone;
    root.classList.toggle('is-queue-paused', !!q?.paused);
    paintFavicon(root);
    queueBtn.hidden = !q;
    if (!q) return;
    const t = queueToggle(q);
    queueBtn.dataset.queueAction = t.action;
    queueBtn.title = t.title;
    queueBtn.setAttribute('aria-label', t.title);
    queueBtn.classList.toggle('is-paused', t.paused);
    setHtmlIfChanged(queueBtn.querySelector('.o-sidebar-icon'), t.icon);
    queueBtn.querySelector('.o-sidebar-label').textContent = t.label;
    const badge = queueBtn.querySelector('.o-sidebar-count');
    badge.hidden = !q.parked;
    badge.textContent = q.parked ? String(q.parked > 99 ? '99+' : q.parked) : '';
  };
  // Delegated from the foot for the queue nav item, which carries its action as data-queue-action.
  root.querySelector('.o-sidebar-foot').addEventListener('click', (e) => {
    const a = queueActionFor(e.target);
    if (a) void work.queueAction(a);
  });

  applyActive();
  applyCollapsed();
  paintCounts();
  paintUsage();
  paintQueue();
  paintUpdate();

  const unsubNav = nav.subscribe(() => { applyActive(); applyCollapsed(); });
  const unsubApprovals = approvals.subscribe(paintCounts);
  const unsubWork = work.subscribe(() => { paintCounts(); paintQueue(); paintUsage(); });
  const unsubSessions = sessions.subscribe(paintCounts);
  const unsubSchedules = schedulesStore.subscribe(paintCounts);
  const unsubUsage = usage.subscribe(paintUsage);
  const unsubUpdate = updateStore.subscribe(paintUpdate);
  const teardownPopover = installUsagePopover(root);
  // Theme, light/dark, and a system-mode flip all land as one of these two attributes.
  const themeObs = new MutationObserver(() => paintFavicon(root));
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
  schedulesStore.load();
  void updateStore.ensureLoaded();

  return () => {
    unsubNav(); unsubApprovals(); unsubWork(); unsubSessions(); unsubSchedules();
    unsubUsage(); unsubUpdate(); teardownPopover(); themeObs.disconnect();
  };
}

// The tab's favicon is the brand dot: same gradient, same --warn when the queue is paused.
// Colours come from the dot's own computed vars so every theme and mode follows for free.
function paintFavicon(root) {
  const dot = root.querySelector('.o-sidebar-dot');
  if (!dot) return;
  const cs = getComputedStyle(dot);
  const v = (name) => cs.getPropertyValue(name).trim();
  const paused = root.classList.contains('is-queue-paused');
  const a = paused ? v('--warn') : v('--accent');
  const b = paused ? a : (v('--accent-2') || a);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><circle cx="8" cy="8" r="7" fill="url(#g)"/></svg>`;
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

// ── Account-usage widget: two compact bars (5h / weekly) + a detail popover.
// Tier math + popover markup are shared via utils/usage-bar.js.
function paintUsageWidget(root) {
  const au = usage.get().accountUsage;
  const held = heldWindow(work.get().launchQueue);
  paintBar(root, '5h', au?.five_hour?.used_percentage, au?.five_hour?.resets_at, '5h', held === 'five_hour');
  paintBar(root, '7d', au?.seven_day?.used_percentage, au?.seven_day?.resets_at, '7d', held === 'seven_day');
}

// `held`: this window is what's keeping the job queue back — the row takes the paused --warn.
function paintBar(root, key, pct, resetsAt, staticLabel, held) {
  const fill = root.querySelector(`#sb-usage-${key}-fill`);
  fill?.closest('.o-usage-row')?.classList.toggle('is-held', held);
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
    popEl.innerHTML = usagePopoverHtml(usage.get().accountUsage, work.get().launchQueue);
    popEl.addEventListener('click', (e) => { const a = queueActionFor(e.target); if (a) void work.queueAction(a); });
    host.appendChild(popEl);
    trigger.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  trigger.addEventListener('click', open);
  const repaint = () => { if (popEl) popEl.innerHTML = usagePopoverHtml(usage.get().accountUsage, work.get().launchQueue); };
  const unsub = usage.subscribe(repaint);
  const unsubWork = work.subscribe(repaint);
  return () => { unsub(); unsubWork(); close(); };
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
function iconUpdate() { return svg('<path d="M12 19V5M5 12l7-7 7 7"/>'); }
function iconSettings() { return svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'); }
