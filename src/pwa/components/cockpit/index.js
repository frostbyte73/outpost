// Desktop cockpit: every open job, manual session and non-job attention item as keyed rows that
// patch in place, so expanded bodies (composers, draft edits, session views) survive every repaint.

import { cockpitBoard, stabilizeOrder, sessionsShownInBody } from '../../vm/cockpit-board.js';
import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { approvals } from '../../state/approvals.js';
import { actions } from '../../state/actions.js';
import { schedulesStore } from '../../state/schedules.js';
import { runs } from '../../state/runs.js';
import { nav } from '../../state/nav.js';
import { engagement } from '../../state/engagement.js';
import { expansion } from './expansion.js';
import { createRow, hasOpenableAction } from './row.js';
import { mountBody } from './bodies.js';
import { installBoardKeys } from './keyboard.js';
import { openInboxItem } from './inbox.js';
import { openPalette } from '../palette/index.js';
import { archiveSession } from '../session-view/session-actions.js';
import { openDiffForStep, openSession } from '../../app-bridge.js';
import { placeKeyedNodes, setHtmlIfChanged } from '../../utils/keyed-rows.js';

const GROUPS = ['started', 'notStarted', 'backlog', 'sessions', 'other'];
const TIME_REFRESH_MS = 30_000;

const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);

function skeleton() {
  return `
    <div class="ckb-view">
      <header class="ckb-top"><h1 class="ckb-h1">Cockpit</h1><div class="ckb-tally"></div></header>
      <div class="ckb-empty" hidden>Nothing in flight.</div>
      <section class="ckb-section" data-section="jobs">
        <div class="o-group-hdr"><h2>Jobs</h2><span class="o-group-count"></span><span class="o-group-rule"></span>
          <button type="button" class="o-btn o-btn--ghost sm" data-ckb-new>+ New job</button></div>
        <div class="o-row-group" data-group="started"></div>
        <div class="ckb-divider o-microhead" data-divider="notStarted" hidden>Not started</div>
        <div class="o-row-group" data-group="notStarted"></div>
        <button type="button" class="ckb-fold" data-fold="backlog" hidden></button>
        <div class="o-row-group" data-group="backlog" hidden></div>
      </section>
      <section class="ckb-section" data-section="sessions">
        <div class="o-group-hdr"><h2>Sessions</h2><span class="o-group-count"></span><span class="o-group-rule"></span>
          <button type="button" class="o-btn o-btn--ghost sm" data-ckb-new>+ New session</button></div>
        <div class="o-row-group" data-group="sessions"></div>
      </section>
      <section class="ckb-section" data-section="other" hidden>
        <div class="o-group-hdr"><h2>Other</h2><span class="o-group-count"></span><span class="o-group-rule"></span></div>
        <div class="o-row-group" data-group="other"></div>
      </section>
    </div>`;
}

function tallyHtml(t) {
  const part = (n, glyph, label, tone) => `<span class="ckb-tally-item" data-tone="${tone}"><b>${glyph} ${n}</b> ${label}</span>`;
  return [
    part(t.working, '◉', 'working', 'live'),
    part(t.needYou, '●', 'need you', 'you'),
    part(t.parked, '○', 'parked', 'mute'),
    ...(t.failed ? [part(t.failed, '✕', 'failed', 'failed')] : []),
  ].join('');
}

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let slideMs = null;
function slideDuration() {
  if (slideMs == null) slideMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-2')) || 180;
  return slideMs;
}

