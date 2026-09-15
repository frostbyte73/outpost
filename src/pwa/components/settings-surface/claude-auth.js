import { escapeHtml } from '../../util.js';
import { grantsStore } from '../../state/grants.js';
import { metaApi } from '../../net/meta.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { detailShell, block } from './detail-shell.js';
import { claudeAccountRow } from '../../vm/settings.js';

// Settings > Claude account. Sibling of mcp.js, one level up: that panel re-authorizes
// individual MCP servers, this one re-authorizes Claude Code itself.
//
// The reason it exists as a remote flow at all is that a lapse here is self-blocking — every
// spawned session dies at startup, so there is no session left that could run `claude auth
// login` for you. The daemon drives the CLI directly instead, and the only part that needs a
// human is the consent screen, which can be on any device.
//
// Unlike the MCP flow, step 2 is not a failure to explain away: the redirect goes to a hosted
// claude.com callback, so the authorizing device lands on a page that loads and shows a code.

function accountHtml(row, loaded) {
  if (!loaded) return '<div class="settings-loading">Loading…</div>';
  if (!row) return '<p class="settings-note">Could not read the account state.</p>';
  return `
    <div class="o-row">
      <span class="o-row-icon ${row.tone === 'danger' ? 'hot' : 'ok'}">✦</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.title)}</div>
        ${row.sub ? `<div class="o-row-sub">${escapeHtml(row.sub)}</div>` : ''}
      </div>
      <div class="mcp-row-state">
        <span class="o-pill ${escapeHtml(row.tone)}">${escapeHtml(row.statusLabel)}</span>
        <button type="button" class="o-btn o-btn--default sm claude-auth-start">
          ${row.needsAttention ? 'Sign in…' : 'Re-authorize…'}
        </button>
      </div>
    </div>
    ${row.note ? `<p class="settings-note">${escapeHtml(row.note)}</p>` : ''}
  `;
}

function flowHtml(state) {
  const { flow, busy, error, copied, pasted, reloaded } = state;
  if (busy === 'starting') return '<div class="settings-loading">Starting the login…</div>';
  if (error && !flow) return `<div class="permgroup-rule-error">${escapeHtml(error)}</div>`;
  if (!flow) return '';
  if (flow.status === 'done') {
    return `<div class="mcp-auth-card ok">
      <p class="mcp-auth-done">✓ Signed in.${reloaded ? ' Running sessions were reloaded to pick it up.' : ''}</p>
      <button type="button" class="o-btn o-btn--ghost sm claude-auth-dismiss">Dismiss</button>
    </div>`;
  }
  return `
    <div class="mcp-auth-card" data-flow="${escapeHtml(flow.id)}">
      <ol class="mcp-auth-steps">
        <li>
          <span>Open the sign-in page and approve it — on this device or any other.</span>
          <div class="mcp-auth-actions">
            <a class="o-btn o-btn--primary sm" href="${escapeHtml(flow.authUrl)}"
               target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>
            <button type="button" class="o-btn o-btn--default sm claude-auth-copy">${copied ? 'Copied' : 'Copy link'}</button>
          </div>
        </li>
        <li><span>Approve it, and the page will show you a <strong>code</strong>. Copy it.</span></li>
        <li>
          <span>Paste it here.</span>
          <div class="mcp-auth-actions">
            <input type="text" class="claude-auth-input" autocapitalize="off" autocorrect="off"
              spellcheck="false" placeholder="code#state"
              value="${escapeHtml(pasted ?? '')}"${busy ? ' disabled' : ''}>
            <button type="button" class="o-btn o-btn--primary sm claude-auth-finish"${busy ? ' disabled' : ''}>${busy === 'submitting' ? 'Finishing…' : 'Finish'}</button>
            <button type="button" class="o-btn o-btn--ghost sm claude-auth-cancel"${busy ? ' disabled' : ''}>Cancel</button>
          </div>
        </li>
      </ol>
      ${error ? `<div class="permgroup-rule-error">${escapeHtml(error)}</div>` : ''}
    </div>
  `;
}

