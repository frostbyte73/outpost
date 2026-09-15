import { escapeHtml } from '../../util.js';
import { grantsStore } from '../../state/grants.js';
import { metaApi } from '../../net/meta.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { detailShell, block } from './detail-shell.js';
import { mcpServerRows, mcpConnectorRows, mcpConnectorsHidden } from '../../vm/settings.js';

// Settings > MCP connections. Two jobs: say which servers are healthy, and re-authorize the
// OAuth ones from whatever device you happen to be holding.
//
// The re-authorization is deliberately a three-step card rather than a single button, because
// step 2 looks like a failure and isn't: the consent screen redirects to a localhost callback
// that only the DAEMON's machine could serve, so a phone lands on "can't connect" with the
// authorization code sitting in its address bar. Telling the user that up front is the whole
// difference between this working and reading as broken.
//
// The card opens directly beneath the row it belongs to, in whichever of the two blocks that
// row lives. One shared slot below the server list meant a connector's tap rendered its
// buttons in the block above, off screen — a scroll away from the row that was tapped, with
// nothing to say which row it answered. So it is one persistent node that gets MOVED next to
// its row rather than re-rendered there: a row repaint must not tear down a half-typed paste,
// which is also why both row groups write through setHtmlIfChanged.

function serverRowHtml(row) {
  const iconTone = row.tone === 'danger' ? 'hot' : 'ok'; // o-row-icon's danger modifier is "hot"
  const sub = [row.transport, row.authNote].filter(Boolean).join(' · ');
  return `
    <div class="o-row mcp-row" data-server="${escapeHtml(row.name)}">
      <span class="o-row-icon ${iconTone}">◈</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.name)}</div>
        <div class="o-row-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="mcp-row-state">
        ${row.credentialLabel
          ? `<span class="o-pill ${escapeHtml(row.credentialTone)}">${escapeHtml(row.credentialLabel)}</span>`
          : ''}
        <span class="o-pill ${escapeHtml(row.tone)}">${escapeHtml(row.statusLabel)}</span>
        ${row.canReauth
          ? `<button type="button" class="o-btn o-btn--default sm mcp-reauth-btn">${row.needsAttention ? 'Authorize…' : 'Re-authorize…'}</button>`
          : ''}
      </div>
    </div>
  `;
}

// Anchored under its row, the row directly above already names the server; the heading only
// earns its line in the fallback placement, where the card has no row to sit under.
function titleHtml(flow, anchored) {
  return anchored ? '' : `<h4 class="o-microhead">Authorize ${escapeHtml(flow.server)}</h4>`;
}

// A claude.ai connector authorizes on claude.ai itself and the CLI exits immediately — there is
// no code to bring back, so this variant is a link and a caveat, not a three-step errand. The
// caveat is load-bearing: the grant lands on the account but Claude Code only picks it up on
// its next start, so nothing appears to change here until sessions restart.
function handoffCardHtml(flow, anchored) {
  return `
    <div class="mcp-auth-card" data-flow="${escapeHtml(flow.id)}">
      ${titleHtml(flow, anchored)}
      <p class="mcp-auth-lede">This is a claude.ai connector, so it authorizes on claude.ai —
      nothing to paste back. Open the link on any device and approve it.</p>
      <div class="mcp-auth-actions">
        <a class="o-btn o-btn--primary sm mcp-auth-open" href="${escapeHtml(flow.authUrl)}"
           target="_blank" rel="noopener noreferrer">Authorize on claude.ai ↗</a>
        <button type="button" class="o-btn o-btn--default sm mcp-auth-copy">Copy link</button>
        <button type="button" class="o-btn o-btn--ghost sm mcp-auth-handoff-done">Done</button>
      </div>
      <p class="settings-note">A session picks the connector up when it starts, so tapping Done
      reloads the running ones onto it.</p>
    </div>
  `;
}