// FLIP, only when the group's order actually changed — measuring every row each frame is layout thrash.
function placeWithSlide(container, entries, reordered) {
  if (!reordered || reducedMotion() || typeof Element.prototype.animate !== 'function') {
    placeKeyedNodes(container, entries);
    return;
  }
  const before = new Map([...container.children].map((el) => [el, el.getBoundingClientRect().top]));
  placeKeyedNodes(container, entries);
  const dur = slideDuration();
  for (const el of container.children) {
    const prev = before.get(el);
    if (prev == null) continue;
    const dy = prev - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: dur, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

export function renderDetail(mount) {
  mount.textContent = '';
  mount.innerHTML = skeleton();
  const root = mount.querySelector('.ckb-view');
  const groupEl = Object.fromEntries(GROUPS.map((g) => [g, root.querySelector(`[data-group="${g}"]`)]));
  const rows = new Map();
  const order = new Map();
  const hovered = new Set();
  let backlogOpen = false;
  let selectedKey = null;
  let scheduled = false;
  let disposed = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    raf(() => { scheduled = false; if (!disposed) paint(); });
  }

  function runAction(m) {
    selectedKey = m.key;
    const push = m.actions.find((a) => a.kind === 'push');
    if (push && m.actions.length === 1) { openDiffForStep({ jobId: m.id, stepId: push.stepId, sessionId: push.sessionId }); return; }
    if (m.kind === 'session') { expansion.open(m.key, 'caret'); return; }
    if (hasOpenableAction(m)) { expansion.open(m.key, 'action'); return; }
    rows.get(m.key)?.el.querySelector('.ckb-feeds .inline-approval, .ckb-feeds .ask-card')?.scrollIntoView({ block: 'nearest' });
  }

  function openFull(m) {
    if (m.kind === 'job') nav.select('tracked', m.id);
    else if (m.kind === 'session') openSession({ id: m.id });
    else openInboxItem(m.inboxItem);
  }

  async function archiveRow(m) {
    if (m.kind !== 'session') return;
    const row = rows.get(m.key);
    row?.setArchiving(true);
    let error = '';
    const ok = await archiveSession(m.id, undefined, { reportError: (msg) => { error = msg; } });
    if (!ok) row?.setArchiving(false, error);
  }

  const ctx = {
    onToggle(m, mode) { selectedKey = m.key; expansion.toggle(m.key, mode); },
    onAction: runAction,
    onArchive(m) { void archiveRow(m); },
    onOpenFull: openFull,
    onHover(key, on) { if (on) hovered.add(key); else { hovered.delete(key); schedule(); } },
  };

  function paint() {
    const now = Date.now();
    const board = cockpitBoard({
      jobs: work.get().jobs,
      projects: sessions.get().projects ?? [],
      slices: sessions.get().sessionsById ?? new Map(),
      pendingApprovals: approvals.get().pending,
      localEngaged: engagement.get(),
      actionEdits: actions.get().edits,
      autoApplied: actions.get().autoApplied,
      scheduleDrafts: schedulesStore.get().draftBySession,
      runs: runs.get().runs,
      now,
    });
    const all = GROUPS.flatMap((g) => board[g]);
    for (const [key, mode] of expansion.get()) {
      const m = all.find((r) => r.key === key);
      if (!m || (mode === 'action' && !hasOpenableAction(m))) expansion.close(key);
    }
    const exp = expansion.get();
    const pinned = new Set([...hovered, ...exp.keys()]);

    setHtmlIfChanged(root.querySelector('.ckb-tally'), tallyHtml(board.tally));
    root.querySelector('.ckb-empty').hidden = !board.empty;
    root.querySelector('[data-divider="notStarted"]').hidden = board.notStarted.length === 0 && board.backlog.length === 0;
    const fold = root.querySelector('[data-fold="backlog"]');
    fold.hidden = board.backlog.length === 0;
    setText(fold, `${backlogOpen ? '▾' : '▸'} Backlog (${board.backlog.length})`);
    groupEl.backlog.hidden = !backlogOpen;
    root.querySelector('[data-section="other"]').hidden = board.other.length === 0;
    setText(root.querySelector('[data-section="jobs"] .o-group-count'),
      String(board.started.length + board.notStarted.length + board.backlog.length));
    setText(root.querySelector('[data-section="sessions"] .o-group-count'), String(board.sessions.length));
    setText(root.querySelector('[data-section="other"] .o-group-count'), String(board.other.length));

    const seen = new Set();
    for (const g of GROUPS) {
      const byKey = new Map(board[g].map((r) => [r.key, r]));
      const prevKeys = order.get(g) ?? null;
      const keys = stabilizeOrder(prevKeys, board[g].map((r) => r.key), pinned);
      order.set(g, keys);
      const survivors = new Set(keys);
      const was = (prevKeys ?? []).filter((k) => survivors.has(k));
      const wasSet = new Set(was);
      const reordered = keys.filter((k) => wasSet.has(k)).some((k, i) => k !== was[i]);
      const entries = keys.map((key) => {
        const m = byKey.get(key);
        seen.add(key);
        const mode = exp.get(key) ?? null;
        const view = { mode, selected: key === selectedKey, now, hideFeeds: sessionsShownInBody(m, mode), mountBody };
        let row = rows.get(key);
        if (!row) { row = createRow(m, { ...ctx, initialView: view }); rows.set(key, row); }
        else row.update(m, view);
        return { key, node: row.el };
      });
      placeWithSlide(groupEl[g], entries, reordered);
    }
    for (const [key, row] of rows) {
      if (!seen.has(key)) { row.destroy(); rows.delete(key); }
    }
  }

  root.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('[data-ckb-new]')) openPalette();
    if (e.target.closest('[data-fold="backlog"]')) { backlogOpen = !backlogOpen; schedule(); }
  });

  const board = {
    rowKeys: () => GROUPS.flatMap((g) => (g === 'backlog' && !backlogOpen ? [] : order.get(g) ?? [])),
    row: (key) => rows.get(key) ?? null,
    selected: () => selectedKey,
    select(key) { selectedKey = key; schedule(); rows.get(key)?.el.scrollIntoView({ block: 'nearest' }); },
    toggle(key, mode) { selectedKey = key; expansion.toggle(key, mode); },
    collapse(key) { expansion.close(key); },
    runAction(key) { const r = rows.get(key); if (r) runAction(r.model); },
    archive(key) { const r = rows.get(key); if (r) void archiveRow(r.model); },
    openFull(key) { const r = rows.get(key); if (r) openFull(r.model); },
  };

  paint();
  const unsubs = [work, sessions, approvals, actions, schedulesStore, runs, engagement, expansion]
    .map((s) => s.subscribe(schedule));
  const uninstallKeys = installBoardKeys(root, board);
  const timer = setInterval(schedule, TIME_REFRESH_MS);

  return () => {
    disposed = true;
    clearInterval(timer);
    uninstallKeys();
    for (const u of unsubs) u();
    for (const row of rows.values()) row.destroy();
    rows.clear();
  };
}
