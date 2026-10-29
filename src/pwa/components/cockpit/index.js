// Desktop cockpit: keyed rows in user-arranged columns that keep their node, and so their open body, across moves.

import { cockpitBoard, stabilizeOrder, sessionsShownInBody } from '../../vm/cockpit-board.js';
import {
  normalizeLayout, resolveBoard, liveKeys, prunedLayout, addColumn, renamePinned, removePin, pinRow, unpinRow, moveSection,
  dropEmptyColumns, isPinnableKey, MIN_COLUMN_PX, GUTTER_PX,
} from '../../vm/cockpit-layout.js';
import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { approvals } from '../../state/approvals.js';
import { actions } from '../../state/actions.js';
import { schedulesStore } from '../../state/schedules.js';
import { runs } from '../../state/runs.js';
import { nav } from '../../state/nav.js';
import { engagement } from '../../state/engagement.js';
import { sessionActivity } from '../../state/session-activity.js';
import { cockpitLayout } from '../../state/cockpit-layout.js';
import { expansion } from './expansion.js';
import { launches } from './launches.js';
import { createRow, hasOpenableAction } from './row.js';
import { createSection } from './section.js';
import { createColumnResizer } from './resize.js';
import { installDrag } from './drag.js';
import { mountBody } from './bodies.js';
import { installBoardKeys } from './keyboard.js';
import { openInboxItem } from './inbox.js';
import { openPalette } from '../palette/index.js';
import { archiveSession } from '../session-view/session-actions.js';
import { openDiffForStep, openSession } from '../../app-bridge.js';
import { placeKeyedGroups, setHtmlIfChanged } from '../../utils/keyed-rows.js';

const TIME_REFRESH_MS = 30_000;

const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);

function skeleton() {
  return `
    <div class="ckb-view">
      <header class="ckb-top"><h1 class="ckb-h1">Cockpit</h1><div class="ckb-tally"></div>
        <button type="button" class="o-btn o-btn--ghost sm ckb-reset" data-ckb-reset hidden>Reset layout</button></header>
      <div class="ckb-empty" hidden>Nothing in flight.</div>
      <div class="ckb-board">
        <button type="button" class="o-icon-btn ckb-add-col" aria-label="Add column" title="Add column">+</button>
      </div>
    </div>`;
}

function tallyHtml(t) {
  const part = (n, glyph, label, tone) => `<span class="ckb-tally-item" data-tone="${tone}"><b>${glyph} ${n}</b> ${label}</span>`;
  return [
    [t.working, '◉', 'working', 'live'],
    [t.needYou, '●', 'need you', 'you'],
    [t.parked, '○', 'parked', 'mute'],
    [t.failed, '✕', 'failed', 'failed'],
  ].filter(([n]) => n > 0).map((p) => part(...p)).join('');
}

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let slideMs = null;
function slideDuration() {
  if (slideMs == null) slideMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-2')) || 180;
  return slideMs;
}

// FLIP, only when some group's order actually changed — measuring every row each frame is layout thrash.
function placeWithSlide(groups, reordered) {
  if (!reordered.size || reducedMotion() || typeof Element.prototype.animate !== 'function') {
    placeKeyedGroups(groups);
    return;
  }
  const moving = groups.filter((g) => reordered.has(g.container)).flatMap((g) => g.entries.map((e) => e.node));
  const before = new Map(moving.map((el) => [el, el.getBoundingClientRect().top]));
  placeKeyedGroups(groups);
  const dur = slideDuration();
  for (const el of moving) {
    const dy = before.get(el) - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: dur, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }
}

