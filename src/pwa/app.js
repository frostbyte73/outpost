if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw register failed', e));
}

const root = document.getElementById('root');
const header = document.getElementById('header');

const state = {
  view: 'list', // 'list' | 'session'
  sessions: [],
  currentSessionId: null,
  ws: null,
  // Long-lived WS to /ws/notifications, open for the entire app lifetime. Delivers every
  // approval event regardless of which view is active, so the list updates live and toasts
  // fire even before the user has clicked into a session.
  notifyWs: null,
  transcript: [],
  // Always the FULL cross-session list of pending approvals. Rendering filters by
  // sessionId for the in-session card view and groups by sessionId for the list view.
  pendingApprovals: [],
  // True between sending a user message and receiving the assistant response.
  // Drives the thinking-caret pseudo-tile at the end of the transcript.
  thinking: false,
  // Assistant message ids (`msg_*`) we've already rendered. Used to dedupe when the WS
  // replay buffer redelivers a message we already loaded from disk or saw on a previous
  // connection — happens reliably when iOS foregrounds the PWA and the WS reconnects.
  seenMsgIds: new Set(),
};

// Wire the HTML-rendered initial shell so the "+ New session" button works from the very
// first paint, before /api/sessions resolves. The full list renders in once loadSessions does.
const initialButton = document.getElementById('new-session-initial');
if (initialButton) initialButton.onclick = () => openSession(null);

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.sessions = data.sessions;
    state.pendingApprovals = data.pending ?? [];
    render();
  } catch (e) {
    root.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(String(e.message))}</div>`;
  }
}

function render() {
  setHeader(state.view === 'list' ? 'list' : 'session');
  if (state.view === 'list') renderList();
  else renderSession();
}

function setHeader(mode) {
  const meta = document.getElementById('header-meta');
  header.innerHTML = '';
  if (mode === 'list') {
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = 'Claude Relay';
    // Gear settings button, far right. The date/time meta was redundant on a phone
    // (the OS shows it in the status bar) so it's been removed; the gear takes its slot.
    const gear = document.createElement('button');
    gear.className = 'settings-btn';
    gear.setAttribute('aria-label', 'Settings');
    gear.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    gear.onclick = openSettings;
    header.appendChild(brand);
    header.appendChild(gear);
  } else {
    const back = document.createElement('a');
    back.href = '#';
    back.className = 'back';
    back.textContent = '← Sessions';
    back.onclick = (e) => {
      e.preventDefault();
      leaveSession();
    };
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = state.currentSessionId ? state.currentSessionId.slice(0, 8) : '';
    header.appendChild(back);
    header.appendChild(m);
  }
}

function renderList() {
  const sessions = state.sessions;
  // Count pending approvals per session so each row can flag whether it needs attention.
  const pendingBySession = state.pendingApprovals.reduce((acc, a) => {
    acc[a.sessionId] = (acc[a.sessionId] || 0) + 1;
    return acc;
  }, {});
  root.innerHTML = `
    <div class="session-list">
      <button class="new-session" id="new-session">
        <span>New session</span>
        <span class="plus">+</span>
      </button>
      <div class="list-label">Recent</div>
      ${sessions.length === 0
        ? `<div class="empty-state">No sessions yet. Open a new one.</div>`
        : sessions.map((s, i) => sessionRowHtml(s, i, pendingBySession[s.id] ?? 0)).join('')}
    </div>
  `;
  document.getElementById('new-session').onclick = () => openSession(null);
  for (const row of document.querySelectorAll('.session-row')) {
    wireSwipeToDelete(row);
  }
  for (const btn of document.querySelectorAll('.delete-action')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      const wrap = btn.closest('.session-row-wrap');
      const row = wrap?.querySelector('.session-row');
      const title = row?.querySelector('.title')?.textContent ?? id;
      if (!confirm(`Delete "${title}"?\n\nThis removes the session file permanently and cannot be undone.`)) {
        if (row) snapRowClosed(row);
        return;
      }
      deleteSession(id);
    };
  }
}

function sessionRowHtml(s, i, pendingCount) {
  const marker = String(i + 1).padStart(2, '0');
  const hasPending = pendingCount > 0;
  // pendingCount is a numeric integer derived from state, not interpolated user input.
  // All string fields (id, title, timeAgo output) are routed through escapeHtml.
  const badge = hasPending
    ? `<span class="sep">·</span><span class="pending-badge"><span class="dot"></span><span>${pendingCount} pending</span></span>`
    : '';
  return `
    <div class="session-row-wrap">
      <button class="delete-action" data-delete="${escapeHtml(s.id)}" aria-label="Delete session">Delete</button>
      <div class="session-row" data-id="${escapeHtml(s.id)}">
        <span class="marker${hasPending ? ' pending' : ''}">${marker}</span>
        <div class="body">
          <div class="title">${escapeHtml(s.title)}</div>
          <div class="meta">
            <span>${escapeHtml(timeAgo(s.lastModified))}</span>
            <span class="sep">·</span>
            <span>${escapeHtml(s.id.slice(0, 8))}</span>
            ${badge}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function openSession(id) {
  const isNew = id === null;
  if (isNew) id = crypto.randomUUID();
  state.currentSessionId = id;
  state.view = 'session';
  state.transcript = [];
  state.seenMsgIds = new Set();
  state.thinking = false;
  state.transcriptLoading = !isNew;
  // Dismiss any cross-session toast — it's either about this session (we're already
  // here) or about a different one the user is choosing not to follow right now.
  document.getElementById('toast')?.remove();
  render();
  if (!isNew) {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
      if (r.ok) {
        const { messages } = await r.json();
        // The user might have already started typing while we were fetching; only
        // replace the transcript if we haven't moved on to another session.
        if (state.currentSessionId === id) {
          state.transcript = messages;
          for (const m of messages) if (m.msgId) state.seenMsgIds.add(m.msgId);
        }
      }
    } catch (e) {
      console.warn('failed to load session transcript:', e);
    } finally {
      state.transcriptLoading = false;
      if (state.currentSessionId === id) renderSession();
    }
  }
  connectWs(id);
}

