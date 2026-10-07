import { escapeHtml } from '../../util.js';
import { PRESETS, effective, presetOf } from '../../vm/preapprovals.js';

const PRESET_LABELS = { gated: 'Gated', routine: 'Routine', personal: 'Personal', custom: 'Custom' };
const SPEC_LABELS = { gate: 'Ask me to approve it', auto: 'Write it, don’t ask', skip: 'Skip spec and plan' };
const LANDING_LABELS = { merged: 'PR merged', approved: 'PR approved + green', direct: 'Pushed to base, no PR' };
export const WRITES = [
  ['push', 'Commit + push', 'Any commit and push to the step’s own branch'],
  ['openPr', 'Open the PR', 'Opening the PR from the step’s branch onto its base'],
  ['replies', 'Reply to comments', 'Replies on the step’s own PR'],
  ['merge', 'Merge', 'Merging the PR once it’s approved, green and at the same head'],
  ['syncBase', 'Merge base in', 'Committing and pushing a merge of origin/<base> — conflict fixes included'],
];

function options(labels, selected) {
  return Object.entries(labels)
    .map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${escapeHtml(l)}</option>`)
    .join('');
}

// `name` keys the fieldset so a caller holding several (one per plan step) can read each back.
export function renderPreapprovalsControl(value, { name, loosened = [] } = {}) {
  const e = effective(value);
  const flag = (k) => (loosened.includes(k) ? ' data-loosened="true" title="The planner proposed this past the job’s settings"' : '');
  return `
    <fieldset class="o-preapprovals" data-name="${escapeHtml(name ?? '')}">
      <label class="o-preapprovals-row"><span class="k">Pre-approvals</span>
        <select data-pre="preset">${options(PRESET_LABELS, presetOf(value))}</select>
      </label>
      <label class="o-preapprovals-row"${flag('spec')}><span class="k">Spec</span>
        <select data-pre="spec">${options(SPEC_LABELS, e.spec)}</select>
      </label>
      <div class="o-preapprovals-row"><span class="k">Don’t ask before</span>
        <div class="o-preapprovals-writes">
          ${WRITES.map(([k, l, hint]) => `<label${flag(k)} title="${escapeHtml(hint)}"><input type="checkbox" data-pre="${k}"${e[k] ? ' checked' : ''}> ${escapeHtml(l)}</label>`).join('')}
        </div>
      </div>
      <label class="o-preapprovals-row"${flag('landing')}><span class="k">Done when</span>
        <select data-pre="landing">${options(LANDING_LABELS, e.landing)}</select>
      </label>
    </fieldset>`;
}

export function readPreapprovalsControl(fieldset) {
  const get = (k) => fieldset.querySelector(`[data-pre="${k}"]`);
  return {
    spec: get('spec').value,
    push: get('push').checked,
    openPr: get('openPr').checked,
    replies: get('replies').checked,
    merge: get('merge').checked,
    syncBase: get('syncBase').checked,
    landing: get('landing').value,
  };
}

function apply(fieldset, value) {
  for (const [k, v] of Object.entries(value)) {
    const el = fieldset.querySelector(`[data-pre="${k}"]`);
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
}

// Unsubmitted edits, kept across the innerHTML repaint every store update triggers.
const pending = new Map();

export function clearPreapprovalsScope(scope) {
  for (const key of [...pending.keys()]) if (key.startsWith(`${scope}\n`)) pending.delete(key);
}

export function wirePreapprovalsControl(root, scope) {
  for (const fieldset of root.querySelectorAll('fieldset.o-preapprovals')) {
    const preset = fieldset.querySelector('[data-pre="preset"]');
    const key = scope ? `${scope}\n${fieldset.dataset.name}` : undefined;
    if (key && pending.has(key)) {
      apply(fieldset, pending.get(key));
      preset.value = presetOf(pending.get(key));
    }
    fieldset.addEventListener('change', (ev) => {
      if (ev.target === preset) {
        if (PRESETS[preset.value]) apply(fieldset, PRESETS[preset.value]);
      } else {
        preset.value = presetOf(readPreapprovalsControl(fieldset));
      }
      if (key) pending.set(key, readPreapprovalsControl(fieldset));
    });
  }
}