export function renderClaudeAuth(mount) {
  const body = detailShell(mount, 'Claude account',
    'The sign-in every spawned session runs on. When this lapses nothing can start — including a session that could fix it — so it is re-authorized from here instead.');
  const section = block(body, 'Account', `
    <div class="o-row-group claude-auth-account"></div>
    <div class="claude-auth-flow"></div>
  `);
  const accountEl = section.querySelector('.claude-auth-account');
  const flowEl = section.querySelector('.claude-auth-flow');

  const state = { flow: null, busy: null, error: null, copied: false, pasted: '', reloaded: false };

  function paintAccount() {
    const snap = grantsStore.get();
    setHtmlIfChanged(accountEl, accountHtml(claudeAccountRow(snap.claudeAuth), !!snap.claudeAuth));
  }

  // Not setHtmlIfChanged: a repaint mid-flow would cost a half-typed paste its caret, so this
  // runs only on the transitions that actually change the card.
  function paintFlow() {
    flowEl.innerHTML = flowHtml(state);
  }

  async function startFlow() {
    state.busy = 'starting';
    state.flow = null;
    state.error = null;
    state.pasted = '';
    state.reloaded = false;
    paintFlow();
    try {
      const data = await metaApi.claudeAuthStart();
      state.flow = data?.flow ?? null;
    } catch (e) {
      state.error = e.body || e.message;
    } finally {
      state.busy = null;
      paintFlow();
      flowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function finishFlow() {
    if (!state.flow || !state.pasted.trim()) return;
    state.busy = 'submitting';
    state.error = null;
    paintFlow();
    try {
      const data = await metaApi.claudeAuthSubmit(state.flow.id, state.pasted.trim());
      const flow = data?.flow ?? null;
      if (flow?.status === 'done') {
        state.flow = flow;
        state.pasted = '';
        state.reloaded = true;
        await grantsStore.loadClaudeAuth();
      } else {
        // A failed exchange keeps the card open with the CLI's own reason: the usual cause is
        // a stale code, and the fix is to run the link again, not to re-paste.
        state.error = flow?.error || 'the sign-in could not be completed';
        state.flow = null;
      }
    } catch (e) {
      state.error = e.body || e.message;
    } finally {
      state.busy = null;
      paintFlow();
    }
  }

  async function cancelFlow() {
    const id = state.flow?.id;
    state.flow = null;
    state.error = null;
    state.pasted = '';
    paintFlow();
    if (id) await metaApi.claudeAuthCancel(id).catch(() => {});
  }

  body.addEventListener('click', (e) => {
    if (e.target.closest('.claude-auth-start')) { void startFlow(); return; }
    if (e.target.closest('.claude-auth-copy')) {
      void navigator.clipboard.writeText(state.flow?.authUrl ?? '').then(() => {
        state.copied = true;
        paintFlow();
      });
      return;
    }
    if (e.target.closest('.claude-auth-finish')) { void finishFlow(); return; }
    if (e.target.closest('.claude-auth-cancel')) { void cancelFlow(); return; }
    if (e.target.closest('.claude-auth-dismiss')) {
      state.flow = null;
      state.error = null;
      paintFlow();
    }
  });

  body.addEventListener('input', (e) => {
    if (e.target.classList.contains('claude-auth-input')) state.pasted = e.target.value;
  });

  // Enter is what a phone keyboard offers after a paste.
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('claude-auth-input')) {
      e.preventDefault();
      void finishFlow();
    }
  });

  paintAccount();
  paintFlow();
  const unsub = grantsStore.subscribe(paintAccount);
  void grantsStore.loadClaudeAuth().then(() => {
    // Picks up a login begun on another device — the case this whole flow exists for.
    const live = grantsStore.get().claudeAuth?.flow;
    if (live?.status === 'awaiting' && !state.flow && !state.busy) {
      state.flow = live;
      paintFlow();
    }
  });
  return unsub;
}