function leaveSession() {
  state.view = 'list';
  state.ws?.close();
  state.ws = null;
  state.currentSessionId = null;
  state.thinking = false;
  document.getElementById('toast')?.remove();
  loadSessions();
}

function connectWs(id) {
  if (state.ws) state.ws.close();
  const ws = new WebSocket(`wss://${location.host}/ws/sessions/${id}`);
  state.ws = ws;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleWsMessage(msg);
  };
  ws.onclose = () => {
    if (state.currentSessionId === id) setTimeout(() => connectWs(id), 1500);
  };
  ws.onerror = () => { /* close handler retries */ };
}

// Notification WS: stays open for the app's whole lifetime. Reconnects on close so
// iOS backgrounding doesn't permanently sever it. Delivers a one-time snapshot of
// already-pending approvals on attach, then live approval_pending events as they fire.
function connectNotificationWs() {
  if (state.notifyWs && state.notifyWs.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket(`wss://${location.host}/ws/notifications`);
  state.notifyWs = ws;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleNotificationMessage(msg);
  };
  ws.onclose = () => {
    state.notifyWs = null;
    setTimeout(connectNotificationWs, 1500);
  };
  ws.onerror = () => { /* close handler retries */ };
}

function handleWsMessage(msg) {
  // Session WS only carries session-scoped events. Approvals flow through the notification
  // WS so they reach every view (list, current session, other session).
  if (msg.type === 'assistant') {
    const msgId = msg.message?.id;
    // Skip the whole envelope if we've already rendered it — happens when the WS replay
    // buffer redelivers a message that's already on disk or was pushed before a reconnect.
    if (msgId && state.seenMsgIds.has(msgId)) return;
    if (msgId) state.seenMsgIds.add(msgId);
    const blocks = msg.message?.content ?? [];
    for (const b of blocks) {
      if (b.type === 'text') {
        state.transcript.push({ role: 'assistant', text: b.text, msgId });
      } else if (b.type === 'tool_use') {
        state.transcript.push({ role: 'tool_use', text: `${b.name}(${JSON.stringify(b.input).slice(0, 200)})`, msgId });
      }
    }
    state.thinking = false;
    renderSession();
  } else if (msg.type === 'daemon_error') {
    state.transcript.push({ role: 'error', text: msg.message });
    state.thinking = false;
    renderSession();
  } else if (msg.type === 'daemon_proc_exit') {
    state.transcript.push({ role: 'error', text: `Session subprocess exited (code ${msg.code}). Reopen to resume.` });
    state.thinking = false;
    renderSession();
  }
}

