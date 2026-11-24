import { PIN_TITLE_MAX } from '../../vm/cockpit-layout.js';

const GRIP = '<svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg>';
const NEW_LABEL = { jobs: '+ New job', sessions: '+ New session' };
const JOB_GROUPS = ['started', 'notStarted'];
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// One section of the board: header (grip, title, counts, action) plus its row groups or chips.
export function createSection(initial, ctx) {
  const el = document.createElement('section');
  el.className = 'ckb-section';
  el.dataset.section = initial.id;
  el.dataset.kind = initial.kind;
  const isPin = initial.kind === 'pinned';
  el.innerHTML = `
    <div class="o-group-hdr ckb-sec-hdr">
      <button type="button" class="o-grip ckb-grip">${GRIP}</button>
      <h2>${isPin ? '<button type="button" class="ckb-pin-title"></button>' : ''}</h2>
      <span class="ckb-need" hidden></span>
      <span class="o-group-count"></span>
      <span class="o-group-rule"></span>
      ${isPin ? '<button type="button" class="ckb-pin-remove" aria-label="Remove section" title="Remove section" hidden>×</button>' : ''}
      ${NEW_LABEL[initial.kind] ? `<button type="button" class="o-btn o-btn--ghost sm" data-ckb-new>${NEW_LABEL[initial.kind]}</button>` : ''}
    </div>
    ${bodySkeleton(initial.kind, initial.id)}`;
  const dom = {
    grip: el.querySelector('.ckb-grip'),
    h2: el.querySelector('h2'),
    title: el.querySelector('.ckb-pin-title'),
    need: el.querySelector('.ckb-need'),
    count: el.querySelector('.o-group-count'),
    remove: el.querySelector('.ckb-pin-remove'),
  };
  const chipEls = new Map();
  let current = initial;
  let renaming = false;

  if (dom.title) dom.title.addEventListener('click', startRename);
  dom.remove?.addEventListener('click', () => ctx.onRemove(current.pinId));
  dom.grip.addEventListener('keydown', (e) => {
    if (!ARROWS.has(e.key)) return;
    e.preventDefault();
    ctx.onGripKey(current.id, e.key);
  });
  el.querySelector('[data-ckb-new]')?.addEventListener('click', () => ctx.onNew(current.kind));

  function startRename() {
    if (renaming) return;
    renaming = true;
    const input = document.createElement('input');
    input.className = 'ckb-pin-rename';
    input.maxLength = PIN_TITLE_MAX;
    input.value = current.title;
    input.setAttribute('aria-label', 'Section name');
    dom.title.hidden = true;
    dom.h2.appendChild(input);
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      renaming = false;
      const value = input.value;
      input.remove();
      dom.title.hidden = false;
      dom.title.focus();
      if (commit) ctx.onRename(current.pinId, value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  function rowsOf(r) {
    return r.kind === 'jobs' ? JOB_GROUPS.flatMap((g) => r.groups[g]) : r.rows;
  }

  function update(r) {
    current = r;
    if (isPin) { if (!renaming) setText(dom.title, r.title); }
    else setText(dom.h2, r.title);
    dom.grip.setAttribute('aria-label', `Move ${r.title}`);
    dom.need.hidden = !r.needYou;
    setText(dom.need, r.needYou ? `● ${r.needYou}` : '');
    setText(dom.count, String(rowsOf(r).length));
    if (dom.remove) dom.remove.hidden = rowsOf(r).length > 0;
    if (r.kind === 'jobs') updateJobs(r);
    if (r.kind === 'other') updateChips(r.rows);
  }

  function updateJobs(r) {
    el.querySelector('[data-divider="notStarted"]').hidden = !r.groups.notStarted.length;
  }

  function updateChips(rows) {
    const strip = el.querySelector('.ckb-chips');
    el.querySelector('.ckb-none').hidden = rows.length > 0;
    const live = new Set();
    for (const m of rows) {
      live.add(m.key);
      let chip = chipEls.get(m.key);
      if (!chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'o-chip ckb-chip';
        chip.dataset.rowKey = m.key;
        chip.innerHTML = '<b></b><span></span>';
        chip.addEventListener('click', () => ctx.onChip(chip.dataset.rowKey));
        chipEls.set(m.key, chip);
      }
      chip.dataset.tone = m.tone;
      setText(chip.firstChild, m.kindLabel ?? '');
      setText(chip.lastChild, m.ref ?? m.title ?? '');
      chip.title = m.ref ? `${m.ref} — ${m.title}` : (m.title ?? '');
      strip.appendChild(chip);
    }
    for (const [k, chip] of chipEls) if (!live.has(k)) { chip.remove(); chipEls.delete(k); }
  }

  update(initial);
  return {
    el,
    update,
    get model() { return current; },
    rowGroups() {
      if (current.kind === 'other') return [];
      if (current.kind === 'jobs') {
        return JOB_GROUPS.map((g) => ({
          id: `jobs:${g}`, container: el.querySelector(`[data-group="${g}"]`), rows: current.groups[g], stabilize: true,
        }));
      }
      return [{ id: current.id, container: el.querySelector('.o-row-group'), rows: current.rows, stabilize: current.kind !== 'pinned' }];
    },
    chips() {
      return current.kind === 'other' ? current.rows.map((m) => ({ key: m.key, el: chipEls.get(m.key), model: m })) : [];
    },
    destroy() { el.remove(); },
  };
}

function bodySkeleton(kind, id) {
  if (kind === 'jobs') {
    return `
      <div class="o-row-group" data-group="started"></div>
      <div class="ckb-divider o-microhead" data-divider="notStarted" hidden>Not started</div>
      <div class="o-row-group" data-group="notStarted"></div>`;
  }
  if (kind === 'other') return '<div class="ckb-chips"></div><div class="ckb-none" hidden>Nothing waiting</div>';
  return `<div class="o-row-group" data-group="${id}"></div>`;
}
