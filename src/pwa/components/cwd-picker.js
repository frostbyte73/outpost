// Mobile cwd-picker + add-project bottom sheets. Two sheets that share the same
// pattern — dynamically-injected `<aside>` with backdrop, RAF-driven slide-in,
// clean up on close. Called from the mobile session list and from
// daemon_error handling (bad-cwd bounce).
//
// The "recents" list reads from the sessions store; committing a cwd assigns
// a fresh UUID for the pending session and calls openSession(). App.js
// installs its state ref + a couple of callbacks via initCwdPicker().

import { sessions } from '../state/sessions.js';
import { usage } from '../state/usage.js';
import { escapeHtml } from '../util.js';
import {
  dismissSoftKeyboard,
  pinSheetBelowHeader,
  noteSheetOpen,
  noteSheetClose,
  makeSheetDismissible,
} from './sheet-utils.js';

let _deps = {
  appState: null,
  openSession: () => {},
  loadSessions: async () => {},
  render: () => {},
  setProjectExpanded: () => {},
};

export function initCwdPicker(deps) {
  _deps = { ..._deps, ...deps };
}

export function openCwdPickerSheet(initialError) {
  dismissSoftKeyboard();
  closeCwdPickerSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop cwd-picker-sheet-backdrop';
  backdrop.id = 'cwd-picker-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet cwd-picker-sheet';
  sheet.id = 'cwd-picker-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Pick a directory');
  sheet.innerHTML = cwdPickerBodyHtml(initialError);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  pinSheetBelowHeader(sheet);
  noteSheetOpen(closeCwdPickerSheet);
  makeSheetDismissible(sheet, closeCwdPickerSheet);
  bindCwdPickerHandlers(sheet, backdrop);
}

export function closeCwdPickerSheet() {
  const backdrop = document.getElementById('cwd-picker-sheet-backdrop');
  const sheet = document.getElementById('cwd-picker-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => { backdrop?.remove(); sheet?.remove(); }, 360);
}

// surfaces a cwd in the session list before claude has touched it
export function openAddProjectSheet() {
  dismissSoftKeyboard();
  closeAddProjectSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop add-project-sheet-backdrop';
  backdrop.id = 'add-project-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet add-project-sheet';
  sheet.id = 'add-project-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Add project');
  sheet.innerHTML = `
    <div class="grabber"></div>
    <div class="header-row">
      <span class="sheet-title">Add project</span>
      <button class="sheet-close" id="add-project-close" aria-label="Close">✕</button>
    </div>
    <form class="add-project-form" id="add-project-form" autocomplete="off">
      <span class="add-project-label">Path</span>
      <input type="text" id="add-project-input" inputmode="url" autocapitalize="off"
             autocorrect="off" spellcheck="false"
             placeholder="~/projects/foo" />
      <button type="submit" class="add-project-submit">Add</button>
      <div class="add-project-error" id="add-project-error" hidden></div>
    </form>
  `;
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  pinSheetBelowHeader(sheet);
  noteSheetOpen(closeAddProjectSheet);
  makeSheetDismissible(sheet, closeAddProjectSheet);

  const input = sheet.querySelector('#add-project-input');
  const form = sheet.querySelector('#add-project-form');
  const errorEl = sheet.querySelector('#add-project-error');
  sheet.querySelector('#add-project-close').onclick = closeAddProjectSheet;
  backdrop.onclick = closeAddProjectSheet;
  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const raw = input.value.trim();
    if (!raw) return;
    const home = usage.get().daemonInfo?.home;
    const cwd = (home && raw.startsWith('~')) ? raw.replace(/^~/, home) : raw;
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const text = await res.text();
        errorEl.textContent = text || `Error: ${res.status}`;
        errorEl.hidden = false;
        return;
      }
      // Auto-expand the new row so the user sees "+ New session" without an extra tap.
      // Two-phase: fetch /api/sessions, learn the projectDir for the new cwd, set the
      // expand flag, then re-render so it shows open.
      closeAddProjectSheet();
      await _deps.loadSessions();
      const justAdded = sessions.get().projects.find((p) => p.cwd === cwd);
      if (justAdded) {
        _deps.setProjectExpanded(justAdded.projectDir, true);
        _deps.render();
      }
    } catch (err) {
      errorEl.textContent = `Network error: ${err?.message ?? err}`;
      errorEl.hidden = false;
    }
  });
}