function handleNotificationMessage(msg) {
  if (msg.type === 'notifications_snapshot') {
    // Replace the entire local pending list with the server's authoritative snapshot.
    // Sent on attach (cold start AND reconnect-after-background), so it doubles as a
    // recovery mechanism for any approvals the client missed while disconnected.
    state.pendingApprovals = Array.isArray(msg.approvals) ? msg.approvals : [];
    // Re-render whatever's currently in view so badges / cards reflect the new state.
    if (state.view === 'list') renderList();
    else if (state.view === 'session') renderSession();
    return;
  }
  if (msg.type === 'approval_pending') {
    // Live new arrival. Dedupe (a reconnect could race against the snapshot) and route
    // either to an inline card (if its session is in view) or a toast (if not).
    if (state.pendingApprovals.some((a) => a.approvalId === msg.approvalId)) return;
    state.pendingApprovals.push(msg);
    if (state.view === 'session' && msg.sessionId === state.currentSessionId) {
      renderSession();
    } else {
      if (state.view === 'list') renderList();
      showApprovalToast(msg);
    }
  }
}

function renderSession() {
  const loading = state.transcriptLoading
    ? `<div class="empty-state">Loading history…</div>`
    : '';
  const empty = !state.transcriptLoading && state.transcript.length === 0 && !state.thinking
    ? `<div class="empty-state">No messages yet — say something.</div>`
    : '';
  // Approval cards are scoped to the current session only; cross-session approvals live
  // in state.pendingApprovals too but surface as toasts, not inline cards.
  const cards = state.pendingApprovals.filter((a) => a.sessionId === state.currentSessionId);
  const thinkingTile = state.thinking ? thinkingTileHtml() : '';
  root.innerHTML = `
    <div class="transcript" id="transcript">
      ${loading}
      ${empty}
      ${state.transcript.map((m) => msgHtml(m)).join('')}
      ${thinkingTile}
      ${cards.map((a) => approvalCardHtml(a)).join('')}
    </div>
    <div class="composer">
      <div class="field" id="composer" contenteditable="true"
           role="textbox" aria-multiline="true"
           autocapitalize="sentences"
           data-placeholder="Type a message…"></div>
      <button class="send" id="send" aria-label="Send">↵</button>
    </div>
  `;
  const composer = document.getElementById('composer');
  const send = document.getElementById('send');

  const armSend = () => {
    const text = composer.textContent.trim();
    send.classList.toggle('armed', text.length > 0);
  };
  composer.addEventListener('input', armSend);
  composer.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts a newline. Mobile users can paste in newlines if needed.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  send.onclick = sendMessage;

  for (const btn of document.querySelectorAll('.approval-card .approve')) {
    btn.onclick = () => decideApproval(btn.dataset.id, 'allow');
  }
  for (const btn of document.querySelectorAll('.approval-card .reject')) {
    btn.onclick = () => decideApproval(btn.dataset.id, 'deny');
  }

  scrollTranscriptBottom();
}

function msgHtml(m) {
  const labels = { user: 'You', assistant: 'Assistant', tool_use: 'Tool', error: 'Error' };
  // Assistant messages get full markdown rendering. Everything else is plain text — user
  // messages shouldn't be parsed (they're as the user typed them), tool_use shows the raw
  // call signature in a fixed format, and error messages are unstructured logs.
  const body = m.role === 'assistant' ? renderMarkdown(m.text) : escapeHtml(m.text);
  return `<div class="msg ${escapeHtml(m.role)}"><span class="role">${escapeHtml(labels[m.role] ?? m.role)}</span><span class="body-text">${body}</span></div>`;
}

