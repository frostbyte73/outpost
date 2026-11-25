import { escapeHtml } from '../../util.js';
import { metaApi } from '../../net/meta.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { detailShell, block } from './detail-shell.js';
import { mountClaudeAuth } from './claude-auth.js';
import { runtimeRow } from '../../vm/settings.js';

// Settings > Runtimes. Every runtime that signs in gets the same block as Claude: a heading, its
// account row, and its sign-in card beneath. Claude's block is claude-auth.js, because its sign-in
// has a paste step. Codex and Cursor relay a link the CLI finishes on its own, so their blocks only
// poll while a sign-in is waiting. ACP agents come after, with add and remove, since Outpost cannot
// drive their login.

const LOGIN_RUNTIMES = [
  { id: 'codex', heading: 'Codex' },
  { id: 'cursor', heading: 'Cursor' },
];

const POLL_MS = 3000;

function placeholderHtml(state) {
  if (state.error) return `<div class="permgroup-rule-error">${escapeHtml(state.error)}</div>`;
  return '<div class="settings-loading">Loading…</div>';
}

function flowHtml(row, copied) {
  const flow = row.flow;
  if (!flow) return '';
  if (flow.status === 'done') {
    return `<div class="mcp-auth-card ok">
      <p class="mcp-auth-done">✓ Signed in to ${escapeHtml(row.label)}.</p>
      <button type="button" class="o-btn o-btn--ghost sm runtime-dismiss" data-id="${escapeHtml(row.id)}">Dismiss</button>
    </div>`;
  }
  if (flow.status === 'failed') {
    return `<div class="mcp-auth-card">
      <div class="permgroup-rule-error">${escapeHtml(flow.error || 'the sign-in could not be completed')}</div>
      <button type="button" class="o-btn o-btn--ghost sm runtime-dismiss" data-id="${escapeHtml(row.id)}">Dismiss</button>
    </div>`;
  }
  return `
    <div class="mcp-auth-card" data-flow="${escapeHtml(flow.id)}">
      <ol class="mcp-auth-steps">
        <li>
          <span>Open the sign-in page — on this device or any other.</span>
          <div class="mcp-auth-actions">
            <a class="o-btn o-btn--primary sm" href="${escapeHtml(flow.authUrl)}"
               target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>
            <button type="button" class="o-btn o-btn--default sm runtime-copy" data-id="${escapeHtml(row.id)}" data-what="url">${copied === `${row.id}:url` ? 'Copied' : 'Copy link'}</button>
          </div>
        </li>
        ${flow.code ? `
        <li>
          <span>Enter this one-time code: <strong class="runtime-code">${escapeHtml(flow.code)}</strong></span>
          <div class="mcp-auth-actions">
            <button type="button" class="o-btn o-btn--default sm runtime-copy" data-id="${escapeHtml(row.id)}" data-what="code">${copied === `${row.id}:code` ? 'Copied' : 'Copy code'}</button>
          </div>
        </li>` : ''}
        <li>
          <span>Approve it. This page updates by itself once ${escapeHtml(row.label)} confirms.</span>
          <div class="mcp-auth-actions">
            <button type="button" class="o-btn o-btn--ghost sm runtime-cancel" data-id="${escapeHtml(row.id)}">Cancel</button>
          </div>
        </li>
      </ol>
    </div>`;
}

function accountHtml(row, starting) {
  const waiting = row.flow?.status === 'awaiting';
  const action = row.canLogin && !waiting
    ? `<button type="button" class="o-btn o-btn--default sm runtime-login" data-id="${escapeHtml(row.id)}"${starting ? ' disabled' : ''}>${starting ? 'Starting…' : row.signedIn ? 'Re-authorize…' : 'Sign in…'}</button>`
    : '';
  return `
    <div class="o-row">
      <span class="o-row-icon ${row.tone === 'ok' ? 'ok' : ''}">✦</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.sub || row.label)}</div>
        ${row.note ? `<div class="o-row-sub">${escapeHtml(row.note)}</div>` : ''}
      </div>
      <div class="mcp-row-state">
        <span class="o-pill ${escapeHtml(row.tone)}">${escapeHtml(waiting ? 'Waiting for approval' : row.statusLabel)}</span>
        ${action}
      </div>
    </div>
  `;
}