export function renderDetail(mount) {
  mount.textContent = '';
  mount.innerHTML = skeleton();
  const root = mount.querySelector('.ckb-view');
  const boardEl = root.querySelector('.ckb-board');
  const addColBtn = boardEl.querySelector('.ckb-add-col');
  const rows = new Map();
  const sections = new Map();
  const columnEls = [];
  const order = new Map();
  const hovered = new Set();
  let backlogOpen = false;
  let selectedKey = null;
  let scheduled = false;
  let disposed = false;
  let frozen = false;
  let paintQueued = false;
  let lastBoard = null;
  let lastResolved = { columns: [] };
  let width = mount.clientWidth;

  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        const w = Math.round(entries[0]?.contentRect.width ?? width);
        if (w !== width) { width = w; schedule(); }
      })
    : null;
  resizeObserver?.observe(boardEl);

  function schedule() {
    if (frozen) { paintQueued = true; return; }
    if (scheduled) return;
    scheduled = true;
    raf(() => {
      scheduled = false;
      if (disposed) return;
      if (frozen) paintQueued = true;
      else paint();
    });
  }

  function currentLayout() {
    return normalizeLayout(cockpitLayout.get(), width);
  }

  function hydrated() {
    return work.get().lastFetchedAt > 0 && sessions.get().projectsLoaded;
  }

  // Every user gesture funnels here; dead pins are only dropped from storage once both feeds have loaded.
  function applyLayout(mutation) {
    let next = mutation(currentLayout());
    if (hydrated() && lastBoard) next = prunedLayout(next, liveKeys(lastBoard));
    cockpitLayout.set(normalizeLayout(next, width));
  }

  function canAddColumn(layout) {
    const n = layout.columns.length + 1;
    return n * MIN_COLUMN_PX + (n - 1) * GUTTER_PX <= width;
  }

  function runAction(m) {
    selectedKey = m.key;
    if (m.kind === 'other') { openFull(m); return; }
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
    if (m.kind !== 'session' && !m.dismissable) return;
    const row = rows.get(m.key);
    row?.setArchiving(true);
    let error = '';
    let ok;
    if (m.kind === 'job') {
      ok = await work.dismiss(m.id).then(() => true, (e) => { error = `Dismiss failed: ${e.message}`; return false; });
    } else {
      ok = await archiveSession(m.id, undefined, { reportError: (msg) => { error = msg; } });
    }
    if (!ok) row?.setArchiving(false, error);
  }

  const rowCtx = {
    onToggle(m, mode) { selectedKey = m.key; expansion.toggle(m.key, mode); },
    onAction: runAction,
    onArchive(m) { void archiveRow(m); },
    onOpenFull: openFull,
    onHover(key, on) { if (on) hovered.add(key); else { hovered.delete(key); schedule(); } },
  };

  const sectionCtx = {
    onRename(pinId, title) { applyLayout((l) => renamePinned(l, pinId, title)); },
    onRemove(pinId) { applyLayout((l) => dropEmptyColumns(removePin(l, pinId))); },
    onNew() { openPalette(); },
    onChip(key) { const c = chipFor(key); if (c) { selectedKey = key; openFull(c.model); } },
    onToggleBacklog() { backlogOpen = !backlogOpen; schedule(); },
    backlogOpen: () => backlogOpen,
    onGripKey: nudgeSection,
  };

  function nudgeSection(id, key) {
    const l = currentLayout();
    const col = l.columns.findIndex((c) => c.sections.includes(id));
    const idx = l.columns[col].sections.indexOf(id);
    const last = l.columns[col].sections.length - 1;
    const to = {
      ArrowUp: [col, Math.max(0, idx - 1)],
      ArrowDown: [col, Math.min(last, idx + 1)],
      ArrowLeft: col > 0 ? [col - 1, 0] : null,
      ArrowRight: col < l.columns.length - 1 ? [col + 1, 0] : null,
    }[key];
    if (!to || (to[0] === col && to[1] === idx)) return;
    applyLayout((x) => dropEmptyColumns(moveSection(x, id, to[0], to[1])));
  }

  function togglePin(key) {
    if (!isPinnableKey(key)) return;
    const l = currentLayout();
    if (Object.values(l.pinned).some((p) => p.rows.includes(key))) {
      applyLayout((x) => dropEmptyColumns(unpinRow(x, key)));
      return;
    }
    const first = l.columns.flatMap((c) => c.sections).find((s) => s.startsWith('pin:'));
    const target = first
      ? { pinId: first.slice(4), index: l.pinned[first.slice(4)].rows.length }
      : { newAt: { col: 0, index: 0 } };
    applyLayout((x) => pinRow(x, key, target).layout);
  }

  function chipFor(key) {
    for (const s of sections.values()) {
      const c = s.chips().find((x) => x.key === key);
      if (c) return c;
    }
    return null;
  }

  function ensureColumns(n) {
    while (columnEls.length < n) {
      const col = document.createElement('div');
      col.className = 'ckb-column';
      col.innerHTML = '<div class="ckb-col-empty" hidden>Drop a section here</div>';
      boardEl.insertBefore(col, addColBtn);
      columnEls.push(col);
    }
  }

  function paint() {
    const now = Date.now();
    const board = cockpitBoard({
      jobs: work.get().jobs,
      projects: sessions.get().projects ?? [],
      slices: sessions.get().sessionsById ?? new Map(),
      pendingApprovals: approvals.get().pending,
      localEngaged: engagement.get(),
      activity: sessionActivity.get(),
      actionEdits: actions.get().edits,
      autoApplied: actions.get().autoApplied,
      scheduleDrafts: schedulesStore.get().draftBySession,
      runs: runs.get().runs,
      openingWaits: work.get().openingWaits,
      launched: launches.get(),
      now,
    });
    lastBoard = board;
    const listed = new Set((sessions.get().projects ?? []).flatMap((p) => (p.sessions ?? []).map((s) => s.id)));
    for (const id of launches.get()) if (listed.has(id)) launches.drop(id);
    const layout = currentLayout();
    const resolved = resolveBoard(board, layout);
    lastResolved = resolved;

    const all = [...board.started, ...board.notStarted, ...board.backlog, ...board.sessions];
    for (const [key, mode] of expansion.get()) {
      const m = all.find((r) => r.key === key);
      if (!m || (mode === 'action' && !hasOpenableAction(m))) expansion.close(key);
    }
    const exp = expansion.get();
    const holding = new Set([...hovered, ...exp.keys()]);

    setHtmlIfChanged(root.querySelector('.ckb-tally'), tallyHtml(board.tally));
    root.querySelector('.ckb-empty').hidden = !board.empty;
    addColBtn.disabled = !canAddColumn(layout);
    root.querySelector('[data-ckb-reset]').hidden = cockpitLayout.get() == null;

    ensureColumns(resolved.columns.length);
    const liveSections = new Set();
    const sectionGroups = resolved.columns.map((c, i) => {
      const col = columnEls[i];
      col.dataset.col = String(i);
      col.style.flexGrow = String(c.width);
      col.querySelector('.ckb-col-empty').hidden = c.sections.length > 0;
      const entries = c.sections.map((r) => {
        liveSections.add(r.id);
        let s = sections.get(r.id);
        if (!s) { s = createSection(r, sectionCtx); sections.set(r.id, s); }
        else s.update(r);
        return { key: r.id, node: s.el };
      });
      return { container: col, entries: [{ key: 'empty', node: col.querySelector('.ckb-col-empty') }, ...entries] };
    });
    placeKeyedGroups(sectionGroups, { sweep: false });

    const seen = new Set();
    const groupIds = new Set();
    const reordered = new Set();
    const rowGroups = [];
    for (const s of [...liveSections].map((id) => sections.get(id))) {
      for (const g of s.rowGroups()) {
        groupIds.add(g.id);
        const byKey = new Map(g.rows.map((r) => [r.key, r]));
        const prevKeys = order.get(g.id) ?? null;
        const desired = g.rows.map((r) => r.key);
        const keys = g.stabilize ? stabilizeOrder(prevKeys, desired, holding) : desired;
        order.set(g.id, keys);
        const was = (prevKeys ?? []).filter((k) => byKey.has(k));
        const wasSet = new Set(was);
        if (keys.filter((k) => wasSet.has(k)).some((k, i) => k !== was[i])) reordered.add(g.container);
        rowGroups.push({
          container: g.container,
          entries: keys.map((key) => {
            const m = byKey.get(key);
            seen.add(key);
            const mode = exp.get(key) ?? null;
            const view = { mode, selected: key === selectedKey, now, hideFeeds: sessionsShownInBody(m, mode), mountBody };
            let row = rows.get(key);
            if (!row) {
              row = createRow(m, { ...rowCtx, initialView: view });
              rows.set(key, row);
              if (m.kind === 'session' && launches.get().has(m.id)) {
                selectedKey = key;
                const el = row.el;
                requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
              }
            }
            else row.update(m, view);
            return { key, node: row.el };
          }),
        });
      }
      for (const c of s.chips()) c.el.classList.toggle('is-selected', c.key === selectedKey);
    }
    placeWithSlide(rowGroups, reordered);

    for (const [key, row] of rows) {
      if (!seen.has(key)) { row.destroy(); rows.delete(key); }
    }
    for (const [id, s] of sections) {
      if (!liveSections.has(id)) { s.destroy(); sections.delete(id); }
    }
    for (const id of [...order.keys()]) if (!groupIds.has(id)) order.delete(id);
    while (columnEls.length > resolved.columns.length) columnEls.pop().remove();
    resizer.sync(columnEls);
  }

  function rowKeys() {
    const keys = [];
    for (const c of lastResolved.columns) {
      for (const r of c.sections) {
        const s = sections.get(r.id);
        if (!s) continue;
        if (r.kind === 'other') { keys.push(...s.chips().map((x) => x.key)); continue; }
        for (const g of s.rowGroups()) {
          if (g.id === 'jobs:backlog' && !backlogOpen) continue;
          keys.push(...(order.get(g.id) ?? []));
        }
      }
    }
    return keys;
  }

  function rowOrChip(key) {
    return rows.get(key) ?? chipFor(key);
  }

  root.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.ckb-add-col') && !addColBtn.disabled) applyLayout(addColumn);
    if (e.target.closest('[data-ckb-reset]') && window.confirm('Reset the cockpit layout? Columns go back to the default and every Pinned section is removed.')) {
      cockpitLayout.reset();
    }
  });

  const board = {
    rowKeys,
    row: (key) => rowOrChip(key),
    selected: () => selectedKey,
    select(key) { selectedKey = key; schedule(); rowOrChip(key)?.el.scrollIntoView({ block: 'nearest' }); },
    toggle(key, mode) {
      const r = rowOrChip(key);
      selectedKey = key;
      if (r?.model.kind === 'other') { openFull(r.model); return; }
      expansion.toggle(key, mode);
    },
    collapse(key) { expansion.close(key); },
    runAction(key) { const r = rowOrChip(key); if (r) runAction(r.model); },
    archive(key) { const r = rows.get(key); if (r) void archiveRow(r.model); },
    openFull(key) { const r = rowOrChip(key); if (r) openFull(r.model); },
    freeze() { frozen = true; },
    thaw() {
      frozen = false;
      if (paintQueued) { paintQueued = false; schedule(); }
    },
    layout: currentLayout,
    applyLayout,
    resolved: () => lastResolved,
    boardWidth: () => width,
    isDragging: () => dragger.isDragging(),
    pin: togglePin,
  };

  const resizer = createColumnResizer(boardEl, board);
  const dragger = installDrag(boardEl, board);
  paint();
  const unsubs = [work, sessions, approvals, actions, schedulesStore, runs, engagement, sessionActivity, expansion, launches, cockpitLayout]
    .map((s) => s.subscribe(schedule));
  const uninstallKeys = installBoardKeys(root, board);
  const timer = setInterval(schedule, TIME_REFRESH_MS);

  return () => {
    disposed = true;
    clearInterval(timer);
    resizeObserver?.disconnect();
    resizer.destroy();
    dragger.uninstall();
    uninstallKeys();
    for (const u of unsubs) u();
    for (const row of rows.values()) row.destroy();
    rows.clear();
    for (const s of sections.values()) s.destroy();
    sections.clear();
  };
}
