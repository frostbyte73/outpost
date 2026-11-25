import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { OPENABLE } from '../../vm/cockpit-board.js';
import { openDiffForSession, promoteSessionToJob } from '../../app-bridge.js';
import { computeGitInfo, deleteSession } from '../session-view/session-actions.js';
import { syncFeeds, teardownFeeds } from './feeds.js';

const GLYPH = { live: '◉', you: '●', parked: '○', failed: '✕', done: '●', idle: '·' };
const ICON_CLASS = { live: 'busy', you: 'warn', parked: 'idle', failed: 'hot', done: 'ok', idle: 'idle' };
const AGED = new Set(['you', 'parked', 'idle', 'failed', 'done']);
const CHEVRON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Short identifiers only, so titles line up down a group; a session's repo trails its title instead.
function slotHtml(m) {
  if (m.kindLabel) return escapeHtml(m.kindLabel);
  if (m.kind !== 'job' || !m.ref) return '';
  return m.refMono ? `<span class="o-ref">${escapeHtml(m.ref)}</span>` : escapeHtml(m.ref);
}

function metaText(m) {
  return m.kind === 'job' ? '' : (m.ref ?? '');
}

function ageText(m, now) {
  return AGED.has(m.tone) && m.time ? (relPast(m.time, now) ?? '') : '';
}

function idleArchiveLabel(m) {
  return m.kind === 'job' ? 'Dismiss' : 'Archive';
}

function sessionMenuHtml(id) {
  const { diffable } = computeGitInfo(id);
  const items = [`<button type="button" class="ckb-menu-item" data-action="promote">Promote to tracked</button>`];
  if (diffable) items.push(`<button type="button" class="ckb-menu-item" data-action="open-diff">Open diff</button>`);
  items.push(`<button type="button" class="ckb-menu-item ckb-menu-item-danger" data-action="delete">Delete</button>`);
  return items.join('');
}

export function hasOpenableAction(model) {
  return model.actions.some((a) => OPENABLE.has(a.kind));
}

