import { escapeHtml } from '../../util.js';
import { settings } from '../../state/settings.js';
import { effective } from '../../vm/preapprovals.js';
import { detailShell, block } from './detail-shell.js';
import {
  WRITES, clearPreapprovalsScope, readPreapprovalsControl, renderPreapprovalsControl, wirePreapprovalsControl,
} from '../work/preapprovals-control.js';

const SCOPE = 'settings-preapprovals';
const STATUS_TEXT = {
  idle: '',
  saving: '',
  saved: 'Saved — running jobs pick this up now',
  failed: 'Couldn’t save — the daemon didn’t accept it. Your changes are still here.',
};

const sameValue = (a, b) => JSON.stringify(effective(a)) === JSON.stringify(effective(b));

export function renderPreapprovalDefaults(mount) {
  const body = detailShell(
    mount,
    'Pre-approvals',
    'Writes every job may run without asking you first. A job, schedule or step that sets its own value overrides these, and changes reach jobs already running.',
  );
  const formSection = block(body, 'Defaults', '<div data-role="form"></div>');
  const form = formSection.querySelector('[data-role="form"]');
  block(body, 'What each one covers', `
    <dl class="settings-preapprovals-legend">
      ${WRITES.map(([, label, hint]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(hint)}</dd>`).join('')}
    </dl>
    <p class="settings-note">Anything outside these shapes — another branch, a compound command, a risky flag — still comes to you as a card.</p>
  `);

  let status = 'idle';
  const fieldset = () => form.querySelector('fieldset.o-preapprovals');

  function sync() {
    const save = form.querySelector('[data-role="save"]');
    const statusEl = form.querySelector('[data-role="status"]');
    const dirty = !sameValue(readPreapprovalsControl(fieldset()), settings.get().preapprovalDefaults);
    save.disabled = status === 'saving' || !dirty;
    save.textContent = status === 'saving' ? 'Saving…' : 'Save';
    statusEl.dataset.state = status;
    statusEl.textContent = STATUS_TEXT[status];
  }

  function paint() {
    form.innerHTML = `
      ${renderPreapprovalsControl(settings.get().preapprovalDefaults, { name: 'defaults' })}
      <div class="settings-save-row">
        <button type="button" class="o-btn o-btn--primary" data-role="save">Save</button>
        <span class="settings-save-status" data-role="status" role="status"></span>
      </div>`;
    wirePreapprovalsControl(form, SCOPE);
    form.querySelector('[data-role="save"]').addEventListener('click', async () => {
      status = 'saving';
      const ok = await settings.setPreapprovalDefaults(readPreapprovalsControl(fieldset()));
      if (ok) clearPreapprovalsScope(SCOPE);
      status = ok ? 'saved' : 'failed';
      paint();
    });
    sync();
  }

  form.addEventListener('change', () => {
    if (status !== 'saving') status = 'idle';
    sync();
  });

  paint();
  return settings.subscribe(paint);
}