export function closeAddProjectSheet() {
  const backdrop = document.getElementById('add-project-sheet-backdrop');
  const sheet = document.getElementById('add-project-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => { backdrop?.remove(); sheet?.remove(); }, 360);
}

function cwdPickerBodyHtml(initialError) {
  const recents = sessions.get().projects.map((p) => {
    const basename = p.cwd.split('/').filter(Boolean).pop() || p.cwd;
    // RTL on cwd line so the basename tail stays visible when the path overflows.
    return `
      <button class="cwd-picker-row" type="button" data-cwd="${escapeHtml(p.cwd)}">
        <span class="cwd-picker-row-name">${escapeHtml(basename)}</span>
        <span class="cwd-picker-row-cwd"><span>${escapeHtml(p.cwd)}</span></span>
      </button>
    `;
  }).join('');
  const errorBlock = initialError
    ? `<div class="cwd-picker-error">
         <span class="cwd-picker-error-label">Path rejected</span>
         ${escapeHtml(initialError.message)}
       </div>`
    : '';
  const customValue = initialError?.failedCwd ? `value="${escapeHtml(initialError.failedCwd)}"` : '';
  const hasRecents = sessions.get().projects.length > 0;
  return `
    <div class="grabber"></div>
    <div class="header-row">
      <span class="sheet-title">New session</span>
      <button class="sheet-close" id="cwd-picker-sheet-close" aria-label="Close">✕</button>
    </div>
    ${errorBlock}
    ${hasRecents
      ? `<div class="cwd-picker-eyebrow">Recent projects</div>
         <div class="cwd-picker-recents">${recents}</div>`
      : `<div class="cwd-picker-empty">No projects yet — start one below.</div>`
    }
    <div class="cwd-picker-custom">
      <span class="cwd-picker-custom-label">${hasRecents ? 'Or open a fresh path' : 'Where should claude run?'}</span>
      <form class="cwd-picker-prompt" id="cwd-picker-custom-form" autocomplete="off">
        <input type="text" id="cwd-picker-custom-input" inputmode="url" autocapitalize="off"
               autocorrect="off" spellcheck="false"
               placeholder="~/projects/foo" ${customValue} />
        <button type="submit" id="cwd-picker-custom-go" aria-label="Open">↵</button>
      </form>
    </div>
  `;
}

function bindCwdPickerHandlers(sheet, backdrop) {
  for (const row of sheet.querySelectorAll('.cwd-picker-row')) {
    row.onclick = () => commitNewSessionCwd(row.dataset.cwd);
  }
  const close = sheet.querySelector('#cwd-picker-sheet-close');
  if (close) close.onclick = () => closeCwdPickerSheet();
  backdrop.onclick = () => closeCwdPickerSheet();
  const input = sheet.querySelector('#cwd-picker-custom-input');
  const form = sheet.querySelector('#cwd-picker-custom-form');
  const submitCustom = (e) => {
    if (e) e.preventDefault();
    const raw = (input?.value || '').trim();
    if (!raw) { input?.focus(); return; }
    // Client-side ~ expansion using the daemon's $HOME (surfaced via /api/info).
    // The daemon enforces absolute paths anyway, so a missing home just means
    // the user has to type the absolute path themselves.
    const home = usage.get().daemonInfo?.home;
    const expanded = (home && raw.startsWith('~')) ? raw.replace(/^~/, home) : raw;
    commitNewSessionCwd(expanded);
  };
  if (form) form.addEventListener('submit', submitCustom);
}

// git-repo callers pass spawnMode='worktree' + baseBranch; non-git omits both
// for shared-cwd.
export function commitNewSessionCwd(cwd, opts = {}) {
  closeCwdPickerSheet();
  const id = crypto.randomUUID();
  if (_deps.appState) _deps.appState.pendingNewSession = { id, cwd };
  _deps.openSession(id, {
    cwd,
    ...(opts.spawnMode ? { spawn: opts.spawnMode } : {}),
    ...(opts.baseBranch ? { base: opts.baseBranch } : {}),
  });
}