function flowCardHtml(state) {
  const { flow, busy, error, copied, pasted, anchored } = state;
  if (busy === 'starting') {
    return `<div class="settings-loading">Starting the login for ${escapeHtml(state.startingServer)}…</div>`;
  }
  if (error && !flow) return `<div class="permgroup-rule-error">${escapeHtml(error)}</div>`;
  if (!flow) return '';
  if (flow.status === 'done') {
    return `<div class="mcp-auth-card ok">
      <p class="mcp-auth-done">✓ ${escapeHtml(flow.server)} is authorized.</p>
      <button type="button" class="o-btn o-btn--ghost sm mcp-auth-dismiss">Dismiss</button>
    </div>`;
  }
  if (flow.kind === 'handoff') return handoffCardHtml(flow, anchored);
  return `
    <div class="mcp-auth-card" data-flow="${escapeHtml(flow.id)}">
      ${titleHtml(flow, anchored)}
      <ol class="mcp-auth-steps">
        <li>
          <span>Open the consent screen and approve it — on this device or any other.</span>
          <div class="mcp-auth-actions">
            <a class="o-btn o-btn--primary sm mcp-auth-open" href="${escapeHtml(flow.authUrl)}"
               target="_blank" rel="noopener noreferrer">Open authorization page ↗</a>
            <button type="button" class="o-btn o-btn--default sm mcp-auth-copy">${copied ? 'Copied' : 'Copy link'}</button>
          </div>
        </li>
        <li>
          <span>You'll land on a page that <strong>can't load</strong> — that's expected, it points
          at this Mac's localhost. Copy its whole address from the address bar.</span>
        </li>
        <li>
          <span>Paste it here.</span>
          <div class="mcp-auth-actions">
            <input type="text" class="mcp-auth-input" inputmode="url" autocapitalize="off"
              autocorrect="off" spellcheck="false" placeholder="http://localhost:…/callback?code=…"
              value="${escapeHtml(pasted ?? '')}"${busy ? ' disabled' : ''}>
            <button type="button" class="o-btn o-btn--primary sm mcp-auth-finish"${busy ? ' disabled' : ''}>${busy === 'submitting' ? 'Finishing…' : 'Finish'}</button>
            <button type="button" class="o-btn o-btn--ghost sm mcp-auth-cancel"${busy ? ' disabled' : ''}>Cancel</button>
          </div>
        </li>
      </ol>
      ${error ? `<div class="permgroup-rule-error">${escapeHtml(error)}</div>` : ''}
    </div>
  `;
}

function connectorRowHtml(row) {
  return `
    <div class="o-row mcp-row" data-server="${escapeHtml(row.name)}">
      <span class="o-row-icon ${row.tone === 'danger' ? 'hot' : 'ok'}">◈</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.label)}</div>
        <div class="o-row-sub">claude.ai connector</div>
      </div>
      <div class="mcp-row-state">
        <span class="o-pill ${escapeHtml(row.tone)}">${escapeHtml(row.statusLabel)}</span>
        <button type="button" class="o-btn o-btn--default sm mcp-reauth-btn">${row.status === 'connected' ? 'Re-authorize…' : 'Authorize…'}</button>
      </div>
    </div>
  `;
}