function agentHtml(row) {
  return `
    <div class="o-row runtime-row" data-id="${escapeHtml(row.id)}">
      <span class="o-row-icon ${row.tone === 'ok' ? 'ok' : ''}">✦</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.label)}</div>
        ${row.sub ? `<div class="o-row-sub">${escapeHtml(row.sub)}</div>` : ''}
      </div>
      <div class="mcp-row-state">
        <span class="o-pill ${escapeHtml(row.tone)}">${escapeHtml(row.statusLabel)}</span>
        <button type="button" class="o-btn o-btn--ghost sm runtime-remove" data-id="${escapeHtml(row.id)}">Remove</button>
      </div>
    </div>
    ${row.note ? `<p class="settings-note">${escapeHtml(row.note)}</p>` : ''}
  `;
}

const CONNECT_FORM = `
  <p class="settings-note">Any agent that speaks the Agent Client Protocol over stdio. It is started with the command below on the daemon host, and runs gated like the others — it can read, but never push.</p>
  <div class="settings-row">
    <label class="settings-row-label" for="runtime-acp-id">ID</label>
    <input class="settings-row-input settings-row-input--wide" id="runtime-acp-id" type="text" spellcheck="false"
      autocapitalize="off" autocomplete="off" placeholder="gemini">
  </div>
  <div class="settings-row">
    <label class="settings-row-label" for="runtime-acp-label">Name</label>
    <input class="settings-row-input settings-row-input--wide" id="runtime-acp-label" type="text" autocomplete="off" placeholder="Optional — defaults to the ID">
  </div>
  <div class="settings-row">
    <label class="settings-row-label" for="runtime-acp-command">Command</label>
    <input class="settings-row-input settings-row-input--wide" id="runtime-acp-command" type="text" spellcheck="false"
      autocapitalize="off" autocomplete="off" placeholder="gemini --experimental-acp">
  </div>
  <div class="runtime-acp-error"></div>
  <button type="button" class="o-btn o-btn--default runtime-acp-add">+ Connect agent</button>
`;