function approvalCardHtml(a) {
  return `
    <div class="approval-card" data-id="${escapeHtml(a.approvalId)}">
      <div class="label">Approval needed</div>
      <div class="tool">${escapeHtml(a.toolName)}</div>
      <div class="summary">${escapeHtml(a.summary ?? '')}</div>
      <div class="actions">
        <button class="approve" data-id="${escapeHtml(a.approvalId)}">Approve</button>
        <button class="reject" data-id="${escapeHtml(a.approvalId)}">Reject</button>
      </div>
    </div>
  `;
}

// The "Claude is working on it" tile — italic-serif body + amber blinking underscore
// caret. Sits at the bottom of the transcript between send-time and assistant arrival.
// Static markup, no interpolation, so no escaping is needed.
function thinkingTileHtml() {
  return `<div class="msg thinking"><span class="role">Assistant</span><span class="body-text">thinking<span class="caret">_</span></span></div>`;
}

// Cross-session toast: shown when an approval arrives on a session that isn't the
// one currently in view. Slides in from above the header for ~7s. Tap to switch.
function showApprovalToast(a) {
  // Replace any toast already on screen so we never stack — newest wins.
  document.getElementById('toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = 'toast';
  toast.setAttribute('role', 'alert');
  // a.sessionTitle / a.toolName / a.sessionId are server-provided strings; route through
  // escapeHtml. The arrow glyph and labels are static markup.
  const sessionLabel = a.sessionTitle
    ? escapeHtml(a.sessionTitle)
    : escapeHtml('Session ' + String(a.sessionId).slice(0, 8));
  toast.innerHTML = `
    <div class="top-line">
      <span class="label">Approval needed</span>
      <span class="arrow">↗</span>
    </div>
    <div class="tool">${escapeHtml(a.toolName)}</div>
    <div class="session-ref">${sessionLabel}</div>
  `;
  toast.onclick = () => {
    toast.remove();
    openSession(a.sessionId);
  };
  document.body.appendChild(toast);
  // Match the CSS animation timeline: 0.34s in, 6.6s wait, 0.34s out → ~7.3s total.
  setTimeout(() => toast.remove(), 7400);
}

function sendMessage() {
  const composer = document.getElementById('composer');
  const text = composer.textContent.trim();
  if (!text) return;
  state.transcript.push({ role: 'user', text });
  state.thinking = true;
  state.ws?.send(JSON.stringify({ type: 'user_message', content: text }));
  composer.textContent = '';
  document.getElementById('send')?.classList.remove('armed');
  renderSession();
}

function decideApproval(id, decision) {
  state.ws?.send(JSON.stringify({ type: 'approval_decide', approvalId: id, decision }));
  state.pendingApprovals = state.pendingApprovals.filter((a) => a.approvalId !== id);
  renderSession();
}

function scrollTranscriptBottom() {
  requestAnimationFrame(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTop = t.scrollHeight;
  });
}

async function deleteSession(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
    state.sessions = state.sessions.filter((s) => s.id !== id);
    render();
  } catch (e) {
    alert(`Failed to delete: ${e.message}`);
  }
}

/* ───── Swipe-to-delete ─────────────────────────────────────────── */

const SWIPE_OPEN_THRESHOLD = 24;
const SWIPE_OPEN_DISTANCE = 92;
let openRow = null;

