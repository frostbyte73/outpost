import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { OPENABLE } from '../../vm/cockpit-board.js';
import { syncFeeds, teardownFeeds } from './feeds.js';

const GLYPH = { live: '◉', you: '●', parked: '○', failed: '✕', idle: '·' };
const ICON_CLASS = { live: 'busy', you: 'warn', parked: 'idle', failed: 'hot', idle: 'idle' };
const AGED = new Set(['you', 'parked', 'idle', 'failed']);

function refHtml(m) {
  const kind = m.kindLabel ? `<span class="ckb-kind">${escapeHtml(m.kindLabel)}</span>` : '';
  if (!m.ref) return kind;
  return kind + (m.refMono ? `<span class="o-ref">${escapeHtml(m.ref)}</span>` : `<span>${escapeHtml(m.ref)}</span>`);
}

function statusText(m, now) {
  const age = AGED.has(m.tone) && m.time ? relPast(m.time, now) : '';
  return age ? `${m.status.text} · ${age}` : m.status.text;
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
      <span class="ckb-ref"></span>
      <span class="o-row-title ckb-title"></span>
      <span class="ckb-status"></span>
      <span class="ckb-act"></span>
      <button type="button" class="o-btn o-btn--ghost sm ckb-archive" hidden>Archive</button>
      <button type="button" class="ckb-caret" aria-expanded="false" aria-label="Expand">▸</button>
    </div>
    <div class="ckb-feeds"></div>
    <div class="ckb-body" hidden></div>`;
  const dom = {
    glyph: el.querySelector('.ckb-glyph'), ref: el.querySelector('.ckb-ref'), title: el.querySelector('.ckb-title'),
    status: el.querySelector('.ckb-status'), act: el.querySelector('.ckb-act'), archive: el.querySelector('.ckb-archive'),
    caret: el.querySelector('.ckb-caret'), feeds: el.querySelector('.ckb-feeds'), body: el.querySelector('.ckb-body'),
  };
  let current = model;
  let sig = '';
  let body = null;
  let bodyMode = null;

  el.querySelector('.ckb-line').addEventListener('click', (e) => {
    if (e.target.closest('button') && !e.target.closest('.ckb-caret')) return;
    if (current.kind === 'other') { ctx.onOpenFull(current); return; }
    ctx.onToggle(current, 'caret');
  });
  dom.act.addEventListener('click', (e) => { e.stopPropagation(); ctx.onAction(current); });
  dom.archive.addEventListener('click', (e) => { e.stopPropagation(); ctx.onArchive(current); });
  el.addEventListener('pointerenter', () => ctx.onHover(current.key, true));
  el.addEventListener('pointerleave', () => ctx.onHover(current.key, false));

  function update(m, view) {
    current = m;
    el.dataset.rowKey = m.key;
    el.dataset.tone = m.tone;
    el.classList.toggle('is-selected', view.selected);
    const nextSig = [m.tone, m.ref, m.kindLabel, m.title, statusText(m, view.now), m.status.tone, m.actionLabel].join('|');
    if (nextSig !== sig) {
      sig = nextSig;
      dom.glyph.textContent = GLYPH[m.tone];
      dom.glyph.className = `o-row-icon ckb-glyph ${ICON_CLASS[m.tone]}`;
      dom.ref.innerHTML = refHtml(m);
      dom.title.textContent = m.title;
      dom.status.textContent = statusText(m, view.now);
      dom.status.dataset.tone = m.status.tone;
      dom.act.innerHTML = m.actionLabel
        ? `<button type="button" class="o-btn o-btn--default sm">${escapeHtml(m.actionLabel)}</button>`
        : '';
    }
    dom.archive.hidden = m.kind !== 'session';
    dom.caret.hidden = m.kind === 'other';
    dom.caret.setAttribute('aria-expanded', String(!!view.mode));
    dom.caret.textContent = view.mode ? '▾' : '▸';

    const hide = new Set(view.hideFeeds);
    syncFeeds(dom.feeds, m.feeds.filter((f) => !hide.has(f.sessionId)), { jobId: m.kind === 'job' ? m.id : null });

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
      dom.archive.textContent = on ? 'Archiving…' : 'Archive';
      if (error) { dom.status.textContent = error; dom.status.dataset.tone = 'failed'; sig = ''; }
    },
    destroy() { body?.unmount(); teardownFeeds(dom.feeds); el.remove(); },
  };
}