export function createRow(model, ctx) {
  const el = document.createElement('div');
  el.className = 'o-row ckb-item';
  el.innerHTML = `
    <div class="ckb-line">
      <span class="o-row-icon ckb-glyph" aria-hidden="true"></span>
      <span class="ckb-lead"><span class="ckb-ref"></span><span class="o-row-title ckb-title"></span><span class="ckb-meta"></span></span>
      <span class="ckb-status"></span>
      <span class="ckb-age"></span>
      <span class="ckb-acts">
        <button type="button" class="o-btn o-btn--ghost sm ckb-archive" hidden>Archive</button>
        <span class="ckb-act"></span>
        <div class="ckb-menu-wrap" hidden>
          <button type="button" class="ckb-menu-btn" aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
          <div class="ckb-menu" hidden role="menu"></div>
        </div>
      </span>
      <button type="button" class="ckb-caret" aria-expanded="false" aria-label="Expand">${CHEVRON}</button>
    </div>
    <div class="ckb-feeds"></div>
    <div class="ckb-body" hidden></div>`;
  const dom = {
    glyph: el.querySelector('.ckb-glyph'), ref: el.querySelector('.ckb-ref'), title: el.querySelector('.ckb-title'),
    meta: el.querySelector('.ckb-meta'), status: el.querySelector('.ckb-status'), age: el.querySelector('.ckb-age'), act: el.querySelector('.ckb-act'), archive: el.querySelector('.ckb-archive'),
    caret: el.querySelector('.ckb-caret'), feeds: el.querySelector('.ckb-feeds'), body: el.querySelector('.ckb-body'),
    menuWrap: el.querySelector('.ckb-menu-wrap'), menuBtn: el.querySelector('.ckb-menu-btn'), menu: el.querySelector('.ckb-menu'),
  };
  let current = model;
  const closeMenu = () => {
    dom.menu.hidden = true;
    dom.menuBtn.setAttribute('aria-expanded', 'false');
  };
  // Fixed, not absolute: the board scrolls sideways, and that overflow clips a dropdown that hangs off a row.
  const placeMenu = () => {
    const r = dom.menuBtn.getBoundingClientRect();
    const menu = dom.menu;
    menu.style.position = 'fixed';
    menu.hidden = false;
    const width = menu.getBoundingClientRect().width;
    const height = menu.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = r.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, r.top - 4 - height) : below}px`;
  };
  dom.menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dom.menu.hidden) {
      placeMenu();
      dom.menuBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeMenu();
    }
  });
  dom.menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || current.kind !== 'session') return;
    e.stopPropagation();
    closeMenu();
    const action = btn.dataset.action;
    if (action === 'promote') promoteSessionToJob(current.id);
    else if (action === 'open-diff') openDiffForSession(current.id);
    else if (action === 'delete') void deleteSession(current.id);
  });
  const onOutsideClick = (e) => {
    if (dom.menu.hidden) return;
    if (e.target.closest('.ckb-menu-wrap') === dom.menuWrap) return;
    closeMenu();
  };
  document.addEventListener('click', onOutsideClick);
  const onScroll = () => { if (!dom.menu.hidden) closeMenu(); };
  document.addEventListener('scroll', onScroll, true);
  dom.menuWrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dom.menu.hidden) return;
    e.stopPropagation();
    closeMenu();
    dom.menuBtn.focus();
  });
  let sig = '';
  let body = null;
  let bodyMode = null;
  let archiveError = '';

  el.querySelector('.ckb-line').addEventListener('click', (e) => {
    if (e.target.closest('button') && !e.target.closest('.ckb-caret')) return;
    if (current.kind === 'other') { ctx.onOpenFull(current); return; }
    ctx.onToggle(current, 'caret');
  });
  dom.act.addEventListener('click', (e) => { e.stopPropagation(); ctx.onAction(current); });
  dom.archive.addEventListener('click', (e) => { e.stopPropagation(); ctx.onArchive(current); });
  el.addEventListener('pointerenter', () => ctx.onHover(current.key, true));
  el.addEventListener('pointerleave', () => ctx.onHover(current.key, false));

  let lastView = ctx.initialView;

  function update(m, view) {
    current = m;
    lastView = view;
    el.dataset.rowKey = m.key;
    el.dataset.tone = m.tone;
    el.classList.toggle('is-selected', view.selected);
    const age = archiveError ? '' : ageText(m, view.now);
    const nextSig = [m.tone, m.ref, m.kindLabel, m.title, m.status.text, age, m.status.tone, m.actionLabel].join('|');
    if (nextSig !== sig) {
      sig = nextSig;
      const text = archiveError || m.status.text;
      dom.glyph.textContent = GLYPH[m.tone];
      dom.glyph.className = `o-row-icon ckb-glyph ${ICON_CLASS[m.tone]}`;
      dom.ref.innerHTML = slotHtml(m);
      dom.title.textContent = m.title;
      dom.title.title = m.title;
      dom.meta.textContent = metaText(m);
      dom.status.textContent = text;
      dom.status.title = text;
      dom.age.textContent = age;
      dom.status.dataset.tone = archiveError ? 'failed' : m.status.tone;
      dom.act.innerHTML = m.actionLabel
        ? `<button type="button" class="o-btn o-btn--default sm">${escapeHtml(m.actionLabel)}</button>`
        : '';
    }
    dom.archive.hidden = m.kind !== 'session' && !m.dismissable;
    if (!dom.archive.disabled) dom.archive.textContent = idleArchiveLabel(m);
    dom.menuWrap.hidden = m.kind !== 'session';
    if (m.kind === 'session') setHtmlIfChanged(dom.menu, sessionMenuHtml(m.id));
    dom.caret.hidden = m.kind === 'other';
    dom.caret.setAttribute('aria-expanded', String(!!view.mode));

    const hide = new Set(view.hideFeeds);
    syncFeeds(dom.feeds, m.feeds.filter((f) => !hide.has(f.sessionId)));

    if (view.mode !== bodyMode) {
      body?.unmount();
      body = null;
      bodyMode = view.mode;
      dom.body.hidden = !view.mode;
      if (view.mode) body = view.mountBody(dom.body, m, view.mode);
    } else {
      body?.update(m);
    }
  }

  update(model, ctx.initialView);
  return {
    el,
    update,
    get model() { return current; },
    setArchiving(on, error = '') {
      dom.archive.disabled = on;
      dom.archive.textContent = on ? (current.kind === 'job' ? 'Dismissing…' : 'Archiving…') : idleArchiveLabel(current);
      archiveError = on ? '' : error;
      sig = '';
      update(current, lastView);
    },
    destroy() {
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('scroll', onScroll, true);
      body?.unmount();
      teardownFeeds(dom.feeds);
      el.remove();
    },
  };
}
