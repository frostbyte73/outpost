import { escapeHtml } from '../../util.js';
import { settings } from '../../state/settings.js';
import { detailShell, block } from './detail-shell.js';
import {
  WRITES, clearPreapprovalsScope, readPreapprovalsControl, renderPreapprovalsControl, wirePreapprovalsControl,
} from '../work/preapprovals-control.js';

const SCOPE = 'settings-preapprovals';

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

  function paint() {
    form.innerHTML = `
      ${renderPreapprovalsControl(settings.get().preapprovalDefaults, { name: 'defaults' })}
      <div class="step-actions">
        <button type="button" class="o-btn o-btn--primary" data-role="save">Save</button>
      </div>`;
    wirePreapprovalsControl(form, SCOPE);
    form.querySelector('[data-role="save"]').addEventListener('click', () => {
      const value = readPreapprovalsControl(form.querySelector('fieldset.o-preapprovals'));
      clearPreapprovalsScope(SCOPE);
      settings.setPreapprovalDefaults(value);
    });
  }

  paint();
  return settings.subscribe(paint);
}