function wireSwipeToDelete(row) {
  let startX = 0, startY = 0, currentX = 0, isSwiping = false, swipeStarted = false, gestureCancelled = false;
  // The delete button is a sibling of the row inside the same .session-row-wrap.
  // Driving its transform in lockstep with the row keeps it off-screen at rest
  // (no flicker during scroll) and lets it slide in cleanly during a swipe.
  const deleteAction = row.parentElement?.querySelector('.delete-action');

  row.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    currentX = 0; isSwiping = false; swipeStarted = false; gestureCancelled = false;
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    if (gestureCancelled) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (!swipeStarted) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy)) { gestureCancelled = true; return; }
      swipeStarted = true;
      row.classList.add('swiping');
      deleteAction?.classList.add('swiping');
      if (openRow && openRow !== row) snapRowClosed(openRow);
    }
    isSwiping = true;
    const base = row.dataset.openOffset ? -SWIPE_OPEN_DISTANCE : 0;
    currentX = Math.min(0, base + dx);
    if (currentX < -SWIPE_OPEN_DISTANCE) {
      const overshoot = -currentX - SWIPE_OPEN_DISTANCE;
      currentX = -SWIPE_OPEN_DISTANCE - overshoot * 0.3;
    }
    row.style.transform = `translateX(${currentX}px)`;
    if (deleteAction) {
      // Delete starts off-screen at translateX(SWIPE_OPEN_DISTANCE) and slides leftward
      // with the row; clamp at 0 so its overshoot doesn't disappear behind a side edge.
      const deleteX = Math.max(0, SWIPE_OPEN_DISTANCE + currentX);
      deleteAction.style.transform = `translateX(${deleteX}px)`;
    }
  }, { passive: true });

  row.addEventListener('touchend', () => {
    row.classList.remove('swiping');
    deleteAction?.classList.remove('swiping');
    if (!isSwiping) return;
    if (currentX < -SWIPE_OPEN_THRESHOLD) snapRowOpen(row);
    else snapRowClosed(row);
  });

  row.addEventListener('click', (e) => {
    if (row.dataset.openOffset) {
      e.preventDefault();
      e.stopPropagation();
      snapRowClosed(row);
      return;
    }
    openSession(row.dataset.id);
  });
}

function snapRowOpen(row) {
  row.style.transform = `translateX(-${SWIPE_OPEN_DISTANCE}px)`;
  row.dataset.openOffset = '1';
  const deleteAction = row.parentElement?.querySelector('.delete-action');
  if (deleteAction) deleteAction.style.transform = 'translateX(0)';
  openRow = row;
}

function snapRowClosed(row) {
  row.style.transform = 'translateX(0)';
  delete row.dataset.openOffset;
  const deleteAction = row.parentElement?.querySelector('.delete-action');
  if (deleteAction) deleteAction.style.transform = `translateX(${SWIPE_OPEN_DISTANCE}px)`;
  if (openRow === row) openRow = null;
}

/* ───── Markdown rendering ──────────────────────────────────────── */
/* Focused markdown subset that matches what `claude` actually emits via stream-json:
   fenced code, inline code, bold, italic, strikethrough, headings, ordered/unordered
   lists, links, tables, blockquotes, horizontal rules. Raw HTML is always escaped first
   so the output is XSS-safe regardless of what the model writes. */

function renderMarkdown(src) {
  // Strip ANSI escape sequences that bleed through from tool stdout (claude includes them
  // verbatim when a shell command produced colored output). They render as garbage in HTML.
  const stripped = String(src).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Phase 1: extract fenced code blocks first so their content is never touched by inline
  // markdown rules. Replace them with a placeholder we'll swap back in at the end.
  const codeBlocks = [];
  const withFences = stripped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: String(lang || ''), code: String(code) });
    return `\x00FENCE${codeBlocks.length - 1}\x00`;
  });

  // Phase 2: chunk into blocks separated by blank lines. Each chunk renders independently.
  const blocks = withFences.split(/\n{2,}/);
  let html = blocks.map(renderBlock).join('\n');

  // Phase 3: swap fence placeholders back in as styled <pre><code> elements.
  html = html.replace(/\x00FENCE(\d+)\x00/g, (_, i) => {
    const cb = codeBlocks[Number(i)];
    if (!cb) return '';
    const langClass = cb.lang ? ` class="lang-${escapeHtml(cb.lang)}"` : '';
    return `<pre class="md-pre"><code${langClass}>${escapeHtml(cb.code.replace(/\n$/, ''))}</code></pre>`;
  });

  return html;
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return '';

  // Headings: # through ######
  const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (h) {
    const level = h[1].length;
    return `<h${level} class="md-h md-h${level}">${renderInline(h[2])}</h${level}>`;
  }

  // Horizontal rule
  if (/^(?:-\s*){3,}$|^(?:_\s*){3,}$|^(?:\*\s*){3,}$/.test(trimmed)) {
    return `<hr class="md-hr">`;
  }

  // Table: at least two lines, second is the divider |---|---|
  const lines = trimmed.split('\n');
  if (lines.length >= 2 && /^\s*\|.*\|\s*$/.test(lines[0]) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1])) {
    return renderTable(lines);
  }

  // Blockquote (one or more lines starting with > )
  if (lines.every((l) => /^\s*>\s?/.test(l))) {
    const inner = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n');
    return `<blockquote class="md-quote">${renderInline(inner)}</blockquote>`;
  }

  // Unordered or ordered list
  if (lines.every((l) => /^\s*[-*+]\s+/.test(l)) || lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
    const ordered = /^\s*\d+\.\s+/.test(lines[0]);
    const items = lines.map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag} class="md-list">${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</${tag}>`;
  }

  // Default: paragraph. Single newlines within become <br> for soft line breaks.
  return `<p class="md-p">${renderInline(trimmed).replace(/\n/g, '<br>')}</p>`;
}

function renderTable(lines) {
  const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  const thead = `<thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
}