export function renderMcp(mount) {
  const body = detailShell(mount, 'MCP connections',
    'Servers configured for spawned sessions (daemon-level MCP config plus your ~/.claude.json), and the claude.ai connectors on your account.');
  const section = block(body, 'Servers', `
    <button type="button" class="o-btn o-btn--default settings-refresh-btn">Refresh</button>
    <div class="o-row-group mcp-rows"></div>
    <div class="mcp-auth-slot"></div>
  `);
  // Its own block: this list is fetched on a slower schedule, so it must be able to say
  // "loading" without the configured servers above it waiting on the same fetch.
  const connectorSection = block(body, 'claude.ai connectors', `
    <p class="settings-note">Authorized on your claude.ai account, not here — several permission
    groups grant against these, so a lapsed one breaks actions the same way a local server does.</p>
    <div class="o-row-group mcp-connector-rows"></div>
  `);
  const rowsEl = section.querySelector('.mcp-rows');
  const slotEl = section.querySelector('.mcp-auth-slot');
  const refreshBtn = section.querySelector('.settings-refresh-btn');
  const connectorRowsEl = connectorSection.querySelector('.mcp-connector-rows');

  const flowEl = document.createElement('div');
  flowEl.className = 'mcp-auth-flow';
  slotEl.appendChild(flowEl);

  const state = {
    flow: null, startingServer: null, busy: null, error: null, copied: false, pasted: '',
    anchored: false,
    connectors: [], connectorsLoaded: false, connectorError: null, showAllConnectors: false,
  };

  function paintRows() {
    const snap = grantsStore.get();
    refreshBtn.disabled = snap.mcpLoading;
    refreshBtn.textContent = snap.mcpLoading ? 'Refreshing…' : 'Refresh';
    if (!snap.mcpLoaded) {
      setHtmlIfChanged(rowsEl, '<div class="settings-loading">Loading…</div>');
      placeFlow();
      return;
    }
    const rows = mcpServerRows(snap.mcpServers);
    setHtmlIfChanged(rowsEl, rows.length
      ? rows.map(serverRowHtml).join('')
      : '<p class="settings-note">No MCP servers configured.</p>');
    placeFlow();
  }

  // Both blocks are searched: a flow belongs to whichever row started it, and a connector's
  // row sits in the second one.
  function rowFor(server) {
    if (!server) return null;
    return [...body.querySelectorAll('.mcp-row')].find((r) => r.dataset.server === server) ?? null;
  }

  function paintFlow() {
    const row = rowFor(state.flow?.server ?? state.startingServer);
    state.anchored = !!row;
    flowEl.innerHTML = flowCardHtml(state);
    place(row);
  }

  // Re-seats the card after a row repaint. Repainting it too would cost a half-typed paste its
  // caret, so that happens only when the row's arrival or departure changed the heading.
  function placeFlow() {
    const row = rowFor(state.flow?.server ?? state.startingServer);
    if (!!row !== state.anchored) return paintFlow();
    place(row);
  }

  function place(row) {
    // An empty card inline would break the group's collapsed hairline (its last row stops
    // being :last-child), so it waits in the slot until it has something to say.
    if (!row || !flowEl.firstElementChild) {
      if (flowEl.parentElement !== slotEl) slotEl.appendChild(flowEl);
      return;
    }
    if (row.nextElementSibling !== flowEl) row.after(flowEl);
  }

  function paintConnectors() {
    if (state.connectorError) {
      setHtmlIfChanged(connectorRowsEl, `<p class="settings-note">Could not list connectors: ${escapeHtml(state.connectorError)}</p>`);
    } else if (!state.connectorsLoaded) {
      setHtmlIfChanged(connectorRowsEl, '<div class="settings-loading">Checking connectors…</div>');
    } else {
      const rows = mcpConnectorRows(state.connectors, { showAll: state.showAllConnectors });
      const hidden = mcpConnectorsHidden(state.connectors);
      setHtmlIfChanged(connectorRowsEl, `
        ${rows.length ? rows.map(connectorRowHtml).join('') : '<p class="settings-note">No claude.ai connectors.</p>'}
        ${hidden && !state.showAllConnectors
          ? `<button type="button" class="o-btn o-btn--ghost sm mcp-connectors-showall">Show ${hidden} never-connected connector${hidden === 1 ? '' : 's'}</button>`
          : ''}
      `);
    }
    placeFlow();
  }

  async function loadConnectors(refresh = false) {
    if (refresh) {
      state.connectorsLoaded = false;
      paintConnectors();
    }
    try {
      const data = await metaApi.mcpConnectors(refresh);
      state.connectors = Array.isArray(data?.connectors) ? data.connectors : [];
      state.connectorsLoaded = true;
      state.connectorError = null;
    } catch (e) {
      state.connectorError = e.body || e.message;
    } finally {
      paintConnectors();
    }
  }

  async function startFlow(server) {
    state.busy = 'starting';
    state.startingServer = server;
    state.flow = null;
    state.error = null;
    state.pasted = '';
    paintFlow();
    try {
      const data = await metaApi.mcpAuthStart(server);
      state.flow = data?.flow ?? null;
    } catch (e) {
      state.error = e.body || e.message;
    } finally {
      state.busy = null;
      paintFlow();
      // The card is already at the tapped row, so this only closes the gap when it opens taller
      // than the room below it — `nearest` scrolls the minimum, or not at all.
      flowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function finishFlow() {
    if (!state.flow || !state.pasted.trim()) return;
    state.busy = 'submitting';
    state.error = null;
    paintFlow();
    try {
      const data = await metaApi.mcpAuthSubmit(state.flow.id, state.pasted.trim());
      const flow = data?.flow ?? null;
      if (flow?.status === 'done') {
        state.flow = flow;
        state.pasted = '';
        // The row's pills come from /api/mcp/status, so the new credential only shows up
        // once that's re-read — the reason to succeed loudly here rather than silently.
        void grantsStore.loadMcp();
      } else {
        // A failed exchange keeps the card open with the CLI's own reason: the usual cause is
        // a stale code, and the fix is to run the link again, not to re-paste.
        state.error = flow?.error || 'the authorization could not be completed';
        state.flow = null;
      }
    } catch (e) {
      state.error = e.body || e.message;
    } finally {
      state.busy = null;
      paintFlow();
    }
  }

  // Dismisses a connector's card AND tells the daemon the grant landed, so live sessions get
  // reloaded onto it. Its failure is deliberately silent: the card is going away either way,
  // and a reload that didn't happen costs a session restart, not correctness.
  async function finishHandoff() {
    const id = state.flow?.id;
    state.flow = null;
    state.error = null;
    paintFlow();
    if (id) await metaApi.mcpAuthDone(id).catch(() => {});
    void loadConnectors(true);
  }

  async function cancelFlow() {
    const id = state.flow?.id;
    state.flow = null;
    state.error = null;
    state.pasted = '';
    paintFlow();
    if (id) await metaApi.mcpAuthCancel(id).catch(() => {});
  }

  // Bound on `body`, the shared parent: connector rows sit in their own block, so a listener on
  // the servers block alone would leave every connector's button dead.
  body.addEventListener('click', (e) => {
    if (e.target.closest('.mcp-reauth-btn')) {
      void startFlow(e.target.closest('.mcp-row').dataset.server);
      return;
    }
    if (e.target.closest('.mcp-connectors-showall')) {
      state.showAllConnectors = true;
      paintConnectors();
      return;
    }
    if (e.target.closest('.mcp-auth-copy')) {
      void navigator.clipboard.writeText(state.flow?.authUrl ?? '').then(() => {
        state.copied = true;
        paintFlow();
      });
      return;
    }
    if (e.target.closest('.mcp-auth-finish')) { void finishFlow(); return; }
    if (e.target.closest('.mcp-auth-cancel')) { void cancelFlow(); return; }
    if (e.target.closest('.mcp-auth-handoff-done')) { void finishHandoff(); return; }
    if (e.target.closest('.mcp-auth-dismiss')) {
      state.flow = null;
      state.error = null;
      paintFlow();
    }
  });

  body.addEventListener('input', (e) => {
    if (e.target.classList.contains('mcp-auth-input')) state.pasted = e.target.value;
  });

  // Enter is what a phone keyboard offers after a paste.
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('mcp-auth-input')) {
      e.preventDefault();
      void finishFlow();
    }
  });

  refreshBtn.addEventListener('click', () => {
    void grantsStore.loadMcp();
    void loadConnectors(true);
  });
  paintRows();
  paintFlow();
  paintConnectors();
  const unsub = grantsStore.subscribe(paintRows);
  void grantsStore.ensureMcpLoaded();
  void loadConnectors();
  // Picks up a login started on another device — the case this whole flow exists for.
  void metaApi.mcpAuthFlows().then((data) => {
    const live = (data?.flows ?? []).find((f) => f.status === 'awaiting' || f.status === 'handoff');
    if (live && !state.flow && !state.busy) {
      state.flow = live;
      paintFlow();
    }
  }).catch(() => {});
  return unsub;
}