export function renderRuntimes(mount) {
  const body = detailShell(mount, 'Runtimes',
    'The agents sessions can run on. Sign each one in from here — the login runs on the daemon host, and the approval can happen on any device.');
  const unmountClaude = mountClaudeAuth(body);

  const panes = new Map();
  for (const { id, heading } of LOGIN_RUNTIMES) {
    const section = block(body, heading, '<div class="o-row-group"></div><div class="runtime-flow"></div>');
    panes.set(id, {
      accountEl: section.querySelector('.o-row-group'),
      flowEl: section.querySelector('.runtime-flow'),
    });
  }
  const agentsSection = block(body, 'Agents', '<div class="o-row-group runtimes-acp"></div>');
  const connectSection = block(body, 'Connect an agent', CONNECT_FORM);
  const acpEl = agentsSection.querySelector('.runtimes-acp');
  const errorEl = connectSection.querySelector('.runtime-acp-error');

  const state = {
    runtimes: null, error: null, copied: null,
    starting: new Set(), dismissed: new Set(),
  };
  let alive = true;
  let timer = null;

  function rawOf(id) {
    return state.runtimes?.find((r) => r.id === id) ?? null;
  }

  // A settled flow stays on the server until the next login starts; the user's Dismiss is
  // remembered here so a poll doesn't bring the card back.
  function runtimeOf(id) {
    const raw = rawOf(id);
    if (!raw) return null;
    const row = runtimeRow(raw);
    const dismissed = row.flow && row.flow.status !== 'awaiting' && state.dismissed.has(row.flow.id);
    return dismissed ? { ...row, flow: null } : row;
  }

  function paint() {
    for (const { id } of LOGIN_RUNTIMES) {
      const { accountEl, flowEl } = panes.get(id);
      const row = runtimeOf(id);
      if (!row) {
        setHtmlIfChanged(accountEl, placeholderHtml(state));
        setHtmlIfChanged(flowEl, '');
        continue;
      }
      setHtmlIfChanged(accountEl, accountHtml(row, state.starting.has(id)));
      setHtmlIfChanged(flowEl, flowHtml(row, state.copied));
    }
    if (!state.runtimes) {
      setHtmlIfChanged(acpEl, placeholderHtml(state));
      return;
    }
    const agents = state.runtimes.filter((r) => r.kind === 'acp').map(runtimeRow);
    setHtmlIfChanged(acpEl, agents.length
      ? agents.map(agentHtml).join('')
      : '<p class="settings-note">No agents connected yet.</p>');
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (!alive) return;
    if (!LOGIN_RUNTIMES.some(({ id }) => rawOf(id)?.flow?.status === 'awaiting')) return;
    timer = setTimeout(() => { void load(); }, POLL_MS);
  }

  async function load() {
    try {
      const data = await metaApi.runtimes();
      state.runtimes = data?.runtimes ?? [];
      state.error = null;
    } catch (e) {
      state.error = e.body || e.message;
    }
    if (!alive) return;
    paint();
    schedulePoll();
  }

  async function login(id) {
    state.starting.add(id);
    paint();
    try {
      await metaApi.runtimeAuthStart(id);
    } catch (e) {
      window.alert(e.body || e.message);
    }
    state.starting.delete(id);
    await load();
  }

  async function cancel(id) {
    await metaApi.runtimeAuthCancel(id).catch(() => {});
    await load();
  }

  async function remove(id) {
    const row = runtimeOf(id);
    if (!confirm(`Remove ${row?.label ?? id} from Outpost? Sessions already on it keep their history; the agent itself is untouched.`)) return;
    try {
      await metaApi.removeAcpRuntime(id.replace(/^acp:/, ''));
    } catch (e) {
      window.alert(e.body || e.message);
    }
    await load();
  }

  async function connect() {
    const val = (sel) => connectSection.querySelector(sel).value.trim();
    const [command, ...args] = val('#runtime-acp-command').split(/\s+/).filter(Boolean);
    const label = val('#runtime-acp-label');
    errorEl.innerHTML = '';
    try {
      await metaApi.addAcpRuntime({ id: val('#runtime-acp-id'), ...(label ? { label } : {}), command: command ?? '', args });
      for (const sel of ['#runtime-acp-id', '#runtime-acp-label', '#runtime-acp-command']) {
        connectSection.querySelector(sel).value = '';
      }
      await load();
    } catch (e) {
      errorEl.innerHTML = `<div class="permgroup-rule-error">${escapeHtml(e.body || e.message)}</div>`;
    }
  }

  body.addEventListener('click', (e) => {
    const t = e.target;
    const id = t.closest('[data-id]')?.dataset.id;
    if (t.closest('.runtime-login') && id) { void login(id); return; }
    if (t.closest('.runtime-cancel') && id) { void cancel(id); return; }
    if (t.closest('.runtime-remove') && id) { void remove(id); return; }
    if (t.closest('.runtime-dismiss') && id) {
      const flow = rawOf(id)?.flow;
      if (flow) state.dismissed.add(flow.id);
      paint();
      return;
    }
    const copy = t.closest('.runtime-copy');
    if (copy && id) {
      const flow = rawOf(id)?.flow;
      const text = copy.dataset.what === 'code' ? flow?.code : flow?.authUrl;
      void navigator.clipboard.writeText(text ?? '').then(() => {
        state.copied = `${id}:${copy.dataset.what}`;
        paint();
        setTimeout(() => { state.copied = null; if (alive) paint(); }, 1500);
      });
      return;
    }
    if (t.closest('.runtime-acp-add')) void connect();
  });

  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#runtime-acp-id, #runtime-acp-label, #runtime-acp-command')) {
      e.preventDefault();
      void connect();
    }
  });

  paint();
  void load();
  return () => {
    alive = false;
    clearTimeout(timer);
    unmountClaude();
  };
}