function renderInline(text) {
  // Escape HTML first; every transform below produces tags only from controlled patterns,
  // so user content can't ever inject markup. Order matters: inline code is extracted
  // before other transforms so backticks don't get touched by bold/italic regexes.
  const inlineCodes = [];
  let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00CODE${inlineCodes.length - 1}\x00`;
  });

  // Links: [text](href). Only allow http(s):// and mailto: hrefs for safety; everything else
  // renders as the raw text so a malformed href can't smuggle in a javascript: URL.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (full, label, href) => {
    if (!/^(?:https?:\/\/|mailto:|tel:|\/)/.test(href)) return full;
    return `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bold-italic ***x***
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold **x__ or __x__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // Italic *x* or _x_
  s = s.replace(/(^|[\s({\[>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s({\[>])_([^_\n]+)_/g, '$1<em>$2</em>');
  // Strikethrough ~~x~~
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Restore inline code
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
    const code = inlineCodes[Number(i)];
    return `<code class="md-code">${escapeHtml(code)}</code>`;
  });

  return s;
}

/* ───── Utils ───────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

/* ───── Settings sheet ──────────────────────────────────────────
   Theme + mode picker. The pre-render script in <head> already applied the
   saved values to <html data-theme data-mode>; this code just keeps the sheet
   UI in sync and writes back to localStorage on selection. */

const VALID_THEMES = ['livekit', 'almanac', 'terminal'];
const VALID_MODES = ['light', 'dark'];

function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return VALID_THEMES.includes(t) ? t : 'livekit';
}
function currentMode() {
  const m = document.documentElement.getAttribute('data-mode');
  return VALID_MODES.includes(m) ? m : 'dark';
}

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('cr:theme', theme);
  refreshSheetSelection();
  syncThemeColorMeta();
}
function applyMode(mode) {
  if (!VALID_MODES.includes(mode)) return;
  document.documentElement.setAttribute('data-mode', mode);
  localStorage.setItem('cr:mode', mode);
  refreshSheetSelection();
  syncThemeColorMeta();
}

// Keep <meta name="theme-color"> in sync with the active theme's --bg so the iOS
// Safari address bar / PWA status bar tint matches when the user switches palette.
function syncThemeColorMeta() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

function refreshSheetSelection() {
  const theme = currentTheme();
  const mode = currentMode();
  for (const card of document.querySelectorAll('.theme-card')) {
    card.classList.toggle('selected', card.dataset.themeKey === theme);
  }
  for (const btn of document.querySelectorAll('.mode-toggle button')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

function openSettings() {
  refreshSheetSelection();
  document.getElementById('sheet-backdrop').classList.add('open');
  document.getElementById('sheet').classList.add('open');
}
function closeSettings() {
  document.getElementById('sheet-backdrop').classList.remove('open');
  document.getElementById('sheet').classList.remove('open');
}

// Sheet UI wiring. Event delegation on the picker containers so the handlers stay
// stable even if the sheet's markup gets re-rendered.
document.getElementById('sheet-close').onclick = closeSettings;
document.getElementById('sheet-backdrop').onclick = closeSettings;
document.getElementById('theme-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.theme-card');
  if (card?.dataset.themeKey) applyTheme(card.dataset.themeKey);
});
document.getElementById('mode-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn?.dataset.mode) applyMode(btn.dataset.mode);
});

syncThemeColorMeta();
loadSessions();
connectNotificationWs();
