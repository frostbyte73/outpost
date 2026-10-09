import { escapeHtml } from '../../util.js';
import { updateStore, updateAvailable } from '../../state/update.js';
import { updateStatusLine } from '../../vm/settings.js';
import { relPast } from '../../utils/formatting.js';
import { detailShell, block } from './detail-shell.js';

export function renderUpdates(mount) {
  const body = detailShell(
    mount,
    'Updates',
    'Pulls the latest main into this checkout, then restarts Outpost once nothing is running.',
  );
  const section = block(body, 'Version', `
    <div data-role="kv"></div>
    <p class="settings-note" data-role="line"></p>
    <div class="settings-row settings-row--start">
      <button type="button" class="o-btn o-btn--primary sm" data-role="apply">Update now</button>
      <button type="button" class="o-btn o-btn--ghost sm" data-role="check">Check now</button>
    </div>
  `);
  const autoSection = block(body, 'Automatic updates', `
    <label class="settings-check">
      <input type="checkbox" data-role="auto" />
      <span>Pull updates automatically</span>
    </label>
    <p class="settings-note">Checked once a day. Running sessions finish their turn before the restart.</p>
  `);
  const kvEl = section.querySelector('[data-role="kv"]');
  const lineEl = section.querySelector('[data-role="line"]');
  const applyBtn = section.querySelector('[data-role="apply"]');
  const checkBtn = section.querySelector('[data-role="check"]');
  const autoBox = autoSection.querySelector('[data-role="auto"]');

  function paint() {
    const { status: s, busy, error } = updateStore.get();
    kvEl.innerHTML = s
      ? `<div class="settings-kv"><span class="settings-kv-label">Running</span><span class="settings-kv-value">${escapeHtml(s.current ?? '—')}</span></div>
         <div class="settings-kv"><span class="settings-kv-label">Latest main</span><span class="settings-kv-value">${escapeHtml(s.latest ?? '—')}</span></div>
         <div class="settings-kv"><span class="settings-kv-label">Last checked</span><span class="settings-kv-value">${escapeHtml(relPast(s.checkedAt) ?? 'never')}</span></div>`
      : '';
    lineEl.textContent = error ?? updateStatusLine(s);
    const inFlight = busy || s?.phase === 'checking' || s?.phase === 'applying';
    applyBtn.disabled = inFlight || !updateAvailable(s);
    checkBtn.disabled = inFlight;
    autoBox.checked = !!s?.autoUpdate;
    autoBox.disabled = busy || !s;
  }

  applyBtn.addEventListener('click', () => void updateStore.apply());
  checkBtn.addEventListener('click', () => void updateStore.check());
  autoBox.addEventListener('change', () => void updateStore.setAuto(autoBox.checked));

  paint();
  void updateStore.load();
  return updateStore.subscribe(paint);
}
