import { escapeHtml } from '../../util.js';
import { keymap } from '../../state/keymap.js';
import { hotkeyRows } from '../../vm/settings.js';
import { formatCombo, normalizeEvent } from '../../utils/hotkey.js';

// Desktop-only Hotkeys settings page. Registry owns the data; this renders the
// per-surface rows and drives the record/reset interactions. A capture-phase
// listener installed only while recording suppresses the global keymap so the
// combo being recorded doesn't fire the shortcut it's about to become.

const REASON_TEXT = {
  modifier: 'Shell shortcuts must include a modifier (⌘ or Ctrl).',
  reserved: 'That combo is reserved by your browser or OS.',
};

export function renderHotkeys(mount) {
  let recordingId = null;
  let captureListener = null;

  mount.innerHTML = `
    <div class="settings-detail">
      <div class="settings-detail-hdr">
        <h1>Keyboard shortcuts</h1>
        <p class="settings-detail-lede">Rebind any command. Bindings sync across your devices. Some combos still won't fire in a non-installed browser tab even when allowed.</p>
      </div>
      <div class="settings-detail-body">
        <div class="hk-toolbar"><button type="button" class="o-btn o-btn--default hk-reset-all">Reset all to defaults</button></div>
        <div class="hk-groups"></div>
      </div>
    </div>`;

  const groupsEl = mount.querySelector('.hk-groups');

  function stopRecording() {
    if (captureListener) { document.removeEventListener('keydown', captureListener, true); captureListener = null; }
    recordingId = null;
  }

  function paint() {
    const groups = hotkeyRows(keymap.overridesSnapshot());
    groupsEl.innerHTML = groups.map((g) => `
      <section class="o-section settings-block hk-group">
        <h3 class="o-microhead">${escapeHtml(g.surfaceLabel)}</h3>
        <div class="hk-rows">
          ${g.rows.map((r) => `
            <div class="hk-row" data-id="${escapeHtml(r.id)}">
              <div class="hk-row-text">
                <div class="hk-row-label">${escapeHtml(r.label)}</div>
                <div class="hk-row-desc">${escapeHtml(r.description)}</div>
              </div>
              <div class="hk-row-controls">
                <span class="o-kbd hk-chip">${recordingId === r.id ? 'Press keys…' : escapeHtml(formatCombo(r.binding))}</span>
                <button type="button" class="o-btn o-btn--default sm hk-record">${recordingId === r.id ? 'Cancel' : 'Record'}</button>
                <button type="button" class="o-btn o-btn--default sm hk-reset"${r.isDefault ? ' disabled' : ''}>Reset</button>
              </div>
              <div class="hk-row-error" hidden></div>
            </div>`).join('')}
        </div>
      </section>`).join('');
  }

  function beginRecording(id) {
    stopRecording();
    recordingId = id;
    paint();
    captureListener = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stopRecording(); paint(); return; }
      const combo = normalizeEvent(e);
      if (combo == null) return; // modifier-only — wait for a real key
      const result = keymap.validate(id, combo);
      if (result.ok) { keymap.setBinding(id, combo); stopRecording(); paint(); return; }
      stopRecording();
      paint();
      showError(id, result);
    };
    document.addEventListener('keydown', captureListener, true);
  }

  function showError(id, result) {
    const errEl = groupsEl.querySelector(`.hk-row[data-id="${CSS.escape(id)}"] .hk-row-error`);
    if (!errEl) return;
    let msg = REASON_TEXT[result.reason] ?? 'That binding is not allowed.';
    if (result.reason === 'conflict' && result.conflictId) {
      const label = hotkeyRows().flatMap((g) => g.rows).find((r) => r.id === result.conflictId)?.label ?? result.conflictId;
      msg = `Conflicts with "${label}".`;
    }
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  groupsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.hk-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.hk-record')) {
      if (recordingId === id) { stopRecording(); paint(); }
      else beginRecording(id);
    } else if (e.target.closest('.hk-reset')) {
      stopRecording();
      keymap.resetBinding(id);
      paint();
    }
  });

  mount.querySelector('.hk-reset-all').addEventListener('click', () => keymap.resetAll());

  paint();
  const unsub = keymap.subscribe(paint);
  return () => { stopRecording(); unsub(); };
}
