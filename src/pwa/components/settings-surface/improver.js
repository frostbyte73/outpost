import { escapeHtml } from '../../util.js';
import { settings } from '../../state/settings.js';
import { actionsApi } from '../../net/actions.js';
import { improverAgreementRows } from '../../vm/settings.js';
import { detailShell, block } from './detail-shell.js';

export function renderImprover(mount) {
  const body = detailShell(
    mount,
    'Improver',
    'Every revision meta.improve-actions proposes is replayed against the runs it cites and graded blind before it reaches you.',
  );
  const toggle = block(body, 'Auto-apply', `
    <div class="settings-segmented" data-role="auto-apply">
      <button type="button" data-value="off">Off</button>
      <button type="button" data-value="on">On</button>
    </div>
    <p class="settings-note">On: a passing eval installs the revision without asking, and a failing one is dropped. Either way it shows in the skill's History, where an auto-applied revision can be undone. The orchestrators and the improver itself always wait for you.</p>
  `);
  const tally = block(body, 'Shadow agreement', '<div class="settings-loading">Loading…</div>');

  function paint() {
    const on = settings.get().improverAutoApply;
    for (const btn of toggle.querySelectorAll('button[data-value]')) {
      btn.classList.toggle('active', btn.dataset.value === (on ? 'on' : 'off'));
    }
  }

  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) settings.setImproverAutoApply(btn.dataset.value === 'on');
  });

  actionsApi.evalAgreement().then((a) => {
    const rows = improverAgreementRows(a)
      .map(([label, value]) => `<div class="settings-kv"><span class="settings-kv-label">${escapeHtml(label)}</span><span class="settings-kv-value">${escapeHtml(value)}</span></div>`)
      .join('');
    tally.innerHTML = `<h3 class="o-microhead">Shadow agreement</h3>${rows}
      <p class="settings-note">How often the eval's verdict matched yours on the same proposal. A pass you rejected is what auto-apply would have shipped.</p>`;
  }).catch((err) => {
    tally.innerHTML = `<h3 class="o-microhead">Shadow agreement</h3><p class="settings-note">${escapeHtml(err.message)}</p>`;
  });

  paint();
  return settings.subscribe(paint);
}
