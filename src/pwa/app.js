if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw register failed', e));
}

const root = document.getElementById('root');
const header = document.getElementById('header');

const state = {
  view: 'list', // 'list' | 'session'
  // Multi-project session list. Populated by loadSessions from /api/sessions.
  // Shape: [{ projectDir, cwd, lastModified, sessions: SessionInfo[] }, ...]
  projects: [],
  // Per-project expand state, keyed by projectDir, persisted in localStorage. Missing
  // keys default to collapsed for older projects and expanded for the most-recent
  // (see isProjectExpanded).
  expandedProjects: (() => {
    try { return JSON.parse(localStorage.getItem('op:expandedProjects') ?? '{}'); }
    catch { return {}; }
  })(),
  currentSessionId: null,
  // The cwd of the session currently open in the session view. Set when openSession() runs
  // (either from the picker for new sessions or by looking up the project for existing
  // ones). Drives projectRelativePath() so file paths in the transcript anchor correctly.
  currentSessionCwd: null,
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
  // Per-block dedup signatures we've already rendered. Block-level (not message-level)
  // because claude emits ONE `assistant` JSONL line per content_block_stop — so 12
  // tool_use calls in a single turn arrive as 12 lines sharing the same msg_id. An
  // envelope-level msg_id dedup processed only the first of those and dropped the rest.
  //   tool_use blocks → keyed by tool_use_id (toolu_*), which is globally unique
  //   text blocks     → keyed by `${msgId}|${text}` so the same text under different
  //                     msg_ids is allowed but the WS replay buffer can't double-push
  seenBlockSigs: new Set(),
  // Phase 3: highest _seq seen on the current session WS. Sent back as ?since=N on every
  // reconnect so the server replays only what we missed. Reset to 0 on every openSession
  // since seq is per-server-session-lifetime; daemon restart resets the server counter,
  // and a replay_gap handler bumps us forward when the gap exceeds the log window.
  lastSeenSeq: 0,
  // Live state for the Task* tools — rendered as a pinned todo panel instead of as raw
  // tool_use entries in the transcript. Rebuilt from disk on session load, then mutated
  // in place as new tool_use / tool_result blocks arrive over the WS.
  //   todos: Map<taskId, { subject, status, description?, activeForm? }>
  //   pendingCreates: Map<tool_use_id, taskInput> — TaskCreate calls awaiting their
  //     tool_result so we can learn the server-assigned task id ("Task #N created...").
  //   consumedTaskResults: Set<tool_use_id> — tool_results we've already absorbed into a
  //     non-transcript surface (Task → todos panel; AskUserQuestion → inline Q&A card), so
  //     a WS replay buffer redelivery or catchUpFromDisk pass doesn't re-render them as
  //     raw transcript tiles.
  todos: new Map(),
  pendingCreates: new Map(),
  consumedTaskResults: new Set(),
  // tool_use_ids of every Task* call we've absorbed into the todos panel. Used on disk
  // replay to drop the matching tool_result rows so they don't leak into the transcript
  // as "TOOL_RESULT Updated task #N status" entries.
  taskToolUseIds: new Set(),
  // tool_use entries (by tool_use_id) the user has tapped open to inspect raw JSON.
  // Persists across re-renders so an incoming WS message doesn't auto-collapse anything.
  // Reset per session in openSession so state doesn't bleed between conversations.
  expandedTools: new Set(),
  // AskUserQuestion tool_use entries waiting for their tool_result (the user's answer).
  // Keys are tool_use_ids; values are direct references into state.transcript so when the
  // result arrives we can fill in the answer field in place without a full re-render.
  pendingAsks: new Map(),
  // Subagent activity feeds. Each agent_id (from the PreToolUse hook for tool calls
  // made by Explore / general-purpose / etc. subagents) gets its own ordered list of
  // entries representing every tool call that subagent makes. Entries stay in the list
  // after they're decided, so the agent feed reads as a continuous mini-transcript
  // (pending approvals + already-resolved tool calls) the same way the parent does.
  //   subagents: Map<agentId, { agentType, firstSeenAt, entries: [
  //     { approvalId, toolName, toolInput, decision: null|'allow'|'deny', enqueuedAt }
  //   ]}>
  //   activeAgentId: which tab is currently selected in the agents sheet
  subagents: new Map(),
  activeAgentId: null,
  // Stable tab display order. Agents are added at the END when first seen; an
  // incoming approval_pending bumps that agent's id to the FRONT (so the user's
  // attention-needing agents are always leftmost without us live-resorting on every
  // decision). Resets per session in openSession.
  agentTabOrder: [],
  // Parent's Agent tool_use invocations the PWA has seen but hasn't yet been able to
  // bind to a subagent. The hook payload that drives subagents has agent_id + agent_type
  // but no description; the parent's Agent call has description + subagent_type. We
  // best-effort bind them by subagent_type ordering — works perfectly for unique types,
  // is a reasonable guess for parallel same-type spawns.
  unboundAgentInvocations: [],
  // Accept-edits mode (mirrors the CLI's --permission-mode=acceptEdits). When on,
  // file-edit tools (Edit / Write / NotebookEdit / MultiEdit) skip the approval card
  // entirely and get auto-allowed the moment they're proposed. Toggled from the
  // appearance sheet, persisted in localStorage so it survives reload.
  acceptEdits: localStorage.getItem('cr:acceptEdits') === 'true',
  // "Thinking" tile telemetry. thinkingStartedAt is the wall-clock at which we started
  // waiting. thinkingOutputTokens is what's shown; it's the max of two sources, since
  // Anthropic's streaming only emits one authoritative `message_delta` per message
  // (with the final cumulative count) — for live updates we have to estimate from
  // content_block_delta event payloads as they arrive. thinkingOutputChars accumulates
  // raw characters from text + json deltas; the displayed token count is chars/4 (an
  // approximation that matches BPE encoding for typical English + code reasonably well),
  // overwritten by the exact value whenever a real usage payload arrives.
  thinkingStartedAt: 0,
  thinkingOutputTokens: 0,
  thinkingOutputChars: 0,
  thinkingTicker: null,
  // Stack of in-flight tool calls (push on tool_use block arrival, pop on matching
  // tool_result). The top of the stack drives the thinking-strip verb — when the
  // assistant is mid-tool we say "reading…" / "grepping…" / etc.; when the stack is
  // empty we fall back to "thinking…". Reset per session in openSession.
  activeTools: [],
  // Tool calls flagged for auto-expansion (accept-edits or allowlist auto-allow) whose
  // matching tool_use block hasn't streamed into state.transcript yet. The PreToolUse
  // hook and the assistant content_block_stop fire in parallel, so the approval_pending
  // / tool_auto_allowed notification can race ahead of the tool_use. Entries are
  // { toolName, toolInputSig, addedAt } — when a tool_use later lands, we walk this
  // list, find the matching signature, and expand the entry on arrival.
  pendingExpand: [],
  // After the stack empties, we linger on the most-recent verb for VERB_LINGER_MS so
  // fast tools (Read, Grep) don't flash by too quickly to read. A new push clears these.
  lingeringVerb: null,
  lingeringTimer: null,
  // Count of file edits auto-allowed during the current session via accept-edits mode.
  // Surfaced as a counter on the header chip so the user can audit what Claude did
  // unsupervised. Reset per session in openSession.
  autoAllowedEdits: 0,
  // Daemon config loaded once at startup via /api/info. Surfaced in the empty state
  // (cwd / rule count) and used to size the approval-card countdown.
  daemonInfo: null,
  // Connection state — separate counters per WS so a flapping session WS doesn't lie
  // about the notification WS (and vice versa). connState is the user-facing rollup:
  //   'connected'    — at least one open, none failed
  //   'reconnecting' — actively retrying (at least one not open) but under failure threshold
  //   'failed'       — at least one has crossed the failure threshold (≥3 consecutive retries)
  // Initial state is 'connecting' until the first onopen lands.
  sessionWsReady: false,
  notifyWsReady: false,
  sessionWsRetries: 0,
  notifyWsRetries: 0,
  sessionWsTimer: null,
  notifyWsTimer: null,
  connState: 'connecting',
  // Tracks whether we've ever had a successful session-WS open for the current session.
  // First open is paired with openSession's /api/sessions/:id/messages fetch — no need
  // to redo it. Subsequent opens (reconnects after iOS background, network blip, etc.)
  // refetch from disk so messages that fell out of the daemon's 30s replay buffer get
  // reconciled into the transcript via seenBlockSigs dedup.
  sessionWsHasConnected: false,
  // Auto-decides (accept-edits) that landed while both WSs were closed. Flushed on the
  // next notification-WS open. Without this, a backgrounded PWA could miss an auto-allow
  // entirely and the hook would time out 10 minutes later with a denied edit.
  pendingDecides: [],
  // Set by commitNewSessionCwd; cleared on the first non-error message we receive for that
  // session id (proof the spawn succeeded), OR by daemon_error handling that bounces the
  // user back to the picker. Without this, a daemon_error for an invalid cwd would render
  // as an empty session view with a "cwd does not exist" tile and no clear next step.
  pendingNewSession: null, // { id, cwd } | null
  // Active permission mode, mirrored from server broadcasts ('ask' | 'accept-edits' | 'plan' | 'bypass').
  approvalMode: 'ask',
  // True when the bypass button has been tapped once — the second tap within 4 s commits.
  bypassConfirmPending: false,
  // Guards against an infinite push-back loop: set to true when we push our local mode back
  // to the server; cleared when the server's echo finally agrees, or on a new WS attach.
  approvalModePushBackSent: false,
  // Last seen usage payload from an `assistant` stream-json message — drives the
  // context-window meter above the composer. Reset per session (the bar is hidden until
  // the first assistant message comes in). cacheRead+cacheCreate occupy the context
  // window even though they bill differently, so the meter sums all four.
  lastUsage: null, // { inputTokens, outputTokens, cacheCreate, cacheRead, model }
  contextWindow: 200_000,
  // Whether the meter breakdown popup is open. Toggled by tapping the bar.
  meterBreakdownOpen: false,
  // Slash-command palette — populated once from /api/info, opened by typing `/` at the
  // start of the composer. Filter text is the composer's current contents (trimmed).
  slashCommands: [],
  paletteOpen: false,
  paletteFilter: '',
  paletteHighlight: 0, // index of the highlighted row for keyboard navigation
};

// Per-model context-window sizes. Updated by PR when Anthropic ships new models; unknown
// ids fall through to a safe 200k default that matches the current production Sonnet/Opus
// shape. The 1M-context Opus build advertises itself with the [1m] suffix.
const CONTEXT_WINDOWS = {
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-opus-4-7': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  _default: 200_000,
};
function lookupContextWindow(modelId) {
  if (!modelId) return CONTEXT_WINDOWS._default;
  return CONTEXT_WINDOWS[modelId] ?? CONTEXT_WINDOWS._default;
}

// Threshold of consecutive failed retries before we flip to the user-facing 'failed' state
// (banner + danger dot). 3 retries with backoff ≈ ~5s before the user sees the banner —
// enough to absorb a brief tunnel hiccup, fast enough that a real outage gets surfaced.
const CONN_FAIL_THRESHOLD = 3;
// Base backoff for WS reconnects. Multiplied by min(retries, 4) on each retry so the gap
// grows from 1.5s → 6s rather than hammering the daemon when it's actually down.
const CONN_BACKOFF_MS = 1500;

// Tools we absorb into the todos panel rather than rendering as transcript entries. Must
// stay in sync with the matching constant in src/session-store.ts.
const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

// File-edit tools auto-approved when state.acceptEdits is on. Mirrors the set the CLI's
// --permission-mode=acceptEdits covers; Bash / Read / Grep stay user-approvable since
// they're not strictly edits and have a wider blast radius.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Tools where the payload is non-obvious from the label alone and the user wants to see
// the full content before approving (Bash command, Edit diff, Write contents, etc.). Used
// to pick a default expansion state for approval cards + resolved tool_use entries.
function isHighDetailTool(toolName) {
  return toolName === 'Bash' || EDIT_TOOLS.has(toolName);
}

// Stable, sort-keys JSON for content-matching. Claude code may re-serialize tool_input
// between the assistant stream and the hook payload, producing the same object content
// with a different key order — vanilla JSON.stringify is order-sensitive and would miss
// the match. Recursive sort keeps the signature canonical regardless of where the value
// came from.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Find the most-recent transcript tool_use entry that matches a given approval/auto-allow
// notification by content. Both sides may be re-serialized by claude code before reaching
// us, so we compare via stableStringify rather than JSON.stringify. Returns the matching
// toolUseId, or null if no entry has arrived yet (notification raced ahead of the
// assistant stream).
function findMatchingToolUseId(toolName, toolInput, sessionId) {
  if (sessionId && sessionId !== state.currentSessionId) return null;
  let targetSig;
  try { targetSig = stableStringify(toolInput); } catch { return null; }
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const m = state.transcript[i];
    if (m.role !== 'tool_use' || m.toolName !== toolName || !m.toolUseId) continue;
    if (state.expandedTools.has(m.toolUseId)) continue;
    try {
      if (stableStringify(m.toolInput) === targetSig) return m.toolUseId;
    } catch { /* keep walking */ }
  }
  return null;
}

// Auto-expand a tool_use by content (name + serialized input). If the matching entry
// is already in state.transcript, expand it immediately. If not (the PreToolUse hook
// fired before the assistant content_block_stop made it to us), queue the signature
// in state.pendingExpand — applyPendingExpand will catch the match when the tool_use
// eventually lands.
function expandToolByContent(toolName, toolInput, sessionId) {
  const id = findMatchingToolUseId(toolName, toolInput, sessionId);
  if (id) {
    state.expandedTools.add(id);
    return true;
  }
  let sig;
  try { sig = stableStringify(toolInput); } catch { return false; }
  state.pendingExpand.push({ toolName, toolInputSig: sig, addedAt: Date.now() });
  // GC stale entries — anything older than 30s couldn't possibly be matched by a future
  // tool_use (claude would have either emitted the block or moved on). Keeps the queue
  // bounded across long sessions where some notifications never find their pair.
  state.pendingExpand = state.pendingExpand.filter((e) => Date.now() - e.addedAt < 30_000);
  return false;
}

// Called when a tool_use lands in state.transcript. Walks pendingExpand looking for a
// signature that matches this tool_use; if found, adds the tool_use_id to expandedTools
// and removes the entry from the queue. Returns whether anything was applied (so the
// caller can decide whether to re-render).
function applyPendingExpand(toolName, toolInput, toolUseId) {
  if (!toolUseId || state.pendingExpand.length === 0) return false;
  let sig;
  try { sig = stableStringify(toolInput); } catch { return false; }
  for (let i = 0; i < state.pendingExpand.length; i++) {
    const e = state.pendingExpand[i];
    if (e.toolName === toolName && e.toolInputSig === sig) {
      state.expandedTools.add(toolUseId);
      state.pendingExpand.splice(i, 1);
      return true;
    }
  }
  return false;
}

// Find a matching tool_use_id inside a subagent bucket (for accept-edits and
// agent_activity paths). Walks the bucket's entries from newest to oldest looking for an
// auto-allowed (decision='allow') entry with matching name + serialized input. Returns
// the entry's toolUseId or null.
function findMatchingSubagentToolUseId(agentId, toolName, toolInput) {
  const bucket = state.subagents.get(agentId);
  if (!bucket) return null;
  let targetSig;
  try { targetSig = JSON.stringify(toolInput); } catch { return null; }
  for (let i = bucket.entries.length - 1; i >= 0; i--) {
    const e = bucket.entries[i];
    if (e.toolName !== toolName || !e.toolUseId) continue;
    if (state.expandedTools.has(e.toolUseId)) continue;
    try {
      if (JSON.stringify(e.toolInput) === targetSig) return e.toolUseId;
    } catch { /* keep walking */ }
  }
  return null;
}

// Apply a Task* tool_use block to state.todos. TaskCreate gets parked in pendingCreates
// until its tool_result arrives (because the assigned task id lives in the result, not the
// input). TaskUpdate mutates the entry in place. TaskList/TaskGet are no-ops here — we
// only swallow them so they don't clutter the transcript.
function applyTaskUse(name, input, useId) {
  // Remember every Task* tool_use_id so the disk replay can drop the matching
  // tool_result rows (TaskUpdate / TaskList / TaskGet results would otherwise leak
  // into the transcript as raw "TOOL_RESULT …" entries).
  if (useId) state.taskToolUseIds.add(useId);
  if (name === 'TaskCreate') {
    if (useId) state.pendingCreates.set(useId, input ?? {});
    return;
  }
  if (name === 'TaskUpdate') {
    const id = input && input.taskId;
    if (!id) return;
    if (input.status === 'deleted') {
      state.todos.delete(id);
      return;
    }
    const cur = state.todos.get(id) ?? { subject: `Task #${id}`, status: 'pending' };
    const next = { ...cur };
    if (typeof input.subject === 'string') next.subject = input.subject;
    if (typeof input.description === 'string') next.description = input.description;
    if (typeof input.activeForm === 'string') next.activeForm = input.activeForm;
    if (typeof input.status === 'string') next.status = input.status;
    state.todos.set(id, next);
  }
}

// Apply a tool_result text to resolve a previously-stashed TaskCreate into a real entry
// with its server-assigned id. The result text starts with "Task #N created successfully: ..."
// — that's the only place the id surfaces, since TaskCreate's input doesn't carry one.
function applyTaskResult(useId, text) {
  if (state.consumedTaskResults.has(useId)) return;
  const pending = state.pendingCreates.get(useId);
  if (!pending) return;
  state.consumedTaskResults.add(useId);
  state.pendingCreates.delete(useId);
  const m = /^Task #(\d+)\b/.exec(String(text));
  if (!m) return;
  const id = m[1];
  state.todos.set(id, {
    subject: pending.subject ?? `Task #${id}`,
    description: pending.description,
    activeForm: pending.activeForm,
    status: 'pending',
  });
}

// Bridge from the disk-replayed transcript (TranscriptMessage[]) to the same state updates
// the live WS path drives. Returns true if the entry was a Task* event so the caller can
// keep it out of state.transcript.
function applyTaskTranscriptMessage(m) {
  if (m.role === 'tool_use' && m.toolName && TASK_TOOL_NAMES.has(m.toolName)) {
    applyTaskUse(m.toolName, m.toolInput, m.toolUseId);
    return true;
  }
  if (m.role === 'tool_result' && m.toolUseId) {
    // TaskCreate results still feed pendingCreates to resolve the assigned task id.
    if (state.pendingCreates.has(m.toolUseId)) {
      applyTaskResult(m.toolUseId, m.text);
      return true;
    }
    // Anything else that paired with a Task* tool_use is informational chatter
    // (TaskUpdate / TaskList / TaskGet acknowledgement text) — drop it.
    if (state.taskToolUseIds.has(m.toolUseId)) return true;
  }
  return false;
}

// AskUserQuestion bridge. Different shape from Task because the result actually belongs
// in the transcript as a Q&A record (not folded into a sidebar). Pushes a role='ask'
// entry on tool_use; later, the matching tool_result fills in the entry's `answer`. The
// caller passes the array we should push into so this works for both the live transcript
// and the disk-replay "filtered" buffer.
function applyAskTranscriptMessage(m, sink) {
  if (m.role === 'tool_use' && m.toolName === 'AskUserQuestion') {
    const questions = Array.isArray(m.toolInput?.questions) ? m.toolInput.questions : [];
    const entry = {
      role: 'ask',
      text: '',
      msgId: m.msgId,
      toolUseId: m.toolUseId,
      questions,
      answer: null,
    };
    sink.push(entry);
    if (m.toolUseId) state.pendingAsks.set(m.toolUseId, entry);
    return true;
  }
  if (m.role === 'tool_result' && m.toolUseId && state.pendingAsks.has(m.toolUseId)) {
    const entry = state.pendingAsks.get(m.toolUseId);
    entry.answer = String(m.text ?? '');
    state.pendingAsks.delete(m.toolUseId);
    // Record this tool_use_id as already-absorbed so catchUpFromDisk's tool_result skip
    // check fires on subsequent reconnects. Without this, every visibilitychange replays
    // every previously-answered Ask as a raw "Your questions have been answered: …" tile.
    state.consumedTaskResults.add(m.toolUseId);
    return true;
  }
  return false;
}

// Wire the HTML-rendered initial shell so the "+ Add project" button works from the very
// first paint, before /api/sessions resolves. The full list renders in once loadSessions does.
const initialButton = document.getElementById('add-project-initial');
if (initialButton) initialButton.onclick = () => openAddProjectSheet();

// One-shot fetch of /api/info on startup. Surface daemon config so the empty state can
// confirm the wiring (cwd, allowlist size) and the approval countdown has a real timeout
// to count against. Failures are silent — info is informational, not load-bearing.
async function loadDaemonInfo() {
  try {
    const r = await fetch('/api/info');
    if (!r.ok) return;
    state.daemonInfo = await r.json();
    if (Array.isArray(state.daemonInfo.slashCommands)) {
      state.slashCommands = state.daemonInfo.slashCommands;
    }
    if (state.view === 'list') renderList();
    else if (state.view === 'session') updateSlashPalette();
  } catch { /* offline-ok */ }
}

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.projects = data.projects;
    state.pendingApprovals = data.pending ?? [];
    for (const a of state.pendingApprovals) {
      if (isHighDetailTool(a.toolName)) state.expandedTools.add(`approval-${a.approvalId}`);
    }
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
    brand.textContent = 'Outpost';
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
    // Surface accept-edits mode in the session header — small accent-bordered chip
    // sits between the back link and the session-id meta. Easy to glance at while
    // burning through approvals, and a constant reminder the mode is on.
    if (state.acceptEdits) {
      const chip = document.createElement('span');
      chip.className = 'header-mode-chip';
      // Counter ticks each time accept-edits silently approves an edit; lets the user
      // audit unsupervised activity at a glance without opening the agents sheet.
      chip.textContent = state.autoAllowedEdits > 0
        ? `auto-edits · ${state.autoAllowedEdits}`
        : 'auto-edits on';
      header.appendChild(chip);
    }
    header.appendChild(m);
  }
}

function renderList() {
  const pendingBySession = state.pendingApprovals.reduce((acc, a) => {
    acc[a.sessionId] = (acc[a.sessionId] || 0) + 1;
    return acc;
  }, {});
  const banner = state.connState === 'failed'
    ? `<div class="conn-banner" role="alert">
        <span class="conn-banner-msg">Daemon unreachable — check Tailscale</span>
        <button type="button" id="conn-banner-retry">Retry</button>
      </div>`
    : '';
  const info = state.daemonInfo
    ? `<div class="list-footer">${escapeHtml(String(state.daemonInfo.allowlistRuleCount))} tools auto-approve</div>`
    : '';

  if (state.projects.length === 0) {
    root.innerHTML = `
      <div class="session-list">
        <button class="add-project" id="add-project">
          <span>Add project</span>
          <span class="plus">+</span>
        </button>
        <div class="empty-state">No projects yet. Tap “Add project” above to register one.</div>
        ${info}
      </div>
      ${banner}
    `;
  } else {
    // Phase 2a: even a single project gets the expandable section UI. The most-recent
    // project auto-expands so the common one-project case stays one tap away from spawn.
    const sections = state.projects.map((p, i) => projectSectionHtml(p, i === 0, pendingBySession)).join('');
    root.innerHTML = `
      <div class="session-list">
        <button class="add-project" id="add-project">
          <span>Add project</span>
          <span class="plus">+</span>
        </button>
        ${sections}
        ${info}
      </div>
      ${banner}
    `;
    bindProjectSectionToggles(pendingBySession);
  }

  document.getElementById('add-project').onclick = () => openAddProjectSheet();
  document.getElementById('conn-banner-retry')?.addEventListener('click', forceReconnect);
  bindSessionRowHandlers();
  bindProjectOverflowHandlers();
}

function bindSessionRowHandlers() {
  for (const row of document.querySelectorAll('.session-row')) {
    wireSwipeToDelete(row);
  }
  for (const btn of document.querySelectorAll('.delete-action')) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      const wrap = btn.closest('.session-row-wrap');
      const row = wrap?.querySelector('.session-row');
      const title = row?.querySelector('.title')?.textContent ?? id;
      const ok = await confirmInSheet({
        title: 'Delete session?',
        body: `“${title}” will be removed permanently. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) { if (row) snapRowClosed(row); return; }
      deleteSession(id);
    };
  }
  for (const btn of document.querySelectorAll('.session-overflow')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.sessionOverflow;
      const row = btn.closest('.session-row');
      const archivable = row?.dataset.archivable === 'yes';
      showSessionOverflowMenu(btn, id, { archivable });
    };
  }
}

function showSessionOverflowMenu(anchor, sessionId, opts) {
  document.querySelector('.session-overflow-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'session-overflow-menu';
  const archiveBtn = opts.archivable
    ? `<button class="session-overflow-item" data-action="archive" type="button">Archive worktree</button>`
    : '';
  menu.innerHTML = `${archiveBtn}<button class="session-overflow-item session-overflow-item-danger" data-action="delete" type="button">Delete</button>`;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  for (const item of menu.querySelectorAll('.session-overflow-item')) {
    item.onclick = async (e) => {
      e.stopPropagation();
      close();
      const action = item.dataset.action;
      if (action === 'archive') {
        const ok = await confirmInSheet({
          title: 'Archive worktree?',
          body: 'The worktree directory and its branch will be deleted. The session transcript stays.',
          confirmLabel: 'Archive',
          danger: true,
        });
        if (!ok) return;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST' });
          if (!r.ok) console.warn('archive failed:', r.status);
        } catch (err) { console.warn('archive failed:', err); }
        if (globalThis.__outpostRefreshSessions) await globalThis.__outpostRefreshSessions();
      } else if (action === 'delete') {
        const ok = await confirmInSheet({
          title: 'Delete session?',
          body: 'The session transcript and any worktree will be removed permanently.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        deleteSession(sessionId);
      }
    };
  }
}

function projectSectionHtml(p, isMostRecent, pendingBySession) {
  const expanded = isProjectExpanded(p.projectDir, isMostRecent);
  const basename = p.cwd.split('/').filter(Boolean).pop() || p.cwd;
  // Aggregate pending counts across this project's sessions so the header can
  // show "N pending" without forcing the user to expand the section first.
  const projectPending = p.sessions.reduce(
    (acc, s) => acc + (pendingBySession[s.id] ?? 0), 0,
  );
  const sessCount = p.sessions.length;
  const metaBlock = projectPending > 0
    ? `<span class="project-section-pending"><span class="dot"></span>${projectPending} pending</span>
       <span class="project-section-meta" aria-hidden="true">
         <span class="project-section-meta-count">${sessCount}</span>${escapeHtml(timeAgo(p.lastModified))}
       </span>`
    : `<span class="project-section-meta">
         <span class="project-section-meta-count">${sessCount}</span>${escapeHtml(timeAgo(p.lastModified))}
       </span>`;
  // Overflow ⋯ only appears on registry-only rows (source==='registry'). For
  // claude-discovered or both-source projects, removing from the registry doesn't
  // change the visible list (session JSONLs keep it discovered), so we hide it.
  const overflow = (p.source === 'registry')
    ? `<button class="project-overflow" type="button" data-cwd="${escapeHtml(p.cwd)}" aria-label="Project options">⋯</button>`
    : '';
  return `
    <section class="project-section${expanded ? ' project-section-open' : ''}" data-project-dir="${escapeHtml(p.projectDir)}" data-cwd="${escapeHtml(p.cwd)}">
      <button class="project-section-header" type="button" aria-expanded="${expanded ? 'true' : 'false'}">
        <span class="project-section-name">${escapeHtml(basename)}</span>
        <span class="project-section-cwd"><span>${escapeHtml(p.cwd)}</span></span>
        ${metaBlock}
        ${overflow}
      </button>
      <div class="project-section-body">${expanded ? projectSectionBodyHtml(p, pendingBySession) : ''}</div>
    </section>
  `;
}

// Body shown when a project is expanded. "+ New session" sits at the TOP so projects
// with many sessions don't require scrolling to start a fresh one. For git repos, a
// branch picker sits above the button — its value drives the new session's base branch.
function projectSectionBodyHtml(p, pendingBySession) {
  const branchPicker = p.isGitRepo
    ? `<div class="project-branch-picker" data-cwd="${escapeHtml(p.cwd)}">
         <span class="project-branch-label">Branch</span>
         <select class="project-branch-select"><option value="">loading…</option></select>
       </div>`
    : '';
  const newBtn = `<button class="project-new-session" type="button" data-cwd="${escapeHtml(p.cwd)}" data-is-git="${p.isGitRepo ? 'yes' : 'no'}">
    <span class="plus">+</span><span>New session</span>
  </button>`;
  const rows = p.sessions.length === 0
    ? `<div class="project-section-empty">No sessions yet.</div>`
    : p.sessions.map((s, i) => sessionRowHtml(s, i, pendingBySession[s.id] ?? 0)).join('');
  return branchPicker + newBtn + rows;
}

// Cache the per-cwd branch list. /api/projects/:sanitized/branches caches on the daemon
// side too (30s), so client + server work in tandem.
const branchesByCwd = new Map();

async function loadBranchesForCwd(cwd) {
  const cached = branchesByCwd.get(cwd);
  if (cached && Date.now() - cached.fetchedAt < 30_000) return cached;
  const sanitized = cwd.replace(/\//g, '-');
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(sanitized)}/branches`);
    if (!r.ok) return null;
    const data = await r.json();
    const entry = { branches: data.branches ?? [], defaultBranch: data.defaultBranch, fetchedAt: Date.now() };
    branchesByCwd.set(cwd, entry);
    return entry;
  } catch { return null; }
}

async function populateBranchPicker(pickerEl) {
  const cwd = pickerEl.dataset.cwd;
  const select = pickerEl.querySelector('.project-branch-select');
  if (!cwd || !select) return;
  const data = await loadBranchesForCwd(cwd);
  if (!data || data.branches.length === 0) {
    select.innerHTML = `<option value="">unavailable</option>`;
    return;
  }
  const def = data.defaultBranch
    ?? data.branches.find((b) => b === 'main' || b === 'master')
    ?? data.branches[0];
  select.innerHTML = data.branches
    .map((b) => `<option value="${escapeHtml(b)}"${b === def ? ' selected' : ''}>${escapeHtml(b)}</option>`)
    .join('');
}

function bindProjectSectionToggles(pendingBySession) {
  for (const btn of document.querySelectorAll('.project-section-header')) {
    btn.onclick = (ev) => {
      // Clicking the overflow ⋯ inside the header shouldn't toggle expand.
      if (ev.target.closest('.project-overflow')) return;
      const section = btn.closest('.project-section');
      const projectDir = section.dataset.projectDir;
      const willExpand = !section.classList.contains('project-section-open');
      section.classList.toggle('project-section-open', willExpand);
      setProjectExpanded(projectDir, willExpand);
      const body = section.querySelector('.project-section-body');
      if (willExpand) {
        const p = state.projects.find((pp) => pp.projectDir === projectDir);
        body.innerHTML = p ? projectSectionBodyHtml(p, pendingBySession) : '';
        bindSessionRowHandlers();
        bindProjectNewSessionHandlers();
        const picker = body.querySelector('.project-branch-picker');
        if (picker) void populateBranchPicker(picker);
      } else {
        body.innerHTML = '';
      }
    };
  }
  bindProjectNewSessionHandlers();
  // Populate branch dropdowns for already-expanded sections rendered by render().
  for (const picker of document.querySelectorAll('.project-branch-picker')) {
    void populateBranchPicker(picker);
  }
}

function bindProjectNewSessionHandlers() {
  for (const btn of document.querySelectorAll('.project-new-session')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const cwd = btn.dataset.cwd;
      const isGit = btn.dataset.isGit === 'yes';
      if (!cwd) return;
      if (isGit) {
        // Default: spawn worktree on the picker-selected branch.
        const section = btn.closest('.project-section');
        const picker = section?.querySelector('.project-branch-picker .project-branch-select');
        const branch = (picker && picker.value) || 'main';
        commitNewSessionCwd(cwd, { spawnMode: 'worktree', baseBranch: branch });
      } else {
        commitNewSessionCwd(cwd);
      }
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      showNewSessionAltMenu(btn);
    };
    // Touch long-press → alt menu (for "New shared session" override on a git repo).
    let pressTimer = null;
    btn.ontouchstart = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => showNewSessionAltMenu(btn), 600);
    };
    btn.ontouchend = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
  }
}

function showNewSessionAltMenu(btn) {
  document.querySelector('.new-session-alt-menu')?.remove();
  const cwd = btn.dataset.cwd;
  const isGit = btn.dataset.isGit === 'yes';
  // Only offer the override on git repos — for non-git, shared is already the default.
  if (!isGit) return;
  const menu = document.createElement('div');
  menu.className = 'new-session-alt-menu';
  menu.innerHTML = `<button class="new-session-alt-item" type="button">New shared session</button>`;
  document.body.appendChild(menu);
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.top - 44}px`;
  menu.style.left = `${rect.left}px`;
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  menu.querySelector('.new-session-alt-item').onclick = (e) => {
    e.stopPropagation();
    close();
    if (cwd) commitNewSessionCwd(cwd, { spawnMode: 'shared' });
  };
}

// Overflow ⋯ menu for registry-only projects. One item: "Remove from list" → DELETE /api/projects.
function bindProjectOverflowHandlers() {
  for (const btn of document.querySelectorAll('.project-overflow')) {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const cwd = btn.dataset.cwd;
      if (!cwd) return;
      showProjectOverflowMenu(btn, cwd);
    };
  }
}

function showProjectOverflowMenu(anchor, cwd) {
  // Close any existing menu first.
  document.querySelector('.project-overflow-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'project-overflow-menu';
  menu.innerHTML = `<button class="project-overflow-item" type="button">Remove from list</button>`;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - 200)}px`;
  // Close on any outside click. Scheduled in next tick so the current click that
  // opened the menu doesn't immediately close it.
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);

  menu.querySelector('.project-overflow-item').onclick = async (e) => {
    e.stopPropagation();
    close();
    try {
      const res = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (res.ok) {
        await loadSessions();
      }
    } catch { /* network error — show toast if we had one */ }
  };
}

function sessionRowHtml(s, i, pendingCount) {
  const marker = String(i + 1).padStart(2, '0');
  const hasPending = pendingCount > 0;
  // pendingCount is a numeric integer derived from state, not interpolated user input.
  // All string fields (id, title, timeAgo output) are routed through escapeHtml.
  const pendingBadge = hasPending
    ? `<span class="sep">·</span><span class="pending-badge"><span class="dot"></span><span>${pendingCount} pending</span></span>`
    : '';
  // Worktree sessions get a ⌥ badge showing the auto-generated branch name. Archived
  // worktrees show a dimmed "archived" badge in place of the branch (the branch is gone).
  const wtBadge = s.archived
    ? `<span class="sep">·</span><span class="worktree-badge worktree-badge-archived">archived</span>`
    : s.worktreeBranch
      ? `<span class="sep">·</span><span class="worktree-badge">⌥ ${escapeHtml(s.worktreeBranch)}</span>`
      : '';
  const rowClass = `session-row${s.archived ? ' session-row-archived' : ''}`;
  return `
    <div class="session-row-wrap">
      <button class="delete-action" data-delete="${escapeHtml(s.id)}" aria-label="Delete session">Delete</button>
      <div class="${rowClass}" data-id="${escapeHtml(s.id)}" data-archivable="${s.worktreePath && !s.archived ? 'yes' : 'no'}">
        <span class="marker${hasPending ? ' pending' : ''}">${marker}</span>
        <div class="body">
          <div class="title">${escapeHtml(s.title)}</div>
          <div class="meta">
            <span>${escapeHtml(timeAgo(s.lastModified))}</span>
            <span class="sep">·</span>
            <span>${escapeHtml(s.id.slice(0, 8))}</span>
            ${wtBadge}
            ${pendingBadge}
          </div>
        </div>
        <button class="session-overflow" type="button" data-session-overflow="${escapeHtml(s.id)}" aria-label="More actions">⋯</button>
      </div>
    </div>
  `;
}

async function openSession(id, opts) {
  const isNew = id === null || !!opts?.cwd;
  if (id === null) id = crypto.randomUUID();
  state.currentSessionId = id;
  // Resolve the cwd for this session so projectRelativePath() can anchor file paths to
  // the project root. For a new session, opts.cwd is the picker's choice. For an existing
  // session, walk the project list. Falls back to null and shortenPath() handles undefined.
  if (opts?.cwd) {
    state.currentSessionCwd = opts.cwd;
  } else {
    state.currentSessionCwd = null;
    for (const p of state.projects) {
      if (p.sessions.some((s) => s.id === id)) { state.currentSessionCwd = p.cwd; break; }
    }
  }
  state.view = 'session';
  state.transcript = [];
  state.seenBlockSigs = new Set();
  state.sessionWsHasConnected = false;
  // Phase 3: fresh session view → server replays from earliest still in its log.
  state.lastSeenSeq = 0;
  // Per-session reset: todos, pendingCreates, and consumedTaskResults all belong to one
  // session's task list. Resetting here keeps the panel from leaking between sessions.
  state.todos = new Map();
  state.pendingCreates = new Map();
  state.consumedTaskResults = new Set();
  state.taskToolUseIds = new Set();
  state.expandedTools = new Set();
  state.pendingAsks = new Map();
  state.subagents = new Map();
  state.activeAgentId = null;
  state.agentTabOrder = [];
  state.unboundAgentInvocations = [];
  state.autoAllowedEdits = 0;
  state.activeTools = [];
  state.pendingExpand = [];
  // Token meter is per-session — usage from a previous session would otherwise show
  // until the new session's first assistant turn lands.
  state.lastUsage = null;
  state.meterBreakdownOpen = false;
  // Slash palette also per-session so a stale filter doesn't carry across.
  state.paletteOpen = false;
  state.paletteFilter = '';
  state.paletteHighlight = 0;
  if (state.lingeringTimer) clearTimeout(state.lingeringTimer);
  state.lingeringVerb = null;
  state.lingeringTimer = null;
  // Rehydrate per-session subagent buckets from the global approval queue. The
  // notification WS holds approvals across sessions, so when the user navigates from
  // session A to B (e.g. tapping a cross-session subagent approval toast), B's pending
  // agents are already sitting in state.pendingApprovals — re-route them here so the
  // agents strip and sheet aren't empty on arrival. Auto-allowed (agent_activity)
  // history is lost on session change; it's resolved-only and doesn't need user action.
  for (const a of state.pendingApprovals) {
    if (a.sessionId === id && a.agentId) addSubagentEntry(a);
  }
  stopThinking();
  state.transcriptLoading = !isNew;
  // Dismiss any cross-session toast — it's either about this session (we're already
  // here) or about a different one the user is choosing not to follow right now.
  document.getElementById('toast')?.remove();
  // The composer persists across WS-driven re-renders, but it should not carry a
  // previous session's draft text when navigating A → B without leaving the session view.
  const existingComposer = document.getElementById('composer');
  if (existingComposer) {
    existingComposer.textContent = '';
    document.getElementById('send')?.classList.remove('armed');
  }
  render();
  if (!isNew) {
    // Kick off the subagents fetch in parallel with /messages — they're independent and
    // we want the agents sheet to be populated as soon as possible. Race the response
    // against currentSessionId so a fast tab-switch doesn't leak buckets across sessions.
    fetch(`/api/sessions/${encodeURIComponent(id)}/subagents`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body || state.currentSessionId !== id) return;
        applyDiskSubagents(body.subagents || []);
        if (state.view === 'session') renderSession();
      })
      .catch((e) => console.warn('failed to load subagents:', e));
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
      if (r.ok) {
        const { messages } = await r.json();
        // The user might have already started typing while we were fetching; only
        // replace the transcript if we haven't moved on to another session.
        if (state.currentSessionId === id) {
          // Replay each disk message through the same dispatch the live WS path uses, so
          // task events build state.todos and never reach state.transcript, and Ask events
          // get folded into a role='ask' entry instead of a raw tool_use tile. Everything
          // else flows into the transcript in original order.
          const filtered = [];
          for (const m of messages) {
            // Seed the block-level dedup set with what's already on disk so the WS
            // replay buffer (which may redeliver the most recent ~30s) doesn't double-push.
            if (m.toolUseId) state.seenBlockSigs.add(m.toolUseId);
            if (m.role === 'assistant' && m.msgId) state.seenBlockSigs.add(`${m.msgId}|${m.text}`);
            if (applyTaskTranscriptMessage(m)) continue;
            if (applyAskTranscriptMessage(m, filtered)) continue;
            // Parent's Agent invocations from disk feed the same description-binding
            // path as the live stream. Without this, reopening a session loses the
            // descriptions of every subagent that's still running (the snapshot rebuild
            // at openSession only has hook payloads, not the parent's input).
            if (m.role === 'tool_use' && m.toolName === 'Agent' && m.toolInput && typeof m.toolInput === 'object') {
              recordParentAgentInvocation({
                toolUseId: m.toolUseId,
                subagentType: m.toolInput.subagent_type,
                description: m.toolInput.description,
              });
            }
            filtered.push(m);
          }
          state.transcript = filtered;
        }
      }
    } catch (e) {
      console.warn('failed to load session transcript:', e);
    } finally {
      state.transcriptLoading = false;
      if (state.currentSessionId === id) renderSession();
    }
  }
  connectWs(id, opts);
}

// Called from connectWs's onopen handler on reconnect (not the initial open of a session).
// Refetches /api/sessions/:id/messages and appends any block we don't already have in
// state.seenBlockSigs. Dedup is what makes this safe — running it after every reconnect
// is a no-op when nothing was missed, and recovers the gap when iOS backgrounded the PWA
// past the daemon's 30s recentMessages buffer. The /subagents snapshot is also refetched
// the same way so subagent activity that landed during the gap reappears.
async function catchUpFromDisk(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
    if (!r.ok || state.currentSessionId !== id) return;
    const { messages } = await r.json();
    if (state.currentSessionId !== id) return;

    // Stale-state detection: count assistant text messages on disk vs in memory. After
    // iOS keeps a PWA suspended for hours, the JS heap can be partially evicted —
    // state.transcript may end up sparse while state.seenBlockSigs retains the
    // signatures of messages that no longer exist in the transcript array. The
    // dedup-append path below would then skip every disk message ("already seen") and
    // never repopulate the transcript. Detect this drift and do a full rebuild instead.
    const diskAssistantCount = messages.filter((m) => m.role === 'assistant').length;
    const memAssistantCount = state.transcript.filter((m) => m.role === 'assistant').length;
    if (diskAssistantCount > memAssistantCount + 1) {
      rebuildTranscriptFromDisk(messages);
      try {
        const r2 = await fetch(`/api/sessions/${encodeURIComponent(id)}/subagents`);
        if (r2.ok && state.currentSessionId === id) {
          const body = await r2.json();
          applyDiskSubagents(body.subagents || []);
        }
      } catch { /* ignore */ }
      if (state.view === 'session') renderSession();
      return;
    }

    // User messages on disk have no msgId (claude doesn't assign API ids to them), so the
    // block-level dedup below can't catch them. Both disk and state.transcript preserve
    // send-order for user messages, so the count of user messages we already have is also
    // the count of disk user messages to skip — including claude's own synthetic
    // "[Request interrupted by user]" entry it writes on SIGINT. Without this, every WS
    // open (initial, post-Reopen, post-iOS-background) re-pushed every user message.
    let userMsgsToSkip = state.transcript.filter((m) => m.role === 'user').length;
    let added = false;
    for (const m of messages) {
      // Block-level dedup: tool_use keyed by tool_use_id, assistant text by msgId|text.
      // Both keys are already populated by the live WS path, so anything in state already
      // gets short-circuited here.
      if (m.role === 'tool_use' && m.toolUseId) {
        if (state.seenBlockSigs.has(m.toolUseId)) continue;
        state.seenBlockSigs.add(m.toolUseId);
      } else if (m.role === 'assistant' && m.msgId) {
        const sig = `${m.msgId}|${m.text}`;
        if (state.seenBlockSigs.has(sig)) continue;
        state.seenBlockSigs.add(sig);
      } else if (m.role === 'tool_result' && m.toolUseId && state.consumedTaskResults.has(m.toolUseId)) {
        continue;
      } else if (m.role === 'user') {
        if (userMsgsToSkip > 0) { userMsgsToSkip--; continue; }
      }
      // Route through the same Task/Ask absorbers the live path uses so missed Task*
      // mutations rebuild the todos panel and Ask answers fill their inline cards.
      if (applyTaskTranscriptMessage(m)) { added = true; continue; }
      if (applyAskTranscriptMessage(m, state.transcript)) { added = true; continue; }
      if (m.role === 'tool_use' && m.toolName === 'Agent' && m.toolInput && typeof m.toolInput === 'object') {
        recordParentAgentInvocation({
          toolUseId: m.toolUseId,
          subagentType: m.toolInput.subagent_type,
          description: m.toolInput.description,
        });
      }
      state.transcript.push(m);
      added = true;
    }
    // Also refresh subagent buckets — the same gap could have lost agent_activity events
    // and subagent tool_use blocks. applyDiskSubagents prepends disk entries to existing
    // buckets without wiping in-memory state.
    try {
      const r2 = await fetch(`/api/sessions/${encodeURIComponent(id)}/subagents`);
      if (r2.ok && state.currentSessionId === id) {
        const body = await r2.json();
        applyDiskSubagents(body.subagents || []);
        added = true;
      }
    } catch { /* ignore subagent fetch failure — main message fetch already succeeded */ }
    if (added && state.view === 'session') renderSession();
  } catch (e) {
    console.warn('failed to catch up from disk:', e);
  }
}

// Full rebuild of state.transcript from a disk message snapshot — mirrors openSession's
// replay logic. Used by catchUpFromDisk when stale-state drift is detected (disk has
// substantially more assistant content than memory). Any locally-pushed user message
// that hasn't been written to disk yet (the user sent + immediately backgrounded race)
// is preserved by appending such entries back at the end.
function rebuildTranscriptFromDisk(messages) {
  // Capture pending local pushes: user messages with no msgId that aren't on disk yet.
  // Claude code writes user messages to disk shortly after receiving them via the WS,
  // so this is only relevant for the very narrow window between sendMessage and the
  // disk flush. Comparing by text alone is a coarse match but adequate for this race.
  const diskUserTexts = new Set(
    messages.filter((m) => m.role === 'user' && typeof m.text === 'string').map((m) => m.text),
  );
  const pendingLocalUsers = state.transcript.filter(
    (m) => m.role === 'user' && !m.msgId && !diskUserTexts.has(m.text),
  );

  state.seenBlockSigs = new Set();
  state.consumedTaskResults = new Set();
  state.taskToolUseIds = new Set();
  state.todos = new Map();
  state.pendingCreates = new Map();

  const filtered = [];
  for (const m of messages) {
    if (m.toolUseId) state.seenBlockSigs.add(m.toolUseId);
    if (m.role === 'assistant' && m.msgId) state.seenBlockSigs.add(`${m.msgId}|${m.text}`);
    if (applyTaskTranscriptMessage(m)) continue;
    if (applyAskTranscriptMessage(m, filtered)) continue;
    if (m.role === 'tool_use' && m.toolName === 'Agent' && m.toolInput && typeof m.toolInput === 'object') {
      recordParentAgentInvocation({
        toolUseId: m.toolUseId,
        subagentType: m.toolInput.subagent_type,
        description: m.toolInput.description,
      });
    }
    filtered.push(m);
  }
  state.transcript = [...filtered, ...pendingLocalUsers];
}

function leaveSession() {
  state.view = 'list';
  if (state.sessionWsTimer) { clearTimeout(state.sessionWsTimer); state.sessionWsTimer = null; }
  state.ws?.close();
  state.ws = null;
  state.currentSessionId = null;
  state.sessionWsReady = false;
  state.sessionWsRetries = 0;
  state.sessionWsHasConnected = false;
  stopThinking();
  document.getElementById('toast')?.remove();
  closeTodosSheet();
  closeAskSheet();
  closeAgentsSheet();
  loadSessions();
}

function connectWs(id, opts) {
  if (state.sessionWsTimer) { clearTimeout(state.sessionWsTimer); state.sessionWsTimer = null; }
  if (state.ws) state.ws.close();
  state.sessionWsReady = false;
  state.approvalModePushBackSent = false;
  updateConnIndicator();
  const params = new URLSearchParams();
  if (opts?.cwd) params.set('cwd', opts.cwd);
  if (opts?.spawn) params.set('spawn', opts.spawn);
  if (opts?.base) params.set('base', opts.base);
  // Phase 3: always send since=N so the server replays only what we missed.
  params.set('since', String(state.lastSeenSeq | 0));
  const query = params.toString();
  const ws = new WebSocket(`wss://${location.host}/ws/sessions/${id}${query ? `?${query}` : ''}`);
  state.ws = ws;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    // Stamp lastSeenSeq off any event the server tagged. Non-event protocol frames
    // (session_state, replay_gap, daemon_error, daemon_proc_exit) carry no _seq.
    if (typeof msg._seq === 'number' && msg._seq > state.lastSeenSeq) {
      state.lastSeenSeq = msg._seq;
    }
    if (msg.type === 'session_state') {
      // Informational — replay (if any) follows immediately in subsequent messages.
      return;
    }
    if (msg.type === 'replay_gap') {
      // Server's log evicted everything past our last-seen. The existing HTTP-fallback
      // catchUpFromDisk handles the gap — its seenBlockSigs dedup makes calling it here
      // safe whether or not the live WS has delivered anything since.
      state.replayGapCount = (state.replayGapCount ?? 0) + 1;
      catchUpFromDisk(id);
      // Bump lastSeenSeq to just below earliest so the next reconnect doesn't trigger
      // another replay_gap for events that have since been GC'd again.
      state.lastSeenSeq = Math.max(state.lastSeenSeq, (msg.earliest ?? 1) - 1);
      return;
    }
    handleWsMessage(msg);
  };
  ws.onopen = () => {
    state.sessionWsReady = true;
    state.sessionWsRetries = 0;
    updateConnIndicator();
    state.sessionWsHasConnected = true;
    // Always run catchUpFromDisk on every WS open — first connect, reopen-after-
    // interrupt, reconnect-after-background, all of them. The dedup against
    // seenBlockSigs makes it a no-op when nothing was missed, and the stale-state
    // detection rebuilds the transcript when openSession's own /messages fetch
    // failed silently (e.g. transient daemon restart during a tap-Reopen race).
    catchUpFromDisk(id);
  };
  ws.onclose = () => {
    // If a newer connectWs has already replaced this socket (e.g., a Reopen double-tap or
    // a forceReconnect landed while we were still in CONNECTING state), the newer socket
    // owns the readiness/retry state — leave it alone. Without this guard, the stale
    // onclose would schedule a setTimeout that later kills the working newer socket and
    // spawns a redundant reconnect cycle.
    if (state.ws !== ws) return;
    state.sessionWsReady = false;
    if (state.currentSessionId !== id) {
      updateConnIndicator();
      return;
    }
    state.sessionWsRetries += 1;
    updateConnIndicator();
    const delay = CONN_BACKOFF_MS * Math.min(state.sessionWsRetries, 4);
    state.sessionWsTimer = setTimeout(() => connectWs(id), delay);
  };
  ws.onerror = () => { /* close handler retries */ };
}

// Notification WS: stays open for the app's whole lifetime. Reconnects on close so
// iOS backgrounding doesn't permanently sever it. Delivers a one-time snapshot of
// already-pending approvals on attach, then live approval_pending events as they fire.
function connectNotificationWs() {
  if (state.notifyWs && state.notifyWs.readyState === WebSocket.OPEN) return;
  if (state.notifyWsTimer) { clearTimeout(state.notifyWsTimer); state.notifyWsTimer = null; }
  state.notifyWsReady = false;
  updateConnIndicator();
  const ws = new WebSocket(`wss://${location.host}/ws/notifications`);
  state.notifyWs = ws;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleNotificationMessage(msg);
  };
  ws.onopen = () => {
    state.notifyWsReady = true;
    state.notifyWsRetries = 0;
    updateConnIndicator();
    flushPendingDecides();
  };
  ws.onclose = () => {
    state.notifyWs = null;
    state.notifyWsReady = false;
    state.notifyWsRetries += 1;
    updateConnIndicator();
    const delay = CONN_BACKOFF_MS * Math.min(state.notifyWsRetries, 4);
    state.notifyWsTimer = setTimeout(connectNotificationWs, delay);
  };
  ws.onerror = () => { /* close handler retries */ };
}

// Compute the user-facing connection state from the two WS counters and apply it to the
// DOM. In the list view only the notification WS is relevant; in a session both matter.
// Re-renders the session view when the failed state changes so the reconnect banner
// appears/disappears.
function updateConnIndicator() {
  const inSession = state.view === 'session';
  const sessionFailed = inSession && state.sessionWsRetries >= CONN_FAIL_THRESHOLD;
  const notifyFailed = state.notifyWsRetries >= CONN_FAIL_THRESHOLD;
  const anyFailed = sessionFailed || notifyFailed;
  const allReady = state.notifyWsReady && (!inSession || state.sessionWsReady);

  const next = anyFailed ? 'failed' : (allReady ? 'connected' : 'reconnecting');
  const prev = state.connState;
  state.connState = next;
  document.documentElement.setAttribute('data-conn', next);

  // The banner lives inside renderSession's / renderList's output; switching to/from
  // 'failed' needs a re-render to add/remove the element. Other transitions only flip
  // the dot color, which CSS handles via the data-conn attribute alone.
  if ((prev === 'failed') !== (next === 'failed')) {
    if (inSession) renderSession();
    else renderList();
  }
}

// Manual retry from the banner. Resets the retry counters and kicks off immediate
// reconnects of both WSs, bypassing whatever backoff timer is pending.
function forceReconnect() {
  state.sessionWsRetries = 0;
  state.notifyWsRetries = 0;
  if (state.sessionWsTimer) { clearTimeout(state.sessionWsTimer); state.sessionWsTimer = null; }
  if (state.notifyWsTimer) { clearTimeout(state.notifyWsTimer); state.notifyWsTimer = null; }
  if (state.currentSessionId) connectWs(state.currentSessionId);
  connectNotificationWs();
}

// Idempotent ask-tile seeder. Two independent code paths can learn about an Ask:
//   1. The notification WS delivers approval_pending — carrying toolInput but no
//      tool_use_id (the hook doesn't surface it).
//   2. The session WS delivers the matching assistant message — carrying tool_use_id
//      and the same toolInput.
// Either one can arrive first (in practice the notification often wins because the
// session subprocess can buffer its assistant message until the tool resolves), so
// both call this helper. It finds an existing unanswered ask tile and fills in any
// missing fields, or pushes a fresh one if none exists. Returns the entry.
function ensureAskInlineTile({ toolInput, msgId, toolUseId }) {
  let entry = state.transcript.find((m) => m.role === 'ask' && m.answer == null);
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (entry) {
    if (toolUseId && !entry.toolUseId) {
      entry.toolUseId = toolUseId;
      state.pendingAsks.set(toolUseId, entry);
    }
    if (msgId && !entry.msgId) entry.msgId = msgId;
    if (qs.length > 0 && entry.questions.length === 0) entry.questions = qs;
    return entry;
  }
  entry = {
    role: 'ask',
    text: '',
    msgId,
    toolUseId,
    questions: qs,
    answer: null,
  };
  state.transcript.push(entry);
  if (toolUseId) state.pendingAsks.set(toolUseId, entry);
  return entry;
}

function handleWsMessage(msg) {
  // Subagent stream interleaves with the parent. Claude --print stream-json emits every
  // assistant/tool_use/tool_result the parent process sees — including ones generated by
  // a Task subagent running in-process — distinguished by isSidechain=true (and an
  // agentId/parent_tool_use_id envelope marker). Subagent activity already feeds the
  // agents sheet via the hook server's agent_activity events on the notifications WS;
  // letting these also flow into state.transcript was duplicating every subagent tool
  // call in the parent view.
  if (msg.isSidechain === true || msg.parent_tool_use_id || msg.parentToolUseId || msg.agent_id || msg.agentId) return;
  // First non-error message proves the spawn succeeded — drop the pending-new-session
  // marker so a daemon_error landing LATER (e.g. claude proc exits) doesn't bounce the
  // user back to the picker.
  if (msg.type !== 'daemon_error' && state.pendingNewSession && state.pendingNewSession.id === state.currentSessionId) {
    state.pendingNewSession = null;
  }
  // Session WS only carries session-scoped events. Approvals flow through the notification
  // WS so they reach every view (list, current session, other session).
  if (msg.type === 'assistant') {
    const msgId = msg.message?.id;
    const blocks = msg.message?.content ?? [];
    // Block-level dedup. Each block has its own identity so re-deliveries (claude
    // emits one assistant line per content_block_stop, so a 12-tool turn arrives as 12
    // separate lines under the same msg_id) and WS replay buffer redeliveries are both
    // handled correctly. Thinking blocks pass through unrendered.
    let processed = false;
    for (const b of blocks) {
      if (b.type === 'text') {
        const sig = `${msgId}|${b.text}`;
        if (state.seenBlockSigs.has(sig)) continue;
        state.seenBlockSigs.add(sig);
        state.transcript.push({ role: 'assistant', text: b.text, msgId });
        processed = true;
      } else if (b.type === 'tool_use') {
        if (b.id && state.seenBlockSigs.has(b.id)) continue;
        if (b.id) state.seenBlockSigs.add(b.id);
        // Task* tools feed the todos panel instead of the transcript. Other tools render
        // as opaque tool_use entries the same way as before.
        if (b.name && TASK_TOOL_NAMES.has(b.name)) {
          applyTaskUse(b.name, b.input, b.id);
          processed = true;
          continue;
        }
        // AskUserQuestion becomes an inline Q&A card. The notification WS may have
        // already seeded the tile (via the approval payload) — if so this just attaches
        // the tool_use_id and msgId. Otherwise it pushes fresh.
        if (b.name === 'AskUserQuestion') {
          ensureAskInlineTile({ toolInput: b.input, msgId, toolUseId: b.id });
          processed = true;
          continue;
        }
        // Parent-side Agent invocations: capture their description so we can show it
        // in the agents sheet later. The hook stream only gives us agent_id +
        // agent_type for a subagent's tools — not the description from the parent's
        // Agent call — so we squirrel away that metadata here and bind it when a
        // matching subagent first appears (addSubagentEntry handles the bind).
        if (b.name === 'Agent' && b.input && typeof b.input === 'object') {
          recordParentAgentInvocation({
            toolUseId: b.id,
            subagentType: b.input.subagent_type,
            description: b.input.description,
          });
        }
        // Carry structured fields so toolUseHtml() can render a tool-specific summary on
        // both live and disk-replayed paths. The fallback `text` stays for unknown tools
        // and any edge case where toolInput is missing.
        state.transcript.push({
          role: 'tool_use',
          text: `${b.name}(${JSON.stringify(b.input).slice(0, 200)})`,
          toolName: b.name,
          toolInput: b.input,
          ...(b.id ? { toolUseId: b.id } : {}),
          msgId,
        });
        // If the auto-expand notification raced ahead of this tool_use block, the
        // signature is sitting in pendingExpand — drain it so the entry renders expanded
        // on first paint instead of waiting for some later trigger.
        applyPendingExpand(b.name, b.input, b.id);
        // Track the call as in-flight so the thinking strip's verb reflects what claude
        // is currently doing ("reading…" / "grepping…" / etc.). The matching tool_result
        // below pops it. Tools absorbed earlier (Task/Ask) `continue` before this point,
        // so they don't pollute the activity stack.
        if (b.id) {
          state.activeTools.push({ toolUseId: b.id, toolName: b.name });
          // New active tool — clear any verb that was lingering from the previous one.
          if (state.lingeringTimer) clearTimeout(state.lingeringTimer);
          state.lingeringVerb = null;
          state.lingeringTimer = null;
        }
        // Auto-expansion is driven by the explicit `tool_auto_allowed` notification (or
        // by accept-edits' client-side mirror) — not by tool_use arrival. The session WS
        // and notification WS race, so deciding here would expand user-approved calls
        // whenever the tool_use block beat the approval click.
        processed = true;
      }
    }
    if (!processed) return; // thinking-only delivery — wait for the real content
    // Record the assistant turn's usage for the context-window meter. cache_read and
    // cache_create tokens count against the window even though only input/output bill —
    // we sum all four. The model id can shift mid-session (Opus → Sonnet on /model
    // switch), so we re-lookup the window size on every payload.
    recordUsage(msg.message?.usage, msg.message?.model);
    // Don't stop thinking on first content block. Claude emits one `assistant` line per
    // content_block_stop, so a tool-using turn produces several `assistant` envelopes
    // before the response is actually done — flipping the caret off on the first one
    // also stopped the token counter from seeing message_delta usage updates (where the
    // cumulative output_tokens lives, not on message_start).
    //
    // The persistent thinking strip stays visible across tool calls, so we only stop
    // when the assistant is genuinely done: any terminal stop_reason except 'tool_use'.
    // tool_use means more turns are coming after the tool_results land; end_turn /
    // max_tokens / stop_sequence / refusal all mean "done." Unknown future reasons fall
    // through to stopping (safer than thinking-forever).
    const reason = msg.message?.stop_reason;
    if (reason && reason !== 'tool_use') stopThinking();
    renderSession();
  } else if (msg.type === 'stream_event') {
    // Claude's --include-partial-messages stream emits Anthropic streaming events
    // (message_start, content_block_delta, message_delta, message_stop). We use two
    // signals here:
    //   1. message_delta carries the authoritative stop_reason for the just-finished
    //      assistant turn (per Anthropic streaming API). Stop thinking when it's
    //      anything-but-tool_use — that's the canonical end-of-response signal.
    //   2. usage.output_tokens for the live "412 tok" counter.
    // message_stop is intentionally NOT used to stop thinking — it fires at the end of
    // EVERY assistant turn, including tool-using ones, which would hide the persistent
    // thinking strip the moment a tool was called.
    const ev = msg.event ?? msg;
    const deltaReason = ev?.delta?.stop_reason;
    if (deltaReason && deltaReason !== 'tool_use') {
      stopThinking();
      renderSession();
    }
    if (!state.thinking) return;
    // Authoritative usage (message_start / message_delta) — overwrites any estimate.
    const usage = ev?.usage ?? ev?.message?.usage;
    const out = usage?.output_tokens;
    if (typeof out === 'number') {
      state.thinkingOutputTokens = Math.max(state.thinkingOutputTokens, out);
      updateThinkingMeta();
    }
    // Live estimation from content_block_delta. Anthropic's stream only emits one
    // message_delta per message (with the FINAL count), so the only way to make the
    // counter climb during generation is to estimate from the delta payloads as they
    // come in. ~4 chars/token is a decent approximation across English + code.
    if (ev?.type === 'content_block_delta') {
      const d = ev?.delta;
      let added = 0;
      if (d?.type === 'text_delta' && typeof d.text === 'string') added = d.text.length;
      else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') added = d.partial_json.length;
      else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') added = d.thinking.length;
      if (added > 0) {
        state.thinkingOutputChars += added;
        const estimated = Math.ceil(state.thinkingOutputChars / 4);
        if (estimated > state.thinkingOutputTokens) {
          state.thinkingOutputTokens = estimated;
          updateThinkingMeta();
        }
      }
    }
  } else if (msg.type === 'user') {
    // Claude's own feedback to itself. Two shapes:
    //   1. string content — a synthetic user message Claude Code injects. The one we
    //      care about is <task-notification>…</task-notification>, fired when a subagent
    //      (or backgrounded Bash task) finishes. We parse it and stamp the completion
    //      onto the matching agent's bucket in state.subagents so the agent feed gets
    //      a "Completed" tile instead of a wall of XML in the parent transcript.
    //   2. array content with tool_result blocks — handled below for Task/Ask pairers.
    const content = msg.message?.content;
    if (typeof content === 'string') {
      if (content.trimStart().startsWith('<task-notification>')) {
        if (applyTaskNotification(content)) renderSession();
      }
      return;
    }
    const blocks = content;
    if (!Array.isArray(blocks)) return;
    let touched = false;
    for (const b of blocks) {
      if (b?.type !== 'tool_result') continue;
      const useId = b.tool_use_id;
      if (!useId) continue;
      // Pop the matching in-flight entry off the activity stack — the thinking strip's
      // verb will fall back to the next-most-recent active tool, or to a lingering
      // verb (then "thinking…") if nothing else is in flight. Setting touched ensures
      // we re-render so the verb updates even for tool_results that aren't otherwise
      // consumed (Read, Grep, etc.).
      const idx = state.activeTools.findIndex((t) => t.toolUseId === useId);
      if (idx >= 0) {
        const popped = state.activeTools[idx];
        state.activeTools.splice(idx, 1);
        // If the stack just went empty, hold the verb on screen long enough to read.
        // A subsequent push clears the lingering state immediately (see tool_use path).
        if (state.activeTools.length === 0 && TOOL_VERBS[popped.toolName]) {
          state.lingeringVerb = TOOL_VERBS[popped.toolName];
          if (state.lingeringTimer) clearTimeout(state.lingeringTimer);
          state.lingeringTimer = setTimeout(() => {
            state.lingeringVerb = null;
            state.lingeringTimer = null;
            if (state.view === 'session') updateThinkingRegion();
          }, VERB_LINGER_MS);
        }
        touched = true;
      }
      const innerBlocks = Array.isArray(b.content) ? b.content : null;
      const text = typeof b.content === 'string'
        ? b.content
        : innerBlocks
          ? innerBlocks.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
          : '';
      // Agent completion (sync style): the tool_result text contains an "agentId: <hex>"
      // line that identifies the subagent that just finished. Stream-JSON doesn't expose
      // the JSONL's `toolUseResult` sidecar, so the regex on text is the only signal we
      // have. The first text block (before the "agentId:" metadata) is the agent's reply
      // — use it as the completion summary. Async-style completions (<task-notification>
      // string content) are handled earlier in the function and never reach this branch.
      const agentMatch = /agentId:\s*([a-f0-9]+)/i.exec(text);
      if (agentMatch) {
        const agentId = agentMatch[1];
        const bucket = state.subagents.get(agentId);
        if (bucket && !bucket.completion) {
          let summary = null;
          if (innerBlocks) {
            for (const inner of innerBlocks) {
              if (inner?.type === 'text' && typeof inner.text === 'string' && !inner.text.startsWith('agentId:')) {
                summary = inner.text.trim();
                break;
              }
            }
          }
          bucket.completion = {
            status: 'completed',
            summary,
            result: null,
            completedAt: Date.now(),
          };
          touched = true;
        }
      }
      // Route to whichever pending pairer holds this id. Each id only sits in one set
      // at a time (Task creates and Ask uses are distinct), so the first match wins.
      if (state.pendingCreates.has(useId)) {
        applyTaskResult(useId, text);
        touched = true;
      } else if (state.pendingAsks.has(useId)) {
        const entry = state.pendingAsks.get(useId);
        entry.answer = text;
        state.pendingAsks.delete(useId);
        // Mirror the disk-replay path: record absorption so catchUpFromDisk skips this
        // tool_result on subsequent reconnects.
        state.consumedTaskResults.add(useId);
        touched = true;
      }
    }
    if (touched) renderSession();
  } else if (msg.type === 'daemon_error') {
    // If this error landed on a brand-new session before any successful messages, bounce
    // the user back to the picker so they can correct the path. Otherwise the user lands
    // in an empty session view with a "cwd does not exist" tile and no clear next step.
    if (state.pendingNewSession && state.pendingNewSession.id === state.currentSessionId) {
      const failedCwd = state.pendingNewSession.cwd;
      state.pendingNewSession = null;
      leaveSession();
      openCwdPickerSheet({ message: msg.message, failedCwd });
      return;
    }
    state.transcript.push({ role: 'error', text: msg.message });
    stopThinking();
    renderSession();
  } else if (msg.type === 'daemon_proc_exit') {
    state.transcript.push({
      role: 'error',
      text: `Session subprocess exited (code ${msg.code}).`,
      action: 'reopen',
    });
    stopThinking();
    renderSession();
  } else if (msg.type === 'approval_mode') {
    // If the client had an optimistically-set non-default mode (chosen before the session
    // opened and therefore never sent to the server), push it now so the server catches up.
    // This handles the accept-edits test pattern: user enables accept-edits in settings
    // BEFORE opening a session, then the server attach broadcasts 'ask' which would otherwise
    // clobber the local preference.
    // The approvalModePushBackSent sentinel prevents an infinite loop: if the server keeps
    // broadcasting a mode we don't want, we only push back once per WS attach.
    if (state.approvalMode !== 'ask' && state.approvalMode !== msg.mode
        && state.ws?.readyState === WebSocket.OPEN
        && !state.approvalModePushBackSent) {
      state.approvalModePushBackSent = true;
      state.ws.send(JSON.stringify({ type: 'approval_mode_set', mode: state.approvalMode }));
      // Keep local state and wait for the server's echo from our approval_mode_set.
      return;
    }
    state.approvalMode = msg.mode;
    state.approvalModePushBackSent = false;
    state.bypassConfirmPending = false;
    // Keep accept-edits client-side mirror in sync when the server says we're in that mode.
    setAcceptEdits(msg.mode === 'accept-edits');
    renderApprovalModes();
  }
}

function handleNotificationMessage(msg) {
  if (msg.type === 'notifications_snapshot') {
    state.pendingApprovals = Array.isArray(msg.approvals) ? msg.approvals : [];
    // Snapshot fires on cold start + reconnect. Re-apply the auto-expand for high-detail
    // tools so a refreshed PWA shows the payload upfront just like a freshly-arrived card.
    for (const a of state.pendingApprovals) {
      if (isHighDetailTool(a.toolName)) state.expandedTools.add(`approval-${a.approvalId}`);
    }
    // Re-apply pending approvals to subagent buckets without wiping existing state.
    // Completed agents and resolved-entry history live in state.subagents permanently
    // for the session (we hydrate disk history via /api/sessions/:id/subagents on
    // openSession), so a reconnect should be additive: addSubagentEntry will dedupe
    // pending entries by approvalId and create buckets only for agents we hadn't yet
    // heard about. Without this, every reconnect dropped completed agents and resolved
    // entries on the floor.
    for (const a of state.pendingApprovals) {
      if (a.sessionId !== state.currentSessionId) continue;
      if (a.agentId) {
        addSubagentEntry(a);
      } else if (a.toolName === 'AskUserQuestion') {
        ensureAskInlineTile({ toolInput: a.toolInput });
      }
    }
    if (state.view === 'list') renderList();
    else if (state.view === 'session') renderSession();
    return;
  }
  if (msg.type === 'agent_activity') {
    // Auto-allowed subagent tool call. Daemon emits this in addition to (well, instead
    // of) approval_pending when the allowlist short-circuits — populates the agent
    // feed for read-only subagents that would otherwise run invisibly.
    if (msg.sessionId !== state.currentSessionId) return;
    addSubagentEntry({
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      agentId: msg.agentId,
      agentType: msg.agentType,
      decision: 'allow',
    });
    if (state.view === 'session') renderSession();
    else if (state.view === 'list') renderList();
    return;
  }
  if (msg.type === 'tool_auto_allowed') {
    // Parent-side tool the daemon's allowlist auto-allowed — surface it as expanded in
    // the transcript so the user sees what ran without their input. The hook can fire
    // before or after the assistant content_block_stop emits the tool_use; either order
    // works because expandToolByContent matches now if possible and queues if not.
    if (isHighDetailTool(msg.toolName) && msg.sessionId === state.currentSessionId) {
      expandToolByContent(msg.toolName, msg.toolInput, msg.sessionId);
      if (state.view === 'session') renderSession();
    }
    return;
  }
  if (msg.type === 'approval_pending') {
    if (state.pendingApprovals.some((a) => a.approvalId === msg.approvalId)) return;
    // High-detail tools (Bash + edit family) open expanded so the user can see what's
    // about to run before tapping Approve. Pre-seed expandedTools with the synthetic
    // `approval-<id>` key approvalCardHtml uses; toolUseHtml's existing tap-to-toggle
    // logic then lets the user collapse it if they want.
    if (isHighDetailTool(msg.toolName)) state.expandedTools.add(`approval-${msg.approvalId}`);
    // Accept-edits mode: file edits never surface as a card. We send the decision
    // straight to the WS without pushing onto pendingApprovals — but for subagents we
    // DO mirror the entry into the agents sheet (already resolved as 'allow') so the
    // user can audit what was auto-written without scrolling the parent transcript.
    // The header chip's auto-edits counter also increments here.
    if (state.acceptEdits && EDIT_TOOLS.has(msg.toolName)) {
      // Send the auto-decide on the notifications WS, which is the channel that survives
      // iOS backgrounding (and is the one that just delivered the approval_pending). Falling
      // back to the session WS would re-introduce the silent-drop bug where a backgrounded
      // session-WS close caused the hook to time out after 10 minutes with a denied edit.
      sendApprovalDecide({ approvalId: msg.approvalId, decision: 'allow' });
      if (msg.sessionId === state.currentSessionId) {
        state.autoAllowedEdits += 1;
        if (msg.agentId) {
          // Subagent edit: addSubagentEntry handles expand-by-default for high-detail.
          addSubagentEntry({ ...msg, decision: 'allow' });
        } else {
          // Parent edit: expand by content match. PreToolUse and the assistant's
          // content_block_stop race — if the tool_use is already in state.transcript,
          // this expands it now; if not, the signature is queued for applyPendingExpand
          // to consume when the tool_use lands.
          expandToolByContent(msg.toolName, msg.toolInput, msg.sessionId);
        }
        if (state.view === 'session') renderSession();
      }
      return;
    }
    state.pendingApprovals.push(msg);
    // Subagent approvals route to their own feed, not the parent inline cards. Sheet
    // refreshes if open. No cross-session toast — subagents always run nested under a
    // session the user is already in.
    if (msg.agentId && msg.sessionId === state.currentSessionId) {
      const wasNew = !state.subagents.has(msg.agentId);
      addSubagentEntry(msg);
      // Approval-pending arrivals bump the agent to the front of the tab rail so the
      // user can find it without scrolling. wasNew=true already inserted at end; we
      // still want it at the front since it's demanding immediate attention.
      bringAgentToFront(msg.agentId);
      // Auto-switch: if the user is currently viewing an idle agent (no pendings),
      // snap to the agent that just woke up. If they're actively approving in some
      // other tab (it has pendings), don't yank their context.
      const cur = state.activeAgentId ? state.subagents.get(state.activeAgentId) : null;
      const curHasPending = cur ? cur.entries.some((e) => e.decision === null) : false;
      if (!curHasPending) state.activeAgentId = msg.agentId;
      if (state.view === 'session') renderSession();
      else if (state.view === 'list') renderList();
      // Mark wasNew unused — only kept for future use if we want to distinguish
      // first-pending vs nth-pending behavior; tab front-bump applies to both.
      void wasNew;
      return;
    }
    if (msg.toolName === 'AskUserQuestion' && msg.sessionId === state.currentSessionId) {
      ensureAskInlineTile({ toolInput: msg.toolInput });
    }
    if (state.view === 'session' && msg.sessionId === state.currentSessionId) {
      renderSession();
    } else {
      if (state.view === 'list') renderList();
      showApprovalToast(msg);
    }
  }
  // Server-driven resolution event — fires for both user decisions (from another device
  // viewing the same session) and the server-side timeout. Mirrors the decision onto local
  // state so cards disappear cleanly, and renders a "Timed out" tile when the server
  // expired an approval we hadn't acted on.
  if (msg.type === 'approval_resolved') {
    const wasPending = state.pendingApprovals.some((a) => a.approvalId === msg.approvalId);
    state.pendingApprovals = state.pendingApprovals.filter((a) => a.approvalId !== msg.approvalId);
    // Mirror onto the subagent bucket entry if this approval lived there — flips its
    // renderer from approval-card chrome to a resolved tool tile (rejected styling for
    // deny/timeout). Without this, the agents sheet would still show the card as pending.
    for (const [, bucket] of state.subagents) {
      for (const e of bucket.entries) {
        if (e.approvalId === msg.approvalId && e.decision === null) {
          e.decision = msg.decision;
          if (msg.timedOut) e.timedOut = true;
        }
      }
    }
    // Push a "Timed out" tile into the transcript only when the user was actually waiting
    // on the card (it was in pendingApprovals on this device). User decisions and subagent
    // resolutions are silent — the card flip is signal enough.
    if (msg.timedOut && wasPending && msg.sessionId === state.currentSessionId && !msg.agentId) {
      state.transcript.push({
        role: 'error',
        text: `${msg.toolName} approval timed out after 10 minutes — re-prompt to retry.`,
      });
    }
    if (state.view === 'session' && msg.sessionId === state.currentSessionId) renderSession();
    else if (state.view === 'list') renderList();
  }
}

// Parse a <task-notification> XML blob and stamp the completion onto its agent's
// bucket. Claude Code emits one of these as a synthetic user message whenever a
// subagent (or backgrounded Bash task) finishes — the <task-id> matches our agent_id,
// so we can correlate cleanly. Completed agents stay in state.subagents so they
// remain in the tab list (visually demoted to a "completed" section) — they aren't
// deleted. Returns true if a bucket was updated.
function applyTaskNotification(text) {
  const get = (tag) => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  const taskId = get('task-id');
  if (!taskId) return false;
  // task-id can be either an agent_id (long hex) or a background Bash task id. Only
  // agent_id ones have a matching bucket; Bash background notifications are no-ops here.
  const bucket = state.subagents.get(taskId);
  if (!bucket) return false;
  bucket.completion = {
    status: get('status') ?? 'completed',
    summary: get('summary') ?? null,
    result: get('result') ?? null,
    completedAt: Date.now(),
  };
  return true;
}

// Push (or no-op if already present) a subagent tool call into its bucket. Handles
// both shapes:
//   - Pending approval (a.approvalId set, a.decision unset) — from approval_pending
//   - Pre-resolved activity (a.toolUseId set, a.decision='allow') — from agent_activity
// Record a parent's Agent tool_use invocation so its description can be bound to the
// subagent's bucket. Bind is bidirectional because the parent's assistant stream and
// the subagent's hook stream arrive over two independent WebSockets — either can win
// the race. If a same-type bucket already exists without a description (the hook
// landed first), bind directly. Otherwise queue for the next subagent of this type
// (the hook will arrive later). Earliest-seen unbound bucket wins so parallel same-
// type dispatches bind in dispatch order.
function recordParentAgentInvocation({ toolUseId, subagentType, description }) {
  if (!description) return;
  // Claude Code's Agent tool defaults subagent_type to 'general-purpose' when the model
  // omits it (which it usually does — only specialized subagents like Explore / Plan get
  // an explicit type). Without this default, description-binding silently fails for the
  // common case and every general-purpose agent shows up as "general-purpose" in the
  // tab list instead of its description.
  const type = subagentType || 'general-purpose';
  let candidate = null;
  for (const [, b] of state.subagents) {
    if (b.agentType !== type) continue;
    if (b.description) continue;
    if (!candidate || b.firstSeenAt < candidate.firstSeenAt) candidate = b;
  }
  if (candidate) {
    candidate.description = description;
    return;
  }
  state.unboundAgentInvocations.push({
    toolUseId,
    subagentType: type,
    description,
    seenAt: Date.now(),
  });
}

// when the tool was auto-allowed by the allowlist before reaching the approval queue.
// Either id is fine for dedup; UUIDs and toolu_* IDs occupy disjoint namespaces.
function addSubagentEntry(a) {
  if (!a.agentId) return;
  let bucket = state.subagents.get(a.agentId);
  if (!bucket) {
    // Best-effort bind to the parent's Agent invocation by subagent_type. Pops the
    // first unbound invocation matching this agent_type — perfect for unique types,
    // a reasonable guess for parallel same-type spawns (the order they arrive is
    // typically the order they were issued).
    let description = null;
    const idx = state.unboundAgentInvocations.findIndex(
      (inv) => inv.subagentType === a.agentType,
    );
    if (idx >= 0) {
      description = state.unboundAgentInvocations[idx].description ?? null;
      state.unboundAgentInvocations.splice(idx, 1);
    }
    bucket = {
      agentType: a.agentType || 'agent',
      description,
      firstSeenAt: a.enqueuedAt || Date.now(),
      entries: [],
      completion: null,
    };
    state.subagents.set(a.agentId, bucket);
    // New agents land at the END of the tab rail; only approval_pending arrivals
    // bump to the FRONT (see bringAgentToFront callers). Default active tab only
    // gets set if nothing else is selected — explicit user/auto switches override.
    if (!state.agentTabOrder.includes(a.agentId)) state.agentTabOrder.push(a.agentId);
    if (!state.activeAgentId) state.activeAgentId = a.agentId;
  }
  const id = a.approvalId || a.toolUseId;
  if (!id) return;
  if (bucket.entries.some((e) => (e.approvalId || e.toolUseId) === id)) return;
  bucket.entries.push({
    approvalId: a.approvalId ?? null,
    toolUseId: a.toolUseId ?? null,
    toolName: a.toolName,
    toolInput: a.toolInput,
    decision: a.decision ?? null,
    enqueuedAt: a.enqueuedAt || Date.now(),
  });
  // Default-expand rules in the agent feed mirror the parent transcript:
  //   - Pending high-detail approvals open expanded so the user can see the payload.
  //   - Pre-resolved (allowlist auto-allowed via agent_activity or accept-edits mirror)
  //     high-detail entries open expanded so unsupervised activity is visible at a glance.
  // User-approved entries flip their decision in place via approval_resolved and never
  // re-enter addSubagentEntry, so they stay collapsed.
  if (isHighDetailTool(a.toolName)) {
    if (a.decision === null && a.approvalId) {
      state.expandedTools.add(`approval-${a.approvalId}`);
    } else if (a.decision === 'allow' && a.toolUseId) {
      state.expandedTools.add(a.toolUseId);
    }
  }
}

// Merge disk-replayed subagents into state.subagents. Disk entries are historical
// (all auto-resolved as 'allow' from our perspective — the subagent only writes to
// disk after a tool call ran, which means it was either auto-allowed or the user
// approved it). They prepend any in-memory pending entries that the snapshot
// rehydration already added during openSession, so the feed reads top-to-bottom in
// time order. If a bucket already exists (rare — the snapshot rebuild beat us to
// it), we splice disk entries in front of its existing entries without re-adding any
// that match an existing toolUseId.
function applyDiskSubagents(subagents) {
  if (!Array.isArray(subagents)) return;
  for (const s of subagents) {
    if (!s || !s.agentId) continue;
    const existing = state.subagents.get(s.agentId);
    const diskEntries = (s.entries || [])
      .filter((m) => m && m.role === 'tool_use' && m.toolName)
      .map((m) => ({
        approvalId: null,
        toolUseId: m.toolUseId ?? null,
        toolName: m.toolName,
        toolInput: m.toolInput,
        decision: 'allow',
        enqueuedAt: 0,
      }));
    if (existing) {
      const seenIds = new Set(existing.entries.map((e) => e.toolUseId).filter(Boolean));
      const prepend = diskEntries.filter((e) => !e.toolUseId || !seenIds.has(e.toolUseId));
      existing.entries = [...prepend, ...existing.entries];
      if (!existing.description && s.description) existing.description = s.description;
      if (s.completion && !existing.completion) existing.completion = s.completion;
      if (s.firstSeenAt && (!existing.firstSeenAt || s.firstSeenAt < existing.firstSeenAt)) {
        existing.firstSeenAt = s.firstSeenAt;
      }
    } else {
      state.subagents.set(s.agentId, {
        agentType: s.agentType || 'agent',
        description: s.description ?? null,
        firstSeenAt: s.firstSeenAt || Date.now(),
        entries: diskEntries,
        completion: s.completion ?? null,
      });
      if (!state.agentTabOrder.includes(s.agentId)) state.agentTabOrder.push(s.agentId);
    }
  }
  if (!state.activeAgentId) {
    // Prefer the first agent that's still running so the user lands on something live
    // instead of a stale completed agent if there are any active.
    const running = state.agentTabOrder.find((id) => {
      const b = state.subagents.get(id);
      return b && !b.completion;
    });
    state.activeAgentId = running || state.agentTabOrder[0] || null;
  }
}

// Move an agent_id to the front of the tab rail. Called when a new pending approval
// arrives for that agent — pending agents are always leftmost without us live-sorting
// on every decision (which previously made approved-and-done agents slide right
// mid-tap).
function bringAgentToFront(agentId) {
  state.agentTabOrder = [agentId, ...state.agentTabOrder.filter((id) => id !== agentId)];
}

// Session view is a stable skeleton (transcript + region wrappers + composer) built once
// per entry into the session view, plus per-region innerHTML swaps on subsequent updates.
// WHY: WS messages fire many renderSession() calls per response. The old code did
// root.innerHTML = … which rebuilt the composer node every time — on mobile that drops
// keyboard focus and wipes whatever the user was mid-typing. Keeping the composer mounted
// across updates is the fix.
function renderSession() {
  if (!document.getElementById('composer')) buildSessionSkeleton();
  // Sample stuck-to-bottom BEFORE rebuilding the transcript. Same 80px tolerance the
  // agents sheet uses (refreshAgentsSheet) for finger overshoot / sub-pixel rounding.
  // Without this, every WS message yanks the viewport down even if the user was scrolled
  // up reading history.
  const t = document.getElementById('transcript');
  const wasAtBottom = !t || (t.scrollHeight - t.scrollTop - t.clientHeight) < 80;
  updateTranscriptRegion();
  updateThinkingRegion();
  updateAgentsRegion();
  updateTodosRegion();
  updateBannerRegion();
  updateMeterRegion();
  updateSlashPalette();
  refreshAgentsSheet();
  refreshTodosSheet();
  ensureAskSheet();
  if (wasAtBottom) scrollTranscriptBottom();
}

// Record an assistant turn's usage payload. Stamps state.lastUsage and re-derives the
// context-window size from the model id. Tolerates a missing usage block (the
// content_block_stop envelopes that aren't message_start/_delta carry no usage — the
// message_start delivery seeds the values, later deltas refine the output_tokens count).
function recordUsage(usage, model) {
  if (!usage) return;
  state.lastUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    model: model ?? state.lastUsage?.model ?? null,
  };
  if (model) state.contextWindow = lookupContextWindow(model);
}

// Render the context-window meter above the composer. Hidden until the first assistant
// turn lands a usage payload. The bar uses three threshold colours: green <60%, amber
// 60–80%, red >80% — mirroring the on-disk pricing tiers but more importantly giving the
// user a clear "you're about to be force-compacted" warning before claude triggers its
// own internal compaction.
function updateMeterRegion() {
  const region = document.getElementById('meter-region');
  if (!region) return;
  const u = state.lastUsage;
  if (!u) { region.innerHTML = ''; return; }
  const used = u.inputTokens + u.outputTokens + u.cacheCreate + u.cacheRead;
  const total = state.contextWindow || CONTEXT_WINDOWS._default;
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  let tier = 'ok';
  if (pct >= 80) tier = 'danger';
  else if (pct >= 60) tier = 'warn';
  const breakdown = state.meterBreakdownOpen
    ? `<div class="meter-breakdown">
        <div><span>Input</span><span>${fmtNumber(u.inputTokens)}</span></div>
        <div><span>Cache read</span><span>${fmtNumber(u.cacheRead)}</span></div>
        <div><span>Cache create</span><span>${fmtNumber(u.cacheCreate)}</span></div>
        <div><span>Output</span><span>${fmtNumber(u.outputTokens)}</span></div>
        ${u.model ? `<div class="meter-model"><span>Model</span><span>${escapeHtml(u.model)}</span></div>` : ''}
      </div>`
    : '';
  region.innerHTML = `
    <button class="meter" id="meter" data-tier="${tier}" aria-expanded="${state.meterBreakdownOpen ? 'true' : 'false'}"
            aria-label="Context window: ${fmtNumber(used)} of ${fmtNumber(total)} tokens used, ${Math.round(pct)} percent">
      <span class="meter-text">${fmtNumber(used)} / ${fmtNumber(total)} tokens (${Math.round(pct)}%)</span>
      <span class="meter-bar"><span class="meter-fill" style="width:${pct}%"></span></span>
    </button>
    ${breakdown}
  `;
  const btn = document.getElementById('meter');
  if (btn) btn.onclick = () => {
    state.meterBreakdownOpen = !state.meterBreakdownOpen;
    updateMeterRegion();
  };
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// Open-state for the slash command palette is derived directly from the composer's text:
// any time the trimmed contents start with `/`, the palette is open and the filter is
// whatever comes after the slash. evaluatePaletteState() runs on every composer input
// event; deleting the leading `/` (or focusing away) naturally closes the palette.
function evaluatePaletteState() {
  const composer = document.getElementById('composer');
  if (!composer) return;
  const text = composer.textContent || '';
  const trimmed = text.trimStart();
  const open = trimmed.startsWith('/');
  if (!open) {
    if (state.paletteOpen) {
      state.paletteOpen = false;
      state.paletteFilter = '';
      state.paletteHighlight = 0;
      updateSlashPalette();
    }
    return;
  }
  // Strip the leading slash + any leading whitespace before it. We allow whitespace before
  // the slash so an indented quote-paste still triggers the palette (the spec's "at the
  // start of the input (or with only whitespace before it)" rule).
  const filter = trimmed.slice(1).split(/\s/)[0] ?? '';
  const wasOpen = state.paletteOpen;
  const prevFilter = state.paletteFilter;
  state.paletteOpen = true;
  state.paletteFilter = filter;
  if (!wasOpen || prevFilter !== filter) state.paletteHighlight = 0;
  updateSlashPalette();
}

// Filter the discovered list by fuzzy-match on the command name (sans leading slash).
// "Fuzzy" here is the simple subsequence form — every char in the filter must appear, in
// order, in the candidate. Matches that start with the filter prefix are sorted ahead of
// later-position matches so typing `/inv` puts `/investigate-cscu` above any incidental
// matches in unrelated names.
function filteredSlashCommands() {
  const f = state.paletteFilter.toLowerCase();
  if (!f) return state.slashCommands.slice(0, 50);
  const scored = [];
  for (const c of state.slashCommands) {
    const name = c.name.slice(1).toLowerCase(); // drop the `/`
    if (name.startsWith(f)) { scored.push({ c, rank: 0, pos: 0 }); continue; }
    // Subsequence: every char of f appears in name in order.
    let i = 0, pos = -1;
    for (let j = 0; j < name.length && i < f.length; j++) {
      if (name[j] === f[i]) { if (pos < 0) pos = j; i++; }
    }
    if (i === f.length) scored.push({ c, rank: 1, pos });
  }
  scored.sort((a, b) => a.rank - b.rank || a.pos - b.pos || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, 50).map((s) => s.c);
}

function updateSlashPalette() {
  const region = document.getElementById('slash-palette');
  if (!region) return;
  if (!state.paletteOpen) {
    region.hidden = true;
    region.innerHTML = '';
    return;
  }
  const items = filteredSlashCommands();
  if (items.length === 0) {
    region.hidden = false;
    region.innerHTML = `<div class="slash-empty">No matches</div>`;
    return;
  }
  const high = Math.min(state.paletteHighlight, items.length - 1);
  state.paletteHighlight = high;
  region.hidden = false;
  region.innerHTML = `
    <ul class="slash-list" role="listbox" aria-label="Slash commands">
      ${items.map((c, i) => `
        <li role="option" class="slash-item${i === high ? ' slash-item-highlight' : ''}" data-cmd="${escapeHtml(c.name)}" aria-selected="${i === high ? 'true' : 'false'}">
          <span class="slash-name">${escapeHtml(c.name)}</span>
          ${c.description ? `<span class="slash-desc">${escapeHtml(c.description)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
  for (const li of region.querySelectorAll('.slash-item')) {
    li.addEventListener('click', (e) => {
      e.preventDefault();
      insertSlashCommand(li.dataset.cmd);
    });
  }
}

function insertSlashCommand(cmd) {
  const composer = document.getElementById('composer');
  if (!composer) return;
  // Insert the command followed by a trailing space so the user can start typing args
  // immediately. Filling the field via textContent (rather than execCommand) keeps the
  // contenteditable in a clean state — no half-formed text node residue from the slash
  // the user typed.
  composer.textContent = `${cmd} `;
  state.paletteOpen = false;
  state.paletteFilter = '';
  state.paletteHighlight = 0;
  // Move the cursor to the end so the next keystroke lands after the command.
  placeCursorAtEnd(composer);
  composer.focus();
  document.getElementById('send')?.classList.toggle('armed', composer.textContent.trim().length > 0);
  updateSlashPalette();
}

function placeCursorAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function buildSessionSkeleton() {
  root.innerHTML = `
    <div class="transcript" id="transcript"></div>
    <div id="thinking-region"></div>
    <div id="agents-region"></div>
    <div id="todos-region"></div>
    <div id="banner-region"></div>
    <div class="composer-wrap">
      <div id="slash-palette" class="slash-palette" hidden></div>
      <div id="meter-region"></div>
      <div class="composer">
        <div class="field" id="composer" contenteditable="true"
             role="textbox" aria-multiline="true" aria-label="Message"
             autocapitalize="sentences"
             data-placeholder="Type a message…"></div>
        <button class="send" id="send" aria-label="Send">↵</button>
      </div>
    </div>
  `;
  const composer = document.getElementById('composer');
  const send = document.getElementById('send');
  const armSend = () => {
    send.classList.toggle('armed', composer.textContent.trim().length > 0);
  };
  composer.addEventListener('input', () => {
    armSend();
    evaluatePaletteState();
  });
  composer.addEventListener('keydown', (e) => {
    // Slash-palette keyboard handling on desktop (mouse/keyboard devices). Arrow keys
    // cycle through the filtered list; Enter inserts the highlighted match. Escape
    // closes the palette without inserting. Touch devices fall through to tap-only.
    if (state.paletteOpen) {
      const items = filteredSlashCommands();
      if (e.key === 'ArrowDown' && items.length > 0) {
        e.preventDefault();
        state.paletteHighlight = (state.paletteHighlight + 1) % items.length;
        updateSlashPalette();
        return;
      }
      if (e.key === 'ArrowUp' && items.length > 0) {
        e.preventDefault();
        state.paletteHighlight = (state.paletteHighlight - 1 + items.length) % items.length;
        updateSlashPalette();
        return;
      }
      if (e.key === 'Enter' && items.length > 0 && !window.matchMedia('(hover: none)').matches) {
        e.preventDefault();
        insertSlashCommand(items[state.paletteHighlight].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        state.paletteOpen = false;
        updateSlashPalette();
        return;
      }
    }
    // Desktop: Enter sends, Shift+Enter inserts a newline.
    // Touch devices: Enter always inserts a newline — users send via the on-screen button,
    // so an on-screen keyboard's Return key shouldn't fire off a half-typed message.
    if (window.matchMedia('(hover: none)').matches) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  send.onclick = () => {
    // While the assistant is generating, the same button is a stop button. Branch on
    // state.thinking so a single touch target carries both meanings — saves a slot in
    // the composer row and matches how every other modern chat client works.
    if (state.thinking) {
      interruptSession();
    } else {
      sendMessage();
    }
  };
}

// Outside-tap closes the slash palette. Attached once at module load — re-attaching from
// buildSessionSkeleton would leak a fresh listener every time the user re-enters the
// session view, and the listener cheaply no-ops when the palette is closed.
document.addEventListener('pointerdown', (e) => {
  if (!state.paletteOpen) return;
  const target = e.target;
  if (!(target instanceof Node)) return;
  if (document.getElementById('slash-palette')?.contains(target)) return;
  if (document.getElementById('composer')?.contains(target)) return;
  state.paletteOpen = false;
  updateSlashPalette();
}, true);

// Tell the daemon to SIGINT the claude subprocess. The daemon's existing
// daemon_proc_exit path then surfaces a Reopen tile in the transcript; tapping it
// resumes the session from disk via claude --resume, so the user can continue from
// wherever the interrupt cut things off.
function interruptSession() {
  if (state.ws?.readyState !== WebSocket.OPEN) {
    showStatusToast('Disconnected — try again');
    return;
  }
  state.ws.send(JSON.stringify({ type: 'interrupt' }));
  // Optimistic UI: the strip will keep showing 'thinking' until daemon_proc_exit lands,
  // but that's brief — claude exits within a couple hundred ms of SIGINT. No need to
  // pre-emptively flip state.thinking; let the real signal drive it.
}

function updateTranscriptRegion() {
  const loading = state.transcriptLoading
    ? `<div class="empty-state">Loading history…</div>`
    : '';
  const empty = !state.transcriptLoading && state.transcript.length === 0 && !state.thinking
    ? `<div class="empty-state">No messages yet — say something.</div>`
    : '';
  // Approval cards are scoped to the current session only; cross-session approvals live
  // in state.pendingApprovals too but surface as toasts, not inline cards.
  // Excluded from inline rendering:
  //   - AskUserQuestion (gets its own popup via ensureAskSheet)
  //   - any approval with an agentId (routed to the agents sheet instead, so subagent
  //     hooks don't dump 30 tool calls per minute into the parent feed)
  const cards = state.pendingApprovals.filter((a) =>
    a.sessionId === state.currentSessionId
    && a.toolName !== 'AskUserQuestion'
    && !a.agentId
  );
  const transcript = document.getElementById('transcript');
  transcript.innerHTML = `
    ${loading}
    ${empty}
    ${state.transcript.map((m, i, arr) => msgHtml(m, i === arr.length - 1)).join('')}
    ${cards.map((a) => approvalCardHtml(a)).join('')}
  `;
  bindTranscriptHandlers();
}

function updateThinkingRegion() {
  const region = document.getElementById('thinking-region');
  if (!region) return;
  region.innerHTML = thinkingStripHtml();
  // The send button doubles as a stop button while the assistant is generating —
  // synced here because thinking-state transitions all flow through this region's
  // updates (every startThinking/stopThinking eventually triggers a renderSession).
  const send = document.getElementById('send');
  if (send) {
    if (state.thinking) {
      send.classList.add('is-stop');
      send.setAttribute('aria-label', 'Stop');
      send.textContent = '■';
    } else {
      send.classList.remove('is-stop');
      send.setAttribute('aria-label', 'Send');
      send.textContent = '↵';
    }
  }
}

function bindTranscriptHandlers() {
  // Inline action buttons inside error tiles — currently just 'reopen' (subprocess exit).
  // Spawn a fresh subprocess on the same session id so the user keeps the transcript.
  for (const btn of document.querySelectorAll('.msg-action[data-msg-action="reopen"]')) {
    btn.addEventListener('click', () => {
      const id = state.currentSessionId;
      if (id) openSession(id);
    });
  }
  // stopPropagation: the approval card is itself a .tool_use-expandable tile, so a tap
  // anywhere on it (including the action buttons) would otherwise also toggle the
  // expanded JSON/diff view. Buttons own their own click semantics — they shouldn't
  // also be triggering the expand-collapse mechanic.
  for (const btn of document.querySelectorAll('.approval-card .approve')) {
    btn.onclick = (e) => { e.stopPropagation(); decideApproval(btn.dataset.id, 'allow'); };
  }
  for (const btn of document.querySelectorAll('.approval-card .reject')) {
    btn.onclick = (e) => { e.stopPropagation(); decideApproval(btn.dataset.id, 'deny'); };
  }
  for (const btn of document.querySelectorAll('.approval-card .approval-always')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.alwaysId;
      const approval = state.pendingApprovals.find((a) => a.approvalId === id);
      if (approval) alwaysAllowAndApprove(id, approval.toolName, approval.toolInput);
    };
  }
  for (const btn of document.querySelectorAll('.approval-card .suggestion-confirm')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const card = btn.closest('.approval-suggestion');
      const approvalId = card?.dataset.approvalId;
      const pending = state.pendingApprovals.find((a) => a.approvalId === approvalId);
      if (!pending?.suggestion) return;
      const scopeChoice = card.querySelector('.suggestion-scope-select')?.value ?? 'project';
      const sessionId = pending.sessionId;
      const project = (state.projects || []).find((p) => (p.sessions || []).some((s) => s.id === sessionId));
      const sessionProjectCwd = project?.cwd
        ?? (sessionId === state.currentSessionId ? state.currentSessionCwd : null);
      const scope = scopeChoice === 'global' ? 'global' : (sessionProjectCwd ? { project: sessionProjectCwd } : 'global');
      const body = { kind: pending.suggestion.kind, value: pending.suggestion.suggestedValue, scope };
      btn.disabled = true;
      fetch('/api/allowlist/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => {
        if (!r.ok) throw new Error(`POST failed: ${r.status}`);
        sendApprovalDecide({ approvalId, decision: 'allow' });
      }).catch((err) => {
        console.error('promotion failed', err);
        btn.disabled = false;
        if (typeof showStatusToast === 'function') showStatusToast('Promotion failed — try again');
      });
    };
  }
  // Tap-to-expand for tool_use entries. Toggle is done in-place (class flip + state Set
  // update) instead of via a full re-render, so the transcript doesn't jump and any text
  // the user is selecting inside the JSON block survives the interaction.
  for (const el of document.querySelectorAll('.msg.tool_use-expandable')) {
    el.addEventListener('click', (e) => {
      // Don't toggle if the user is selecting text — most likely they're trying to copy
      // a path, URL, or chunk of JSON. Selection.toString() is empty for a plain click.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0 && el.contains(sel.anchorNode)) return;
      const id = el.dataset.toolId;
      if (!id) return;
      const open = el.classList.toggle('tool_use-expanded');
      if (open) state.expandedTools.add(id); else state.expandedTools.delete(id);
      // If we just expanded near the bottom, the new JSON might land below the viewport.
      // Nudge it into view so the user sees the result of their tap.
      if (open) {
        requestAnimationFrame(() => {
          const rect = el.getBoundingClientRect();
          const transcript = document.getElementById('transcript');
          if (transcript && rect.bottom > transcript.getBoundingClientRect().bottom) {
            el.scrollIntoView({ block: 'end', behavior: 'smooth' });
          }
        });
      }
    });
  }
  // Pending ask cards in the transcript are tap-to-reopen — the popup sheet may have been
  // dismissed, but the underlying approval is still waiting. ensureAskSheet finds the
  // pending Ask for the current session and brings the sheet back up.
  for (const el of document.querySelectorAll('.msg.ask.ask-pending')) {
    el.addEventListener('click', (e) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0 && el.contains(sel.anchorNode)) return;
      ensureAskSheet();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ensureAskSheet();
      }
    });
  }
}

function updateAgentsRegion() {
  const region = document.getElementById('agents-region');
  region.innerHTML = agentsStripHtml();
  const btn = document.getElementById('agents-strip');
  if (btn) btn.onclick = openAgentsSheet;
}

function updateTodosRegion() {
  const region = document.getElementById('todos-region');
  region.innerHTML = todosPanelHtml();
  const btn = document.getElementById('todos-panel');
  if (btn) btn.onclick = openTodosSheet;
}

function updateBannerRegion() {
  const region = document.getElementById('banner-region');
  region.innerHTML = state.connState === 'failed'
    ? `<div class="conn-banner" role="alert">
        <span class="conn-banner-msg">Daemon unreachable — check Tailscale</span>
        <button type="button" id="conn-banner-retry">Retry</button>
      </div>`
    : '';
  document.getElementById('conn-banner-retry')?.addEventListener('click', forceReconnect);
}

// ─────────────────────── Agents strip + sheet ───────────────────────
// Subagent tool calls (Explore / general-purpose / code-architect / etc.) flow through
// the hook system with agent_id set. We route them out of the parent transcript and into
// a dedicated tabbed sheet — one tab per agent, content per tab reads as a mini-
// transcript (pending approvals + already-decided tool tiles, chronological).
//
// The strip in the main layout is the always-visible entry point: a compact one-liner
// showing agent + pending counts, with an accent pulse when approvals are waiting.

function agentsStripHtml() {
  if (state.subagents.size === 0) return '';
  const agents = [...state.subagents.values()];
  // "Active" = anything without a completion stamp. Completed agents still show up in
  // the sheet (in the bottom "Done" group), but the strip headline counts only what's
  // running so the user has a clean signal of in-flight work without the count
  // ballooning across the session.
  const activeCount = agents.filter((b) => !b.completion).length;
  const pending = agents.reduce(
    (n, b) => n + b.entries.filter((e) => e.decision === null).length,
    0,
  );
  const pendingHtml = pending > 0
    ? `<span class="agents-strip-pending"><span class="agents-strip-pulse" aria-hidden="true"></span>${escapeHtml(String(pending))} pending</span>`
    : '';
  return `
    <button class="agents-strip${pending > 0 ? ' agents-strip-attention' : ''}" type="button" id="agents-strip" aria-label="Open agent activity">
      <span class="agents-strip-label">Agents</span>
      <span class="agents-strip-sep" aria-hidden="true">·</span>
      <span class="agents-strip-count">${escapeHtml(String(activeCount))} Active</span>
      ${pendingHtml}
      <span class="agents-strip-expand" aria-hidden="true">↗</span>
    </button>
  `;
}

function openAgentsSheet() {
  dismissSoftKeyboard();
  closeAgentsSheet();
  // Selection priority on open:
  //   1. Topmost agent with pending approvals (needs user action).
  //   2. If the last-viewed agent has since completed AND any agent is still active,
  //      switch to the topmost active one — landing on a stale completed agent when
  //      live work is happening is disorienting.
  //   3. Otherwise keep the last-viewed agent.
  const topPending = state.agentTabOrder.find((id) => {
    const b = state.subagents.get(id);
    return b && b.entries.some((e) => e.decision === null);
  });
  if (topPending) {
    state.activeAgentId = topPending;
  } else {
    const cur = state.activeAgentId ? state.subagents.get(state.activeAgentId) : null;
    const curCompleted = cur && cur.completion;
    if (curCompleted) {
      const topActive = state.agentTabOrder.find((id) => {
        const b = state.subagents.get(id);
        return b && !b.completion;
      });
      if (topActive) state.activeAgentId = topActive;
    }
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop agents-sheet-backdrop';
  backdrop.id = 'agents-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet agents-sheet';
  sheet.id = 'agents-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Subagent activity');
  sheet.innerHTML = agentsSheetBodyHtml();
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  pinSheetBelowHeader(sheet, { fillVertical: true });
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  backdrop.onclick = closeAgentsSheet;
  wireAgentsSheetHandlers(sheet);
  makeSheetDismissible(sheet, closeAgentsSheet);
  noteSheetOpen();
  // Land on the latest entries when the sheet first opens. After this, the
  // sticky-bottom heuristic in refreshAgentsSheet decides whether to follow
  // newly-arriving entries based on whether the user has scrolled up.
  const feed = sheet.querySelector('.agents-sheet-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

// Refresh rebuilds the sheet's innerHTML to pick up new entries/decisions. Without
// the scroll preservation below, the tab rail snaps to scrollLeft=0 on every refresh
// (lost off-screen tabs) and the feed snaps to scrollTop=0 (yanks the approval button
// out from under your finger mid-tap).
//
// Feed scroll uses a sticky-bottom strategy: if the user was already at/near the
// bottom of the feed before refresh, pin them to the new bottom afterward (so an
// arriving entry stays in view). If they had scrolled UP to read history, preserve
// the exact scrollTop so we don't yank them. Tab rail scroll is always preserved.
// `resetFeedScroll` is the explicit reset path (tab switches show a different agent's
// history, so previous scrollTop is meaningless).
function refreshAgentsSheet(opts) {
  const sheet = document.getElementById('agents-sheet');
  if (!sheet) return;
  const resetFeedScroll = opts?.resetFeedScroll === true;
  const resetTabsScroll = opts?.resetTabsScroll === true;
  const oldTabs = sheet.querySelector('.agents-tabs');
  const oldFeed = sheet.querySelector('.agents-sheet-feed');
  const tabsScrollTop = oldTabs?.scrollTop ?? 0;
  const feedScrollTop = oldFeed?.scrollTop ?? 0;
  // Treat "within 80px of bottom" as stuck-to-bottom — same fudge factor chat apps
  // use to absorb a few pixels of finger overshoot or browser sub-pixel rounding.
  const wasAtBottom = oldFeed
    ? (oldFeed.scrollHeight - oldFeed.scrollTop - oldFeed.clientHeight) < 80
    : true;

  sheet.innerHTML = agentsSheetBodyHtml();
  wireAgentsSheetHandlers(sheet);
  // innerHTML rebuild discarded the old grabber node, so re-attach the dismiss
  // gesture handlers to the fresh one.
  makeSheetDismissible(sheet, closeAgentsSheet);

  // Preserve the tab-list scroll position on refresh, EXCEPT when the caller explicitly
  // requests a reset (clicking a pending agent — that row should already be at the
  // top of the list, so snapping there is a no-op visually but keeps the user oriented
  // when their tap moved the selection to a different group). Without preservation,
  // every refresh — including ones triggered by background events — would yank the
  // scroll back to the top mid-read.
  const newTabs = sheet.querySelector('.agents-tabs');
  if (newTabs) {
    newTabs.scrollTop = resetTabsScroll ? 0 : tabsScrollTop;
    // Toggle the bottom-edge fade hint based on whether the tab list actually overflows.
    newTabs.classList.toggle('agents-tabs-overflow', newTabs.scrollHeight > newTabs.clientHeight + 1);
  }
  const newFeed = sheet.querySelector('.agents-sheet-feed');
  if (newFeed) {
    if (resetFeedScroll || wasAtBottom) {
      newFeed.scrollTop = newFeed.scrollHeight;
    } else {
      newFeed.scrollTop = feedScrollTop;
    }
  }
}

function closeAgentsSheet() {
  const backdrop = document.getElementById('agents-sheet-backdrop');
  const sheet = document.getElementById('agents-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => {
    backdrop?.remove();
    sheet?.remove();
  }, 380);
}

// Refcount the number of open sheets and toggle a body class while any are open.
// CSS targets that class to lock the underlying scroll containers (transcript /
// #root) so touch-drags on the sheet's non-scrollable regions can't leak through
// to the page beneath. Use a counter rather than a boolean because two sheets can
// briefly overlap (e.g., the ask popup arriving while the agents sheet is up).
let _openSheetCount = 0;
function noteSheetOpen() {
  _openSheetCount += 1;
  document.body.classList.add('sheet-open');
}
function noteSheetClose() {
  _openSheetCount = Math.max(0, _openSheetCount - 1);
  if (_openSheetCount === 0) document.body.classList.remove('sheet-open');
}

// Cap a sheet's vertical extent so it never grows tall enough to cover the page
// header. Two modes:
//   - default: set max-height so the sheet sizes naturally to its content but stops
//     at the header's bottom. Used by todos / ask / settings — they're often shorter
//     than the available space and shouldn't push to the top when they don't need to.
//   - fillVertical: set top: <header.bottom> so the sheet pins to that line regardless
//     of content height. Used by the agents sheet, where we want fixed dimensions so
//     swapping between agents with different feeds doesn't change the sheet's outer
//     size — only the inner feed scrolls.
// Re-measure the header on every call: safe-area insets shift between portrait /
// landscape and the keyboard can move the header on iOS.
// Blur the focused element if it's something that triggers the soft keyboard. Called
// before opening a sheet so iOS Safari closes the keyboard first — otherwise the visual
// viewport stays shrunk and pinSheetBelowHeader sees a header that's been pushed off
// the top of the visible area.
function dismissSoftKeyboard() {
  const el = document.activeElement;
  if (!el || el === document.body) return;
  const tag = el.tagName;
  const editable = el.getAttribute && el.getAttribute('contenteditable') === 'true';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) el.blur();
}

function pinSheetBelowHeader(sheet, opts) {
  if (!sheet) return;
  const header = document.getElementById('header');
  if (!header) return;
  // When the soft keyboard is closing (callers blur via dismissSoftKeyboard) the visual
  // viewport hasn't yet returned to full height, and getBoundingClientRect().bottom can
  // be near zero or negative — pinning to that would cover the header. Fall back to the
  // header's stable layout height in that case; once the keyboard finishes its close
  // animation, re-pin against the live rect for an exact fit.
  const rectBottom = Math.round(header.getBoundingClientRect().bottom);
  const top = rectBottom > 0 ? rectBottom : header.offsetHeight;
  if (opts && opts.fillVertical) {
    sheet.style.top = `${top}px`;
    sheet.style.maxHeight = '';
  } else {
    sheet.style.maxHeight = `calc(100dvh - ${top}px)`;
    sheet.style.top = '';
  }
  // If the visual viewport is currently shorter than the layout viewport, the soft
  // keyboard is still up or animating closed. Re-pin once it settles so the sheet's top
  // matches the real post-keyboard header position rather than the offsetHeight
  // approximation above.
  const vv = window.visualViewport;
  if (vv && vv.height < window.innerHeight - 50 && !sheet._outpostRepinPending) {
    sheet._outpostRepinPending = true;
    const onResize = () => {
      if (vv.height >= window.innerHeight - 50) {
        vv.removeEventListener('resize', onResize);
        sheet._outpostRepinPending = false;
        if (document.body.contains(sheet)) pinSheetBelowHeader(sheet, opts);
      }
    };
    vv.addEventListener('resize', onResize);
    setTimeout(() => {
      vv.removeEventListener('resize', onResize);
      sheet._outpostRepinPending = false;
    }, 1000);
  }
}

// Wire drag-to-dismiss on a sheet's grabber. Re-callable: rebinding a fresh handle
// after a sheet's inner HTML is rebuilt (refreshAgentsSheet, etc.) is safe — we
// replace any prior _outpostDismissBound flag and let the old listeners drop with
// the discarded node. Dismiss fires either on a sufficient downward drag distance
// (~25% of viewport) or on a strong downward flick (so a quick swipe works even
// without crossing the distance threshold).
// Themed replacement for window.confirm() — opens a small bottom sheet matching the
// rest of the PWA chrome. Returns a Promise<boolean>: true for confirm, false for cancel
// or dismiss (backdrop tap, swipe-down, Escape key). One confirm sheet at a time; if
// another opens while one is up, the first resolves false.
function confirmInSheet({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const existing = document.getElementById('confirm-sheet');
    if (existing) existing.dispatchEvent(new CustomEvent('outpost-confirm-cancel'));

    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop confirm-sheet-backdrop';
    backdrop.id = 'confirm-sheet-backdrop';
    const sheet = document.createElement('aside');
    sheet.className = 'sheet confirm-sheet';
    sheet.id = 'confirm-sheet';
    sheet.setAttribute('role', 'alertdialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', title);
    sheet.innerHTML = `
      <div class="grabber"></div>
      <div class="header-row">
        <span class="sheet-title">${escapeHtml(title)}</span>
        <button class="sheet-close" id="confirm-sheet-close" aria-label="Cancel">✕</button>
      </div>
      <div class="confirm-body">${escapeHtml(body)}</div>
      <div class="confirm-actions">
        <button class="cancel" type="button">Cancel</button>
        <button class="${danger ? 'confirm-danger' : 'confirm-primary'}" type="button">${escapeHtml(confirmLabel || 'Confirm')}</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      sheet.classList.add('open');
    });
    pinSheetBelowHeader(sheet);
    noteSheetOpen();

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('open');
      sheet.classList.remove('open');
      noteSheetClose();
      document.removeEventListener('keydown', onKey);
      setTimeout(() => {
        backdrop.remove();
        sheet.remove();
      }, 380);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);

    sheet.addEventListener('outpost-confirm-cancel', () => finish(false));
    backdrop.onclick = () => finish(false);
    sheet.querySelector('#confirm-sheet-close').onclick = () => finish(false);
    sheet.querySelector('.cancel').onclick = () => finish(false);
    sheet.querySelector('.confirm-danger, .confirm-primary').onclick = () => finish(true);
    makeSheetDismissible(sheet, () => finish(false));
  });
}

function makeSheetDismissible(sheetEl, closeFn) {
  if (!sheetEl) return;
  // Drag-handle region = grabber + the title header-row. A bigger target for the
  // common case where a thumb starts the gesture slightly below the visual bar. The
  // close button lives inside the header-row, so the down handler skips when the
  // touch lands on any interactive element — taps still work, drags initiated from
  // the title text or empty header space still dismiss.
  const handles = [...sheetEl.querySelectorAll(':scope > .grabber, :scope > .header-row')];
  if (handles.length === 0) return;
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let active = false;
  let activeHandle = null;
  const isInteractive = (target) =>
    !!target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]');
  const onDown = (e) => {
    if (isInteractive(e.target)) return;
    active = true;
    activeHandle = e.currentTarget;
    startY = e.clientY;
    lastY = startY;
    lastT = e.timeStamp;
    sheetEl.classList.add('sheet-dragging');
    try { activeHandle.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  };
  const onMove = (e) => {
    if (!active) return;
    const dy = Math.max(0, e.clientY - startY);
    sheetEl.style.transform = `translateY(${dy}px)`;
    lastY = e.clientY;
    lastT = e.timeStamp;
  };
  const onUp = (e) => {
    if (!active) return;
    active = false;
    sheetEl.classList.remove('sheet-dragging');
    sheetEl.style.transform = '';
    const dy = Math.max(0, e.clientY - startY);
    const dt = Math.max(1, e.timeStamp - lastT);
    const flickVelocity = (e.clientY - lastY) / dt; // px/ms, positive = downward
    const threshold = Math.min(window.innerHeight * 0.25, 220);
    if (dy > threshold || flickVelocity > 0.6) closeFn();
    try { activeHandle?.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    activeHandle = null;
  };
  for (const handle of handles) {
    if (handle._outpostDismissBound) continue;
    handle._outpostDismissBound = true;
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }
}

// Sheet body is rebuilt from scratch on every refresh — keeps tab state in sync with
// state.activeAgentId without having to diff DOM children. Tab + button handlers get
// re-wired by wireAgentsSheetHandlers below.
function agentsSheetBodyHtml() {
  // Stable display order: state.agentTabOrder drives the tab rail. Entries land at the
  // end on first sighting; approval_pending arrivals bump to front via
  // bringAgentToFront. After-decision shuffling stays disabled so the tabs don't
  // reorder out from under the user's finger.
  const agents = state.agentTabOrder
    .map((id) => [id, state.subagents.get(id)])
    .filter(([, b]) => b);
  if (agents.length === 0) {
    return `
      <div class="grabber"></div>
      <div class="header-row">
        <span class="sheet-title">Agents</span>
        <button class="sheet-close" id="agents-sheet-close" aria-label="Close">✕</button>
      </div>
      <div class="empty-state">No subagent activity yet.</div>
    `;
  }
  // Three-way partition so the user always sees what most needs attention at the top:
  //   1. pending  — active agents with at least one undecided approval card
  //   2. active   — running agents currently quiet (no pendings)
  //   3. completed — finished agents, sorted by completion time DESCENDING (newest at
  //                  the top of the completed section, oldest sinking to the bottom)
  // Within the pending and active groups we preserve the dispatch order encoded in
  // state.agentTabOrder so positions don't shuffle every time a tool finishes. The
  // pending vs active split itself happens here on every render, so the moment a new
  // approval lands the agent jumps to the top without needing a separate bump call.
  const pending = [];
  const active = [];
  const completed = [];
  for (const pair of agents) {
    if (pair[1].completion) {
      completed.push(pair);
    } else if (pair[1].entries.some((e) => e.decision === null)) {
      pending.push(pair);
    } else {
      active.push(pair);
    }
  }
  completed.sort((a, b) => (b[1].completion.completedAt || 0) - (a[1].completion.completedAt || 0));

  // Snap active tab onto a still-existing agent if the previously-active one is gone.
  // Land order: agents needing approval first, then running, then completed — same
  // priority as the rendered list so the default selection always matches what the
  // user's eye lands on at the top.
  let activeId = state.activeAgentId;
  const stillExists = agents.find(([id]) => id === activeId);
  if (!stillExists) {
    activeId = pending[0]?.[0] || active[0]?.[0] || completed[0]?.[0] || null;
    state.activeAgentId = activeId;
  }

  const runningCount = pending.length + active.length;
  const totalPending = pending.reduce(
    (sum, [, b]) => sum + b.entries.filter((e) => e.decision === null).length,
    0,
  );
  const summary = `${runningCount} active${completed.length ? ` · ${completed.length} done` : ''}${totalPending ? ` · ${totalPending} awaiting approval` : ''}`;

  const renderTab = ([id, b]) => {
    const pending = b.entries.filter((e) => e.decision === null).length;
    const isActive = id === activeId;
    const isCompleted = !!b.completion;
    const isKilled = isCompleted && b.completion.status === 'killed';
    const badge = pending > 0
      ? `<span class="agents-tab-badge">${escapeHtml(String(pending))}</span>`
      : '';
    // Description (from parent's Agent invocation, best-effort bound by subagent_type
    // when the bucket was created) IS the agent's identity — promote it to the primary
    // tab label so users can scan all parallel agents at once instead of tapping
    // through to read each one. Fall back to the agent type when no description is
    // bound. Meta line is just the 8-char hash so the row stays wide enough to show
    // the description even on narrow phone widths. Completed agents get a small glyph
    // (✓ / ✕) in front of the hash as the visual signal that they're done.
    const primary = b.description || b.agentType;
    const doneGlyph = isCompleted
      ? `<span class="agents-tab-done-glyph" aria-hidden="true">${isKilled ? '✕' : '✓'}</span>`
      : '';
    const classes = [
      'agents-tab',
      isActive ? 'active' : '',
      pending > 0 ? 'has-pending' : '',
      isCompleted ? 'completed' : '',
      isKilled ? 'killed' : '',
    ].filter(Boolean).join(' ');
    const tabId = `agents-tab-${escapeHtml(id)}`;
    return `
      <button class="${classes}" type="button" data-agent-id="${escapeHtml(id)}" role="tab"
              id="${tabId}" aria-controls="agents-sheet-feed" aria-selected="${isActive ? 'true' : 'false'}"
              tabindex="${isActive ? '0' : '-1'}">
        <span class="agents-tab-label">${escapeHtml(primary)}</span>
        <span class="agents-tab-meta">
          ${doneGlyph}
          <span class="agents-tab-id">${escapeHtml(id.slice(0, 8))}</span>
          ${badge}
        </span>
      </button>
    `;
  };

  const pendingTabs = pending.map(renderTab).join('');
  const activeTabs = active.map(renderTab).join('');
  const completedTabs = completed.map(renderTab).join('');
  // Only render a "Done" divider when there's both running activity above and finished
  // agents below it — a label with nothing above is just visual noise. We don't need a
  // divider between pending and active: the left-edge accent bar on pending tabs is the
  // visual signal that those rows need attention.
  const doneDivider = ((pending.length + active.length) > 0 && completed.length > 0)
    ? `<div class="agents-tabs-divider">Done</div>`
    : '';

  const activeBucket = activeId ? state.subagents.get(activeId) : null;
  const feed = activeBucket ? agentFeedHtml(activeBucket) : '';

  return `
    <div class="grabber"></div>
    <div class="header-row agents-sheet-header">
      <div class="agents-sheet-title-block">
        <span class="sheet-title">Agents</span>
        <span class="agents-sheet-summary">${escapeHtml(summary)}</span>
      </div>
      <button class="sheet-close" id="agents-sheet-close" aria-label="Close">✕</button>
    </div>
    <div class="agents-tabs" role="tablist" aria-label="Agents">${pendingTabs}${activeTabs}${doneDivider}${completedTabs}</div>
    <div class="agents-sheet-feed" id="agents-sheet-feed" role="tabpanel" tabindex="0"
         aria-labelledby="${activeId ? `agents-tab-${escapeHtml(activeId)}` : ''}">${feed}</div>
  `;
}

// One agent's feed = a mini-transcript. Pending entries render as full approval cards
// (the same chrome the parent feed uses for its own approvals); resolved entries
// transform into plain tool tiles, with a "rejected" wrapper-class on deny so the user
// can see "Claude wanted to do this and you said no." If the agent has finished, the
// completion tile (parsed from <task-notification>) gets appended after the entries
// as the visual "fin." marker — the user can scroll to it to see status + summary.
function agentFeedHtml(bucket) {
  // If the parent's Agent invocation handed this subagent a description, surface it as a
  // quoted header at the top of the feed so the user remembers what the agent was asked
  // to do without scrolling the parent transcript. Best-effort — for parallel same-type
  // spawns the binding can be approximate (see recordParentAgentInvocation).
  const prompt = bucket.description
    ? `<div class="agent-feed-prompt"><span class="agent-feed-prompt-label">Spawned by</span><div class="agent-feed-prompt-text">${escapeHtml(bucket.description)}</div></div>`
    : '';
  // The last entry is "active" only when the agent itself is still running — once a
  // completion tile drops in, the trailing Read line stops animating its ellipsis.
  const liveTail = !bucket.completion;
  const tiles = bucket.entries.map((entry, i, arr) => agentEntryHtml(entry, liveTail && i === arr.length - 1));
  if (bucket.completion) tiles.push(agentCompletionTileHtml(bucket.completion));
  if (tiles.length === 0 && !prompt) {
    return `<div class="empty-state">Waiting for activity…</div>`;
  }
  if (tiles.length === 0) {
    return `${prompt}<div class="empty-state">Waiting for activity…</div>`;
  }
  return `${prompt}${tiles.join('')}`;
}

// Footer tile shown once the subagent emits its <task-notification>. Mirrors the
// resolved-task style of other "this is done" affordances in the app (italic display
// label, mono metrics line). Status flips the chrome to danger when the task was
// killed instead of completing normally.
function agentCompletionTileHtml(c) {
  const isKilled = c.status === 'killed';
  const label = isKilled ? 'Stopped' : 'Completed';
  // Format the usage row: only include parts that are actually present in the payload.
  const parts = [];
  if (c.toolUses != null) parts.push(`${c.toolUses} tools`);
  if (c.totalTokens != null) parts.push(`${c.totalTokens.toLocaleString()} tokens`);
  if (c.durationMs != null) parts.push(formatDurationMs(c.durationMs));
  const stats = parts.length > 0
    ? `<div class="agent-complete-stats">${escapeHtml(parts.join(' · '))}</div>`
    : '';
  const summary = c.summary
    ? `<div class="agent-complete-summary">${escapeHtml(c.summary)}</div>`
    : '';
  return `
    <div class="agent-complete${isKilled ? ' agent-complete-killed' : ''}">
      <div class="agent-complete-label">${escapeHtml(label)}</div>
      ${stats}
      ${summary}
    </div>
  `;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, '0')}m`;
}

function agentEntryHtml(entry, isLast) {
  if (entry.decision === null) {
    return approvalCardHtml({
      approvalId: entry.approvalId,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      summary: '',
      enqueuedAt: entry.enqueuedAt,
    });
  }
  // Resolved Read entries render as the slim status line, never as a full tile —
  // matches how Reads render in the parent transcript.
  if (entry.toolName === 'Read') {
    return readLineHtml(entry.toolInput);
  }
  // Resolved: render as a plain tool tile. Reuse toolUseHtml by synthesizing a
  // transcript-message-shaped object. Prefer the real tool_use_id (auto-allowed
  // entries) and fall back to approvalId (entries that came through the approval
  // queue); either id is unique within its namespace and works for expand-state.
  const tileHtml = toolUseHtml({
    role: 'tool_use',
    text: `${entry.toolName}(${JSON.stringify(entry.toolInput).slice(0, 200)})`,
    toolName: entry.toolName,
    toolInput: entry.toolInput,
    toolUseId: entry.toolUseId || entry.approvalId,
  });
  if (entry.decision === 'deny') {
    const tag = entry.timedOut ? 'Timed out' : 'Rejected';
    return `<div class="agent-entry-rejected">${tileHtml}<span class="agent-entry-reject-tag">${tag}</span></div>`;
  }
  return tileHtml;
}

// Wire all interactive elements in the sheet. Re-called on every refresh because the
// inner HTML is rebuilt from scratch; the outer <aside> keeps its .open class so the
// slide-in transform isn't re-played.
function wireAgentsSheetHandlers(sheet) {
  const closeBtn = sheet.querySelector('#agents-sheet-close');
  if (closeBtn) closeBtn.onclick = closeAgentsSheet;
  for (const tab of sheet.querySelectorAll('.agents-tab')) {
    tab.onclick = () => {
      const id = tab.dataset.agentId;
      if (!id || id === state.activeAgentId) return;
      state.activeAgentId = id;
      // Tab switch: feed content swaps entirely, so the previous scrollTop is
      // meaningless. The tab list's vertical scroll stays where the user left it,
      // EXCEPT when switching to a pending-approval agent — those always sort to
      // the very top of the list, so we snap the list there to keep the freshly
      // selected row in view.
      const target = state.subagents.get(id);
      const targetHasPending = target?.entries.some((e) => e.decision === null) ?? false;
      refreshAgentsSheet({ resetFeedScroll: true, resetTabsScroll: targetHasPending });
    };
  }
  // Approval card buttons inside the agent feed. stopPropagation so they don't also
  // trigger the tool_use-expandable container's tap-to-expand handler beneath them.
  for (const btn of sheet.querySelectorAll('.approval-card .approve')) {
    btn.onclick = (e) => { e.stopPropagation(); decideApproval(btn.dataset.id, 'allow'); };
  }
  for (const btn of sheet.querySelectorAll('.approval-card .approval-always')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.alwaysId;
      // Subagent entries live in state.subagents buckets, not pendingApprovals — look
      // them up there so the suggested rule reflects the actual tool call.
      let approval = state.pendingApprovals.find((a) => a.approvalId === id);
      if (!approval) {
        for (const [, bucket] of state.subagents) {
          const entry = bucket.entries.find((e) => e.approvalId === id);
          if (entry) { approval = { toolName: entry.toolName, toolInput: entry.toolInput }; break; }
        }
      }
      if (approval) alwaysAllowAndApprove(id, approval.toolName, approval.toolInput);
    };
  }
  for (const btn of sheet.querySelectorAll('.approval-card .reject')) {
    btn.onclick = (e) => { e.stopPropagation(); decideApproval(btn.dataset.id, 'deny'); };
  }
  // Tap-to-expand for resolved tool tiles (and the approval-card containers, which
  // also expose the JSON/diff payload preview).
  for (const el of sheet.querySelectorAll('.msg.tool_use-expandable')) {
    el.addEventListener('click', (ev) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0 && el.contains(sel.anchorNode)) return;
      const id = el.dataset.toolId;
      if (!id) return;
      const open = el.classList.toggle('tool_use-expanded');
      if (open) state.expandedTools.add(id); else state.expandedTools.delete(id);
    });
  }
}

// ─────────────────────── AskUserQuestion sheet ───────────────────────
// When Claude calls AskUserQuestion, the hook intercepts it like any other approval. But
// instead of an Approve/Reject pair, we surface a dedicated sheet listing the question's
// options + a free-text reply field. Picking an option (or sending text) resolves the
// approval as `deny` with the user's answer as the reason — the daemon already plumbs
// `reason` through to `permissionDecisionReason`, which Claude sees as the tool's effective
// output. The hook returning deny + an answer-reason is what makes Claude treat this as
// "the user said X" rather than "the tool failed."

// Idempotent: opens the sheet for the current session's pending Ask if one exists, closes
// any stale sheet whose approval has been resolved, and leaves an already-correct sheet
// alone. Called from renderSession so the UI stays consistent with state.pendingApprovals.
function ensureAskSheet() {
  const ask = state.pendingApprovals.find((a) =>
    a.toolName === 'AskUserQuestion' && a.sessionId === state.currentSessionId
  );
  const existing = document.getElementById('ask-sheet');
  if (!ask) {
    if (existing) closeAskSheet();
    return;
  }
  if (existing && existing.dataset.approvalId === ask.approvalId) return;
  openAskSheet(ask);
}

function openAskSheet(approval) {
  closeAskSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop ask-sheet-backdrop';
  backdrop.id = 'ask-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet ask-sheet';
  sheet.id = 'ask-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Question from Claude');
  sheet.dataset.approvalId = approval.approvalId;
  sheet.innerHTML = askSheetBodyHtml(approval);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  pinSheetBelowHeader(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  makeSheetDismissible(sheet, closeAskSheet);
  noteSheetOpen();

  const questions = Array.isArray(approval.toolInput?.questions) ? approval.toolInput.questions : [];
  // Auto-submit on a single tap is only safe when there's exactly ONE single-select
  // question — with multiple questions the user still needs to answer the rest, and
  // the previous behavior (auto-submit on first tap) ate the unanswered ones.
  const autoSubmit = questions.length === 1 && !questions[0]?.multiSelect;

  const reply = sheet.querySelector('#ask-reply');
  const send = sheet.querySelector('#ask-send');
  const arm = () => {
    const hasReply = (reply?.value ?? '').trim().length > 0;
    const hasPick = sheet.querySelector('.ask-option.selected') != null;
    send?.classList.toggle('armed', hasReply || hasPick);
  };

  // Single-select: radio-button behavior within a question (selecting one option
  // deselects siblings in the same question). Auto-submits only when autoSubmit is on.
  for (const btn of sheet.querySelectorAll('.ask-option[data-single]')) {
    btn.onclick = () => {
      const qi = btn.dataset.qi;
      for (const sib of sheet.querySelectorAll(`.ask-option[data-qi="${qi}"][data-single]`)) {
        sib.classList.remove('selected');
      }
      btn.classList.add('selected');
      if (autoSubmit) {
        const oi = Number(btn.dataset.oi);
        submitAskAnswer(approval, [{ qi: Number(qi), choices: [oi] }], null);
      } else {
        arm();
      }
    };
  }
  // Multi-select: toggle accumulator. Always requires Send.
  for (const btn of sheet.querySelectorAll('.ask-option[data-multi]')) {
    btn.onclick = () => {
      btn.classList.toggle('selected');
      arm();
    };
  }

  // The "or reply" textarea — typing arms the Send button. Cmd/Ctrl+Enter sends.
  reply?.addEventListener('input', arm);
  reply?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send?.click();
    }
  });

  if (send) {
    send.onclick = () => {
      const text = (reply?.value ?? '').trim();
      // Collect selected options across ALL questions, single + multi alike. With
      // multiple questions, a single-tap leaves the option in .selected (no auto-submit)
      // so it shows up here too.
      const grouped = {};
      for (const el of sheet.querySelectorAll('.ask-option.selected')) {
        const qi = Number(el.dataset.qi);
        const oi = Number(el.dataset.oi);
        (grouped[qi] = grouped[qi] || []).push(oi);
      }
      const picks = Object.keys(grouped).map((qi) => ({ qi: Number(qi), choices: grouped[qi] }));
      if (picks.length === 0 && !text) return; // nothing to send
      submitAskAnswer(approval, picks, text || null);
    };
  }
  // Backdrop / close-button tap = put the sheet away without resolving the approval.
  // The inline transcript tile stays tap-to-reopen ('Tap to reply'), so the user can come
  // back. Previously this auto-denied with a "User dismissed" reason, which made the
  // inline tile a lie (the approval was already dead) and surprised users who expected
  // "dismiss the sheet" to mean "deal with it later".
  backdrop.onclick = () => { closeAskSheet(); };
  const close = sheet.querySelector('#ask-sheet-close');
  if (close) close.onclick = () => closeAskSheet();
}

function closeAskSheet() {
  const backdrop = document.getElementById('ask-sheet-backdrop');
  const sheet = document.getElementById('ask-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => {
    backdrop?.remove();
    sheet?.remove();
  }, 380);
}

// Compose the deny-reason text that Claude will see and send the decision back. Claude
// is told explicitly that this is a user answer (not a tool failure), with both the
// chosen options and any free-text reply concatenated into a single readable string.
function submitAskAnswer(approval, picks, replyText) {
  const questions = Array.isArray(approval.toolInput?.questions) ? approval.toolInput.questions : [];
  // Build (question, joined-answer) pairs once; the wire format and the inline-card
  // friendly format are both derived from these.
  const pairs = [];
  for (const { qi, choices } of picks) {
    const q = questions[qi];
    if (!q) continue;
    const opts = Array.isArray(q.options) ? q.options : [];
    const labels = choices.map((oi) => opts[oi]?.label).filter(Boolean);
    if (!labels.length) continue;
    pairs.push({ question: String(q.question ?? ''), answer: labels.join(', ') });
  }

  // Wire format = exactly what the native AskUserQuestion tool_result emits, so Claude
  // reads our hook-denial reason the same way it reads a successful tool call. Free-text
  // reply gets appended as a separate clause since the native format has no slot for it.
  // This same string is what we stash on the transcript entry — askMsgHtml feeds it back
  // through parseAskAnswer for display, so both the live-submit path and the disk-replay
  // tool_result path land on the exact same rendering logic.
  let wire = '';
  if (pairs.length > 0) {
    const quoted = pairs.map(({ question, answer }) => `"${question}"="${answer}"`).join(', ');
    wire = `Your questions have been answered: ${quoted}`;
  }
  if (replyText) {
    wire = wire ? `${wire}. User also added: ${replyText}` : `User replied: ${replyText}`;
  }
  if (!wire) wire = 'User dismissed the question without answering.';

  // Update the inline card immediately so the user sees their answer in the transcript
  // before the tool_result round-trips back through the WS stream. We scan transcript
  // (not just state.pendingAsks) because the notification-seeded tile may not have a
  // tool_use_id yet, so it's not in the pendingAsks map. Claude serializes Ask calls,
  // so we only flip the (single) unanswered one.
  for (const entry of state.transcript) {
    if (entry.role === 'ask' && entry.answer == null) {
      entry.answer = wire;
    }
  }
  state.pendingAsks.clear();
  decideApproval(approval.approvalId, 'deny', wire);
  closeAskSheet();
}

function askSheetBodyHtml(approval) {
  const questions = Array.isArray(approval.toolInput?.questions) ? approval.toolInput.questions : [];
  const blocks = questions.map((q, qi) => askQuestionBlockHtml(q, qi)).join('');
  // Send button is only meaningful when there's a multi-select question or the user is
  // typing a free-text reply. Single-select questions auto-submit on tap, so the user
  // doesn't need to hit Send unless they're using the textarea or composing a multi-pick.
  return `
    <div class="grabber"></div>
    <div class="header-row ask-sheet-header">
      <span class="sheet-title">Question</span>
      <button class="sheet-close" id="ask-sheet-close" aria-label="Dismiss question">✕</button>
    </div>
    <div class="ask-sheet-body">
      ${blocks}
      <div class="ask-reply-block">
        <div class="ask-section-label">or write a reply</div>
        <textarea id="ask-reply" class="ask-reply-field"
                  rows="3" autocapitalize="sentences"
                  placeholder="Type a custom answer…"></textarea>
      </div>
      <div class="ask-actions">
        <button class="ask-send" id="ask-send" type="button">Send →</button>
      </div>
    </div>
  `;
}

function askQuestionBlockHtml(q, qi) {
  if (!q || typeof q !== 'object') return '';
  const multi = !!q.multiSelect;
  const header = q.header ? `<div class="ask-q-header">${escapeHtml(String(q.header))}</div>` : '';
  const opts = Array.isArray(q.options) ? q.options : [];
  const optionsHtml = opts.map((opt, oi) => askOptionHtml(opt, qi, oi, multi)).join('');
  return `
    <section class="ask-question">
      ${header}
      <div class="ask-q-text">${escapeHtml(String(q.question ?? ''))}</div>
      <div class="ask-section-label">${escapeHtml(multi ? 'select any that apply' : 'choose one')}</div>
      <div class="ask-options">${optionsHtml}</div>
    </section>
  `;
}

function askOptionHtml(opt, qi, oi, multi) {
  const label = String(opt?.label ?? '');
  const desc = String(opt?.description ?? '');
  const mode = multi ? 'data-multi="1"' : 'data-single="1"';
  return `
    <button type="button" class="ask-option" data-qi="${escapeHtml(String(qi))}" data-oi="${escapeHtml(String(oi))}" ${mode}>
      <span class="ask-option-marker" aria-hidden="true"></span>
      <span class="ask-option-body">
        <span class="ask-option-label">${escapeHtml(label)}</span>
        ${desc ? `<span class="ask-option-desc">${escapeHtml(desc)}</span>` : ''}
      </span>
    </button>
  `;
}

// ─────────────────────── Edit / Bash special expansions ───────────────────────
// When the tool_use tile expands, the default expanded view is the raw pretty JSON. Edit
// and Bash override this with formats matched to how a human reads those tools: a unified
// diff for Edit, a $-prefixed shell-style command block for Bash.

// LCS-based line diff. O(m*n) memory, capped at 800x800 lines — beyond that we render the
// naive "all old removed / all new added" view, which is still readable for big chunks
// and avoids pinning the main thread on a large file replacement.
function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const m = a.length, n = b.length;
  const CAP = 800;
  if (m === 0 && n === 0) return [];
  if (m > CAP || n > CAP) {
    return [
      ...a.map((t) => ({ op: '-', text: t })),
      ...b.map((t) => ({ op: '+', text: t })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: a[i] }); i++; }
    else { out.push({ op: '+', text: b[j] }); j++; }
  }
  while (i < m) out.push({ op: '-', text: a[i++] });
  while (j < n) out.push({ op: '+', text: b[j++] });
  return out;
}

// Slim one-liner for Read tool calls. Replaces the standard tool tile because the input
// is shallow (file path + optional line range) and the user mostly wants a live signal
// that something's happening. Active when this is the most recent message in its feed —
// animates an ellipsis to indicate the read is in flight; once anything else lands after
// it the dots freeze and the verb switches to past tense.
function readLineHtml(input) {
  const path = projectRelativePath(String(input?.file_path ?? ''));
  const range = readRangeSuffix(input);
  // Single label "Read" in accent — the thinking strip already shows "Reading…" in
  // flight, so the transcript tile doesn't need to mirror that state.
  const rangeLine = range
    ? `<span class="read-range">${escapeHtml(range)}</span>`
    : '';
  return (
    `<div class="msg msg-read">` +
      `<span class="read-verb">Read</span>` +
      `<span class="read-target">${escapeHtml(path)}</span>` +
      rangeLine +
    `</div>`
  );
}

// Human-readable range subtitle for the read line ("lines 60-75" / "line 60+" /
// "pages 1-5"). Returns '' when no range info is present so the line just shows the
// bare path with no second-line subtitle.
function readRangeSuffix(input) {
  if (input?.pages) return `pages ${input.pages}`;
  const off = Number(input?.offset);
  if (!Number.isFinite(off) || off <= 0) return '';
  const lim = Number(input?.limit);
  if (Number.isFinite(lim) && lim > 0) return `lines ${off}-${off + lim - 1}`;
  return `line ${off}+`;
}

function renderEditDiff(input) {
  const oldStr = input?.old_string ?? '';
  const newStr = input?.new_string ?? '';
  const diff = diffLines(oldStr, newStr);
  // The filename + replace-all flag already live in the collapsed tile's label + summary
  // above; the diff doesn't need to repeat them in its own header bar.
  const rows = diff.map(({ op, text }) => {
    const cls = op === '+' ? 'diff-add' : op === '-' ? 'diff-del' : 'diff-eq';
    const prefix = op;
    // Render empty lines as a single non-breaking space so the row still has visible height
    // and the user can tell that a blank line is part of the diff.
    const body = text === '' ? ' ' : text;
    return `<div class="diff-line ${cls}"><span class="diff-mark">${escapeHtml(prefix)}</span><span class="diff-text">${escapeHtml(body)}</span></div>`;
  }).join('');
  return `<div class="tool-diff"><div class="diff-body">${rows}</div></div>`;
}

// Grep's input is structured (pattern, path, glob, type, flags, output_mode, context)
// and the most natural way to show it is the ripgrep command-line equivalent — same
// shell-style block we use for Bash. Anyone who's used grep/rg can read it at a glance.
function renderGrepSearch(input) {
  // Build the command in two halves so we can highlight the search pattern in
  // accent-2 — it's the one token that matters most and is otherwise hard to spot
  // amid the flags + paths.
  const prefix = ['rg'];
  if (input?.['-i']) prefix.push('-i');
  if (input?.['-n']) prefix.push('-n');
  if (input?.multiline) prefix.push('-U');
  if (input?.output_mode === 'files_with_matches') prefix.push('-l');
  else if (input?.output_mode === 'count') prefix.push('-c');
  if (input?.['-A'] != null) prefix.push(`-A ${input['-A']}`);
  if (input?.['-B'] != null) prefix.push(`-B ${input['-B']}`);
  if (input?.['-C'] != null) prefix.push(`-C ${input['-C']}`);
  if (input?.type) prefix.push(`--type ${shellQuote(String(input.type))}`);
  if (input?.glob) prefix.push(`-g ${shellQuote(String(input.glob))}`);
  const pattern = shellQuote(String(input?.pattern ?? ''));
  const suffix = [];
  if (input?.path) suffix.push(shellQuote(shortenPath(String(input.path))));
  let tail = suffix.length ? ` ${suffix.join(' ')}` : '';
  if (input?.head_limit) tail += ` | head -${input.head_limit}`;
  const cmdHtml =
    `${escapeHtml(prefix.join(' '))} ` +
    `<span class="bash-grep-pattern">${escapeHtml(pattern)}</span>` +
    `${escapeHtml(tail)}`;
  return `
    <div class="tool-bash">
      <div class="bash-cmd"><span class="bash-prompt">$</span><span class="bash-cmd-text">${cmdHtml}</span></div>
    </div>
  `;
}

// Minimal shell-style quoting. Safe-glob characters pass unquoted; anything else gets
// single-quoted (and falls back to double-quoting with escapes if the value contains a
// single quote). Tuned for readability over canonical correctness — the user is reading,
// not piping the output into bash.
function shellQuote(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./@%+=:,~-]+$/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function renderBashCommand(input) {
  const cmd = String(input?.command ?? '');
  const bg = input?.run_in_background ? '<span class="bash-flag">background</span>' : '';
  const timeout = input?.timeout
    ? `<span class="bash-flag">timeout ${escapeHtml(String(input.timeout))}ms</span>`
    : '';
  const flags = (bg || timeout) ? `<div class="bash-flags">${bg}${timeout}</div>` : '';
  // The description is already shown as the collapsed tile's summary above — no need
  // to repeat it as a comment line here. white-space: pre-wrap on .bash-cmd preserves
  // newlines and indentation in heredocs and multi-line scripts.
  return `
    <div class="tool-bash">
      <div class="bash-cmd"><span class="bash-prompt">$</span><span class="bash-cmd-text">${escapeHtml(cmd)}</span></div>
      ${flags}
    </div>
  `;
}

// Write's expanded view shows the actual file content with line numbers — the JSON dump
// is unreadable for any file of size (the entire content lands as a single escaped
// string). 500-line cap keeps a 10k-line generated file from locking the main thread; the
// rest reads as a footer note. Content is just escaped text rather than syntax-
// highlighted — matching the diff renderer, which is honest about being a payload preview.
function renderWriteContent(input) {
  const content = String(input?.content ?? '');
  const lines = content.split('\n');
  const MAX = 500;
  const visible = lines.slice(0, MAX);
  const overflow = lines.length - visible.length;
  const rows = visible.map((line, i) => {
    // Empty rows still need visible height so blank lines read correctly. A trailing
    // space is enough to give the row its line-height without disturbing wrapping.
    const text = line === '' ? ' ' : line;
    return `<div class="write-line"><span class="write-ln">${i + 1}</span><span class="write-text">${escapeHtml(text)}</span></div>`;
  }).join('');
  const overflowRow = overflow > 0
    ? `<div class="write-overflow">+ ${overflow.toLocaleString()} more lines</div>`
    : '';
  return `<div class="tool-write"><div class="write-body">${rows}${overflowRow}</div></div>`;
}

// Agent's `prompt` is the most interesting payload in the entire transcript — it's the
// brief Claude is handing to the subagent. Render it as markdown (using the existing
// renderMarkdown that already handles XSS-safety internally) so headings, lists, code
// blocks, etc. all read correctly. description/subagent_type stay in the collapsed
// label + summary above, so this view focuses purely on the prompt itself.
function renderAgentPrompt(input) {
  const prompt = String(input?.prompt ?? '');
  if (!prompt) return '';
  return `<div class="tool-agent"><div class="agent-prompt">${renderMarkdown(prompt)}</div></div>`;
}

// WebFetch's URL gets first-class treatment in the expanded view: a method tag + the URL
// as an actual <a> so the user can tap straight through to the resource. The prompt is
// usually a markdown brief telling Claude what to extract; render it as markdown below.
function renderWebFetch(input) {
  const url = String(input?.url ?? '');
  const prompt = String(input?.prompt ?? '');
  // Only allow http(s):// + relative URLs through to the anchor; anything else falls
  // back to plain text. Same conservative posture as the markdown link renderer.
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  const urlBlock = url
    ? safeUrl
      ? `<div class="webfetch-url"><span class="webfetch-method">GET</span><a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>`
      : `<div class="webfetch-url"><span class="webfetch-method">GET</span><span class="webfetch-url-text">${escapeHtml(url)}</span></div>`
    : '';
  const promptBlock = prompt
    ? `<div class="webfetch-prompt">${renderMarkdown(prompt)}</div>`
    : '';
  return `<div class="tool-webfetch">${urlBlock}${promptBlock}</div>`;
}

function refreshTodosSheet() {
  const sheet = document.getElementById('todos-sheet');
  if (!sheet) return;
  // Capture scroll + sticky-bottom intent BEFORE the innerHTML rebuild discards the old
  // body node. The .todos-sheet-body div is what scrolls; preserve its scrollTop so a
  // TaskUpdate landing while the user is reading the Completed section doesn't yank them
  // back to the top. Same sticky-bottom fudge factor (80px) the agents sheet uses.
  const oldBody = sheet.querySelector('.todos-sheet-body');
  const bodyScrollTop = oldBody?.scrollTop ?? 0;
  const wasAtBottom = oldBody
    ? (oldBody.scrollHeight - oldBody.scrollTop - oldBody.clientHeight) < 80
    : false;
  sheet.innerHTML = todosSheetBodyHtml();
  const close = sheet.querySelector('#todos-sheet-close');
  if (close) close.onclick = closeTodosSheet;
  // The innerHTML replace discarded the old grabber node — re-bind drag-to-dismiss on the
  // fresh one or the sheet becomes un-swipeable after the first TaskUpdate.
  makeSheetDismissible(sheet, closeTodosSheet);
  const newBody = sheet.querySelector('.todos-sheet-body');
  if (newBody) newBody.scrollTop = wasAtBottom ? newBody.scrollHeight : bodyScrollTop;
}

function msgHtml(m, isLast) {
  if (m.role === 'tool_use' && m.toolName === 'Read') {
    return readLineHtml(m.toolInput);
  }
  if (m.role === 'tool_use') return toolUseHtml(m);
  if (m.role === 'ask') return askMsgHtml(m);
  const labels = { user: 'You', assistant: 'Assistant', error: 'Error' };
  // Assistant messages get full markdown rendering. Everything else is plain text — user
  // messages shouldn't be parsed (they're as the user typed them), and error messages are
  // unstructured logs.
  const body = m.role === 'assistant' ? renderMarkdown(m.text) : escapeHtml(m.text);
  // Error messages can carry an inline action (currently only 'reopen' for the daemon
  // subprocess exit). The handler is wired by renderSession after the HTML is in the DOM.
  const action = m.action === 'reopen'
    ? `<button class="msg-action" type="button" data-msg-action="reopen">Reopen</button>`
    : '';
  return `<div class="msg ${escapeHtml(m.role)}"><span class="role">${escapeHtml(labels[m.role] ?? m.role)}</span><span class="body-text">${body}</span>${action}</div>`;
}

// Inline Q&A card. Each question is rendered with its paired answer right below it, so
// the reader's eye doesn't have to cross-reference a separate "you answered" block. A
// small header line shows the question count and whether the user has answered yet.
function askMsgHtml(m) {
  const questions = Array.isArray(m.questions) ? m.questions : [];
  const multi = questions.length > 1;
  const parsed = parseAskAnswer(m.answer, questions);
  const answered = parsed.answers.some((a) => a) || !!parsed.reply;

  const rows = questions.map((q, i) => {
    const qText = String(q?.question ?? '');
    const a = parsed.answers[i] || '';
    const num = multi
      ? `<span class="ask-msg-num">${String(i + 1).padStart(2, '0')}</span>`
      : '<span class="ask-msg-num ask-msg-num-spacer" aria-hidden="true"></span>';
    let answerEl;
    if (answered && a) {
      answerEl = `<div class="ask-msg-a"><span class="ask-msg-arrow" aria-hidden="true">↳</span><span class="ask-msg-a-text">${escapeHtml(a)}</span></div>`;
    } else if (answered) {
      answerEl = `<div class="ask-msg-a ask-msg-a-skipped"><span class="ask-msg-arrow" aria-hidden="true">↳</span><span class="ask-msg-a-text">no answer</span></div>`;
    } else {
      answerEl = `<div class="ask-msg-a ask-msg-a-pending"><span class="ask-msg-arrow" aria-hidden="true">↳</span><span class="ask-msg-a-text">waiting…</span></div>`;
    }
    return (
      `<div class="ask-msg-pair">` +
        num +
        `<div class="ask-msg-pair-body">` +
          `<div class="ask-msg-q-text">${escapeHtml(qText)}</div>` +
          answerEl +
        `</div>` +
      `</div>`
    );
  }).join('');

  const replyBlock = parsed.reply
    ? `<div class="ask-msg-reply"><div class="ask-msg-reply-label">Also added</div><div class="ask-msg-reply-text">${escapeHtml(parsed.reply)}</div></div>`
    : '';

  const countLabel = multi
    ? `Asked · ${questions.length} questions`
    : 'Asked';
  const statusBadge = answered ? 'Answered' : 'Pending';

  const replyHint = !answered
    ? `<div class="ask-msg-reply-hint" aria-hidden="true">Tap to reply <span class="ask-msg-reply-hint-arrow">→</span></div>`
    : '';

  return (
    `<div class="msg ask${answered ? ' ask-answered' : ' ask-pending'}"${answered ? '' : ' role="button" tabindex="0" aria-label="Reply to question"'}>` +
      `<div class="ask-msg-head">` +
        `<span class="ask-msg-label">${escapeHtml(countLabel)}</span>` +
        `<span class="ask-msg-status">${escapeHtml(statusBadge)}</span>` +
      `</div>` +
      `<div class="ask-msg-pairs">${rows}</div>` +
      replyBlock +
      replyHint +
    `</div>`
  );
}

// Parse the various shapes that end up in entry.answer back into structured pairs +
// optional free-text reply. The pairs are matched onto the original questions array by
// text, so what shows up in the card lines up with the question it actually answers.
//
// Recognized inputs:
//   1. Canonical wire format ("Your questions have been answered: \"Q\"=\"A\", …
//      [. User also added: …]"). Native AskUserQuestion + new submitAskAnswer.
//   2. Legacy prefix ("[AskUserQuestion answer]\n…"). Pre-canonical submitAskAnswer.
//      Inside it we still parse "Q: …\nA: …" pairs and "User reply: …" / "User chose: …".
//   3. Reply-only ("User replied: …"). Dismissed-via-text path.
//   4. Anything else — treat as a free-form reply.
function parseAskAnswer(answer, questions) {
  if (!answer) return { answers: new Array(questions.length).fill(''), reply: '' };
  const raw = String(answer).trim();

  const placeAnswers = (pairs) => {
    const out = new Array(questions.length).fill('');
    for (const { q, a } of pairs) {
      const idx = questions.findIndex((qq) => String(qq?.question ?? '') === q);
      if (idx >= 0) out[idx] = a;
      else if (questions.length === 1 && out[0] === '') out[0] = a;
    }
    return out;
  };

  const canonical = /^Your questions have been answered:\s*(.+?)(?:\.\s*User also added:\s*([\s\S]+))?$/.exec(raw);
  if (canonical) {
    const pairs = [];
    const re = /"([^"]*)"="([^"]*)"/g;
    let p;
    while ((p = re.exec(canonical[1])) !== null) pairs.push({ q: p[1], a: p[2] });
    return { answers: placeAnswers(pairs), reply: (canonical[2] ?? '').trim() };
  }

  const legacy = /^\[AskUserQuestion answer\]\s*\n?([\s\S]*)$/.exec(raw);
  if (legacy) {
    const body = legacy[1].trim();
    const blocks = body.split(/\n\s*\n/);
    const pairs = [];
    let reply = '';
    for (const block of blocks) {
      const trimmed = block.trim();
      const qa = /^Q:\s*([\s\S]+?)\nA:\s*([\s\S]+)$/.exec(trimmed);
      if (qa) { pairs.push({ q: qa[1].trim(), a: qa[2].trim() }); continue; }
      const chose = /^User chose:\s*([\s\S]+)$/.exec(trimmed);
      if (chose && questions.length === 1) {
        pairs.push({ q: String(questions[0]?.question ?? ''), a: chose[1].trim() });
        continue;
      }
      const rep = /^User repl(?:y|ied):\s*([\s\S]+)$/.exec(trimmed);
      if (rep) { reply = rep[1].trim(); continue; }
    }
    return { answers: placeAnswers(pairs), reply };
  }

  const replyOnly = /^User repl(?:y|ied):\s*([\s\S]+)$/.exec(raw);
  if (replyOnly) {
    return { answers: new Array(questions.length).fill(''), reply: replyOnly[1].trim() };
  }

  return { answers: new Array(questions.length).fill(''), reply: raw };
}

// Tool-use entries get their own layout: a tool-name label across the top, a one-line
// human summary (file path / command description / query / URL), an optional mono detail
// line, and a hidden-by-default pretty-printed JSON block. Tapping anywhere on the box
// flips the .tool_use-expanded class (wired in renderSession), which reveals the JSON —
// no re-render, so scroll position and selection survive. Every interpolated value is
// run through escapeHtml; the JSON highlighter operates on already-escaped text.
function toolUseHtml(m) {
  const f = formatToolUse(m.toolName, m.toolInput, m.text);
  const id = typeof m.toolUseId === 'string' ? m.toolUseId : '';
  // alwaysExpanded tools render their payload statically — no chevron, no tap-to-toggle.
  // Used for Grep where the structured rg-style block is the *primary* representation;
  // a summary + collapsed/expanded toggle would just hide the most useful view.
  const alwaysExpanded = !!f.alwaysExpanded;
  const hasPayload = m.toolInput !== undefined;
  const expandable = !alwaysExpanded && id && hasPayload;
  const expanded = alwaysExpanded || (expandable && state.expandedTools.has(id));
  const cls = `msg tool_use${expandable ? ' tool_use-expandable' : ''}${expanded ? ' tool_use-expanded' : ''}`;
  const idAttr = expandable ? ` data-tool-id="${escapeHtml(id)}"` : '';
  const chev = expandable ? `<span class="tool-chev" aria-hidden="true"></span>` : '';
  // Per-tool expanded views — replace the default pretty-JSON dump with a format matched
  // to how the tool's input is meant to be read. Falls back to JSON for everything else.
  const expandedBody = hasPayload ? renderToolExpandedBody(m.toolName, m.toolInput) : '';
  // alwaysExpanded tools skip the summary/detail rows: their formatter intentionally
  // returns no body/detail, and the structured payload below carries the same information
  // in a richer form.
  const detail = (!alwaysExpanded && f.detail) ? `<div class="tool-detail">${escapeHtml(f.detail)}</div>` : '';
  // Formatters can set body to an empty string when the label alone is enough (Edit, for
  // example, surfaces the filename in its expanded diff header rather than the summary).
  // bodyKind='code' marks the body as an identifier (path, regex, URL, query) — wrap in
  // <code> so it renders mono and announces correctly to assistive tech. Default is prose.
  const summary = (!alwaysExpanded && f.body)
    ? f.bodyKind === 'code'
      ? `<div class="tool-summary tool-summary-code"><code>${escapeHtml(f.body)}</code></div>`
      : `<div class="tool-summary">${escapeHtml(f.body)}</div>`
    : '';
  return (
    `<div class="${cls}"${idAttr}>` +
      `<span class="tool-label">${escapeHtml(f.label)}${chev}</span>` +
      `<div class="tool-content">` +
        summary +
        detail +
        expandedBody +
      `</div>` +
    `</div>`
  );
}

// Dispatch helper — given a tool name + its input, return the HTML for the expanded
// payload view. Used by both transcript tool tiles and approval cards, so they show the
// same diff / shell / file-content preview whether you're approving the call or reading
// it back in the transcript.
function renderToolExpandedBody(toolName, toolInput) {
  if (toolName === 'Edit') return renderEditDiff(toolInput);
  if (toolName === 'Bash') return renderBashCommand(toolInput);
  if (toolName === 'Grep') return renderGrepSearch(toolInput);
  if (toolName === 'Write') return renderWriteContent(toolInput);
  if (toolName === 'Agent') return renderAgentPrompt(toolInput);
  if (toolName === 'WebFetch') return renderWebFetch(toolInput);
  return `<pre class="tool-json">${highlightJson(JSON.stringify(toolInput, null, 2))}</pre>`;
}

// Pretty-printed JSON with light syntax coloring. Runs ON the already-escaped text so the
// regex anchors match HTML entities (&quot; for quotes), which keeps the output XSS-safe.
// The token regexes are tuned for JSON.stringify(_, null, 2) output specifically — they
// don't need to handle every valid JSON edge case, just well-formed pretty output.
function highlightJson(jsonStr) {
  const esc = escapeHtml(jsonStr);
  return esc
    // Keys: a quoted string followed by colon — match before plain strings so we don't
    // claim a key as a string.
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="json-key">$1</span>$2')
    // Strings: any remaining quoted string (values).
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '<span class="json-string">$1</span>')
    // Numbers, booleans, nulls — anchored by the preceding ": " or "[ " / ", " so we don't
    // touch literal sequences that happen to appear inside string values.
    .replace(/([:[,]\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, '$1<span class="json-num">$2</span>')
    .replace(/([:[,]\s*)(true|false)\b/g, '$1<span class="json-bool">$2</span>')
    .replace(/([:[,]\s*)(null)\b/g, '$1<span class="json-null">$2</span>');
}

// ───────────────────── Tool-use formatters ─────────────────────
// Each formatter returns { label, body, detail? }:
//   label  — the small accent-tinted tag at the top ("Bash", "Edit", "Grafana · ...").
//   body   — the human-readable primary identifier (file path, command desc, URL, query).
//   detail — an optional mono line with the raw payload preview, dimmed.
// Unknown tools fall through to a generic JSON-truncate so we never lose information.

function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
function compactWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
function shortenPath(path) {
  if (!path) return '';
  // Collapse home directory to ~ so transcripts read consistently across machines.
  const norm = String(path).replace(/^\/Users\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/');
  return norm.length > 90 ? '…' + norm.slice(-89) : norm;
}

// Project-anchored path: when the file is under the current session's cwd, strip
// everything up to (but not including) the project directory's basename. With cwd =
// /Users/dc/frostbyte73/outpost, /Users/dc/frostbyte73/outpost/src/pwa/app.js becomes
// "outpost/src/pwa/app.js". Falls back to shortenPath (just collapsing $HOME to ~) for
// files outside cwd — outpost is multi-project now, so each session carries its own cwd.
function projectRelativePath(path) {
  if (!path) return '';
  const cwd = state.currentSessionCwd;
  if (cwd && typeof cwd === 'string') {
    const projectRoot = cwd.replace(/\/+$/, '');
    const projectName = projectRoot.slice(projectRoot.lastIndexOf('/') + 1);
    if (path === projectRoot) return projectName;
    if (path.startsWith(projectRoot + '/')) {
      return `${projectName}/${path.slice(projectRoot.length + 1)}`;
    }
  }
  return shortenPath(path);
}
function shortenUrl(url) {
  const s = String(url ?? '');
  if (s.length <= 120) return s;
  // Keep the protocol+host and the last bit of the path/query so the URL is still
  // recognizable. URL parsing tolerates partial inputs via the base-URL trick.
  try {
    const u = new URL(s, 'http://_');
    const host = u.host || '';
    const proto = u.protocol === 'http:' ? '' : `${u.protocol}//`;
    const pathQ = u.pathname + u.search;
    const tail = pathQ.length > 70 ? '…' + pathQ.slice(-69) : pathQ;
    return `${proto}${host}${tail}`;
  } catch {
    return s.slice(0, 60) + '…' + s.slice(-60);
  }
}

const MCP_SERVER_NAMES = {
  'claude_ai_DataDog_MCP': 'Datadog',
  'claude_ai_Slack': 'Slack',
  'claude_ai_PostHog': 'PostHog',
  'claude_ai_Gmail': 'Gmail',
  'claude_ai_Google_Calendar': 'Calendar',
  'claude_ai_Google_Drive': 'Drive',
  'claude_ai_Figma': 'Figma',
  'claude_ai_Salesforce': 'Salesforce',
  'claude_ai_Linear': 'Linear',
  'claude_ai_Vercel': 'Vercel',
  'claude_ai_Pylon': 'Pylon',
  'claude_ai_Clay': 'Clay',
  'claude_ai_Common_Room': 'Common Room',
  'claude_ai_Kitt_Analyst': 'Kitt',
  'claude_ai_Sumble': 'Sumble',
  'claude_ai_Ramp': 'Ramp',
  'claude_ai_Ramp_Data': 'Ramp',
  'claude_ai_Intuit_QuickBooks': 'QuickBooks',
  'plugin_linear_linear': 'Linear',
  'incident-io': 'incident.io',
  'notion': 'Notion',
  'github': 'GitHub',
  'grafana': 'Grafana',
  'livekit-docs': 'LiveKit Docs',
  'posthog': 'PostHog',
};
function prettyMcpServer(server) {
  return MCP_SERVER_NAMES[server] ?? String(server).replace(/_/g, ' ');
}

// Heuristic: pull the most likely "primary identifier" string out of an arbitrary MCP
// input. The key order is tuned to surface the human-meaningful field across the most
// common server schemas — URL / query / id / name beat content / message / description
// because the former are usually the noun the tool is acting on.
function pickPrimary(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['query', 'endpoint', 'url', 'path', 'file_path', 'pattern', 'channel', 'channel_id', 'incident_id', 'ticket_id', 'id', 'name', 'subject', 'title', 'description', 'prompt', 'message', 'text', 'content'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

const TOOL_FORMATTERS = {
  Bash(inp) {
    const cmd = String(inp.command ?? '');
    const desc = String(inp.description ?? '');
    const label = inp.run_in_background ? 'Bash · bg' : 'Bash';
    // With a description we have prose to lead with and the command goes in the mono
    // detail line. Without a description, the command IS the summary, so it should be
    // chip-styled like other identifiers (paths, queries) — otherwise short Bash calls
    // render as plain prose, breaking the visual rhythm of the surrounding tiles.
    if (desc) return { label, body: desc, detail: `$ ${truncate(cmd, 220)}` };
    return { label, body: truncate(cmd, 140), bodyKind: 'code' };
  },
  Read(inp) {
    const range = inp.offset != null
      ? `lines ${inp.offset}–${inp.offset + (inp.limit ?? 0) || inp.offset}`
      : inp.pages ? `pages ${inp.pages}` : null;
    return { label: 'Read', body: shortenPath(inp.file_path), bodyKind: 'code', detail: range };
  },
  Edit(inp) {
    // Collapsed: label + filename only. The expanded view (renderEditDiff) is what
    // shows the actual change — until then the filename is the only useful thing to
    // surface, and the before→after preview was always a lie.
    return {
      label: inp.replace_all ? 'Edit · all' : 'Edit',
      body: shortenPath(inp.file_path),
      bodyKind: 'code',
    };
  },
  Write(inp) {
    const content = String(inp.content ?? '');
    const lines = content ? content.split('\n').length : 0;
    return {
      label: 'Write',
      body: shortenPath(inp.file_path),
      bodyKind: 'code',
      detail: `${lines.toLocaleString()} lines · ${content.length.toLocaleString()} chars`,
    };
  },
  Grep(_inp) {
    // Grep's primary representation is the rg-style command block — see renderGrepSearch.
    // Setting alwaysExpanded skips the summary/detail rows and the expand/collapse chrome
    // so the block reads as the tile's main content.
    return {
      label: 'Grep',
      alwaysExpanded: true,
    };
  },
  Glob(inp) {
    return {
      label: 'Glob',
      body: String(inp.pattern ?? ''),
      bodyKind: 'code',
      detail: inp.path ? `in ${shortenPath(inp.path)}` : null,
    };
  },
  ToolSearch(inp) {
    const q = String(inp.query ?? '');
    const sel = q.match(/^select:(.+)$/);
    if (sel) {
      const tools = sel[1].split(',').map((s) => s.trim()).filter(Boolean);
      const label = 'ToolSearch · load';
      if (tools.length === 1) return { label, body: tools[0], bodyKind: 'code' };
      return { label, body: `${tools.length} tools`, detail: tools.join(', ') };
    }
    return { label: 'ToolSearch', body: truncate(q, 140), bodyKind: 'code' };
  },
  WebFetch(inp) {
    return {
      label: 'WebFetch',
      body: shortenUrl(inp.url),
      bodyKind: 'code',
      detail: inp.prompt ? truncate(compactWs(inp.prompt), 120) : null,
    };
  },
  WebSearch(inp) {
    return { label: 'WebSearch', body: truncate(String(inp.query ?? ''), 140) };
  },
  Agent(inp) {
    const type = inp.subagent_type ? ` · ${inp.subagent_type}` : '';
    return { label: `Agent${type}`, body: compactWs(inp.description) };
  },
  AskUserQuestion(inp) {
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    const first = qs[0]?.question ?? '';
    const more = qs.length > 1 ? ` (+${qs.length - 1})` : '';
    return { label: 'Ask', body: truncate(String(first), 160) + more };
  },
  Skill(inp) {
    return {
      label: 'Skill',
      body: String(inp.skill ?? ''),
      detail: inp.args ? truncate(String(inp.args), 120) : null,
    };
  },
  ScheduleWakeup(inp) {
    const s = Number(inp.delaySeconds ?? 0);
    const dur = s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
    return {
      label: 'Wakeup',
      body: compactWs(inp.reason) || `in ${dur}`,
      detail: `wake in ${dur}`,
    };
  },
  Monitor(inp) {
    const id = inp.taskId ?? inp.shellId ?? inp.shell_id ?? '?';
    return { label: 'Monitor', body: `task ${id}` };
  },
  NotebookEdit(inp) {
    return { label: 'NotebookEdit', body: shortenPath(inp.notebook_path), bodyKind: 'code' };
  },
  ExitPlanMode(inp) {
    return { label: 'ExitPlanMode', body: truncate(compactWs(inp.plan), 160) };
  },
};

function formatToolUse(name, input, fallback) {
  if (!name) return { label: 'Tool', body: fallback || '' };
  const inp = (input && typeof input === 'object') ? input : {};

  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] ?? '?';
    const tool = parts.slice(2).join('__');
    // telemetry.intent is a DataDog MCP convention: a natural-language sentence Claude
    // attaches to each call explaining WHY it's making it. When present it's strictly
    // better than any heuristic-picked input field — render it as prose, not code.
    const intent = (inp.telemetry && typeof inp.telemetry === 'object')
      ? inp.telemetry.intent
      : null;
    if (typeof intent === 'string' && intent.length > 0) {
      return {
        label: `${prettyMcpServer(server)} · ${tool}`,
        body: truncate(compactWs(intent), 240),
      };
    }
    // High-traffic MCP tools get bespoke handling so the body line reads naturally rather
    // than dumping a random field. Everything else falls back to the primary-field heuristic.
    if (name === 'mcp__grafana__grafana_api_request') {
      return {
        label: `Grafana · ${tool}`,
        body: `${inp.method ?? 'GET'} ${shortenUrl(inp.endpoint)}`,
        bodyKind: 'code',
      };
    }
    if (name === 'mcp__grafana__query_loki_logs' || name === 'mcp__grafana__query_loki_stats' || name === 'mcp__grafana__query_loki_patterns') {
      return { label: `Grafana · ${tool}`, body: truncate(String(inp.logql ?? inp.query ?? ''), 180), bodyKind: 'code' };
    }
    if (name === 'mcp__grafana__query_prometheus' || name === 'mcp__grafana__query_prometheus_histogram') {
      return { label: `Grafana · ${tool}`, body: truncate(String(inp.expr ?? inp.query ?? ''), 180), bodyKind: 'code' };
    }
    const primary = pickPrimary(inp);
    // MCP primary fields are almost always identifiers (query, endpoint, url, id, name).
    // Default to code; the rare prose-y field will look fine in mono too.
    return {
      label: `${prettyMcpServer(server)} · ${tool}`,
      body: primary ? truncate(compactWs(primary), 200) : truncate(JSON.stringify(inp), 120),
      bodyKind: 'code',
    };
  }

  const handler = TOOL_FORMATTERS[name];
  if (handler) {
    const out = handler(inp);
    return {
      label: out.label || name,
      body: out.body || '',
      detail: out.detail || null,
      // bodyKind needs to ride through this normalizer too — otherwise formatters can set
      // it but the renderer never sees it. (Was silently dropped, which is why Read/Edit/
      // Write/Grep/etc. weren't getting the inline-code chip even though they declared it.)
      bodyKind: out.bodyKind,
      // alwaysExpanded — formatters can opt out of the expand/collapse chrome and force
      // the structured payload to render as the tile's primary content (Grep does this).
      alwaysExpanded: out.alwaysExpanded,
    };
  }
  // Unknown tool: keep working, just dump compact JSON. Better than nothing.
  return { label: name, body: truncate(JSON.stringify(inp), 140) };
}

// Sort task entries by their numeric id (Claude assigns these sequentially). String ids
// fall back to lexicographic order, which would only matter if Claude ever stopped assigning
// digits — defensive, not load-bearing.
function sortedTodoEntries() {
  return [...state.todos.entries()].sort((a, b) => {
    const ai = parseInt(a[0], 10), bi = parseInt(b[0], 10);
    if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
    return String(a[0]).localeCompare(String(b[0]));
  });
}

// Compact panel: a two-row "trail" sitting right above the composer. Top row is the most
// recently completed task (history, dim + strikethrough); bottom row is what's happening
// now (in_progress preferred, else next pending). They're visually connected by a vertical
// hairline so the panel reads as a tiny timeline: "just finished → up now". The whole
// thing is a tap target that opens the full sheet.
function todosPanelHtml() {
  if (state.todos.size === 0) return '';
  const all = sortedTodoEntries();
  const active = all.filter(([, t]) => t.status !== 'completed' && t.status !== 'deleted');
  const done = all.filter(([, t]) => t.status === 'completed');
  // Most recently completed = highest-id completed (Claude assigns sequentially).
  const lastDone = done.length ? done[done.length - 1] : null;
  // Up-now = the first in_progress task, falling back to the first pending one.
  const upNow = active.find(([, t]) => t.status === 'in_progress') ?? active[0] ?? null;

  const counter = `${done.length}/${all.length}`;

  if (!upNow && !lastDone) return '';

  // All-done state: a single italic "complete" line. Still a button so the sheet is
  // reachable for review. No connector, no second row.
  if (!upNow) {
    return `
      <button class="todos-panel todos-panel-done" type="button" id="todos-panel" aria-label="Open task list">
        <span class="todos-trail-line">
          <span class="todos-node todos-node-done" aria-hidden="true"></span>
          <span class="todos-text todos-text-done">All ${escapeHtml(String(all.length))} complete</span>
          <span class="todos-meta">${escapeHtml(counter)} <span class="todos-expand">⌃</span></span>
        </span>
      </button>
    `;
  }

  const topRow = lastDone
    ? renderTrailRow(lastDone[0], lastDone[1], 'done')
    : '';
  const bottomRow = renderTrailRow(upNow[0], upNow[1], 'now');

  return `
    <button class="todos-panel" type="button" id="todos-panel" aria-label="Open task list (${escapeHtml(counter)} complete)">
      ${topRow}
      ${bottomRow}
      <span class="todos-panel-meta" aria-hidden="true">
        <span class="todos-meta-count">${escapeHtml(counter)}</span>
        <span class="todos-expand">⌃</span>
      </span>
    </button>
  `;
}

// One row of the trail. `slot` controls position-specific styling (done = top history,
// now = bottom active). Both slots share the node + text + connector hairline structure.
function renderTrailRow(id, t, slot) {
  const status = (t && typeof t.status === 'string') ? t.status : 'pending';
  const subject = (t && typeof t.subject === 'string') ? t.subject : `Task #${id}`;
  const active = (t && typeof t.activeForm === 'string') ? t.activeForm : '';
  // For the "now" slot, prefer the activeForm — that's literally what's happening this
  // second. For the "done" slot, always use the subject (past tense doesn't matter; the
  // subject reads cleanest as a completed line item).
  const display = slot === 'now' && status === 'in_progress' && active ? active : subject;
  return `
    <span class="todos-trail-line todos-trail-${slot} todos-status-${escapeHtml(status)}">
      <span class="todos-node" aria-hidden="true"></span>
      <span class="todos-text">${escapeHtml(display)}</span>
    </span>
  `;
}

// Expanded sheet: sectioned editorial view. Top: title + progress bar. Then In Progress,
// Up Next, Completed — each section gets its own header treatment so the page reads as a
// document, not a flat list. Opens dynamically; rebuilt by refreshTodosSheet on live updates.
function openTodosSheet() {
  dismissSoftKeyboard();
  closeTodosSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop todos-sheet-backdrop';
  backdrop.id = 'todos-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet todos-sheet';
  sheet.id = 'todos-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'All tasks');
  sheet.innerHTML = todosSheetBodyHtml();
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  // Force a layout flush before adding .open so the transform animates instead of jumping.
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  backdrop.onclick = closeTodosSheet;
  sheet.querySelector('#todos-sheet-close').onclick = closeTodosSheet;
  pinSheetBelowHeader(sheet);
  makeSheetDismissible(sheet, closeTodosSheet);
  noteSheetOpen();
}

function todosSheetBodyHtml() {
  const all = sortedTodoEntries().filter(([, t]) => t.status !== 'deleted');
  const inProgress = all.filter(([, t]) => t.status === 'in_progress');
  const pending = all.filter(([, t]) => t.status === 'pending');
  // Completed reads top-down as "most recent first" — opposite of the dispatch-order sort
  // we use for the active sections, since the user wants to see the last thing finished.
  const completed = all.filter(([, t]) => t.status === 'completed').reverse();
  const total = all.length;
  const doneCount = completed.length;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  const section = (label, items, kind) => {
    if (items.length === 0) return '';
    const rows = items.map(([id, t]) => sheetRowHtml(id, t)).join('');
    return `
      <section class="todos-section todos-section-${kind}">
        <div class="todos-section-head">
          <span class="todos-section-label">${escapeHtml(label)}</span>
          <span class="todos-section-count">${escapeHtml(String(items.length).padStart(2, '0'))}</span>
        </div>
        <ul class="todos-section-list">${rows}</ul>
      </section>
    `;
  };

  return `
    <div class="grabber"></div>
    <div class="header-row todos-sheet-header">
      <div class="todos-sheet-title-block">
        <span class="sheet-title">Tasks</span>
        <span class="todos-sheet-progress-line">
          <span class="todos-sheet-fraction">${escapeHtml(`${doneCount}`)}<span class="todos-sheet-frac-divider">/</span>${escapeHtml(`${total}`)}</span>
          <span class="todos-sheet-pct">${escapeHtml(String(pct))}<span class="todos-sheet-pct-symbol">%</span></span>
        </span>
      </div>
      <button class="sheet-close" id="todos-sheet-close" aria-label="Close task list">✕</button>
    </div>
    <div class="todos-progress-bar" aria-hidden="true">
      <span class="todos-progress-fill" style="width:${pct}%"></span>
    </div>
    <div class="todos-sheet-body">
      ${section('In progress', inProgress, 'now')}
      ${section('Up next', pending, 'next')}
      ${section('Completed', completed, 'done')}
      ${total === 0 ? '<div class="empty-state todos-sheet-empty">No tasks yet.</div>' : ''}
    </div>
  `;
}

function sheetRowHtml(id, t) {
  const status = (t && typeof t.status === 'string') ? t.status : 'pending';
  const subject = (t && typeof t.subject === 'string') ? t.subject : `Task #${id}`;
  const active = (t && typeof t.activeForm === 'string') ? t.activeForm : '';
  // In-progress rows in the sheet display BOTH the subject and the activeForm —
  // the subject as the title, the activeForm beneath as a quieter "doing now" line.
  const showActive = status === 'in_progress' && active && active !== subject;
  return `
    <li class="todos-sheet-row todos-status-${escapeHtml(status)}">
      <span class="todos-sheet-node" aria-hidden="true"></span>
      <span class="todos-sheet-id">${escapeHtml(String(id).padStart(2, '0'))}</span>
      <span class="todos-sheet-body-cell">
        <span class="todos-sheet-subject">${escapeHtml(subject)}</span>
        ${showActive ? `<span class="todos-sheet-active">${escapeHtml(active)}</span>` : ''}
      </span>
    </li>
  `;
}

function closeTodosSheet() {
  const backdrop = document.getElementById('todos-sheet-backdrop');
  const sheet = document.getElementById('todos-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  // Wait out the transition duration before removing — matches .sheet's 0.36s transform.
  setTimeout(() => {
    backdrop?.remove();
    sheet?.remove();
  }, 380);
}

// Bottom sheet that asks the user where to launch a new claude session. Recents come from
// state.projects (already populated by loadSessions). Tap a recent project = immediate
// create. Custom path footer expands into a text input for first-time-in-a-project. On
// daemon_error from the spawn attempt (Task 9), this sheet re-opens with the failed path
// + inline error so the user can correct.
function openCwdPickerSheet(initialError) {
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
  noteSheetOpen();
  makeSheetDismissible(sheet, closeCwdPickerSheet);
  bindCwdPickerHandlers(sheet, backdrop);
}

function closeCwdPickerSheet() {
  const backdrop = document.getElementById('cwd-picker-sheet-backdrop');
  const sheet = document.getElementById('cwd-picker-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => { backdrop?.remove(); sheet?.remove(); }, 360);
}

// Phase 2a's "+ Add project" sheet. Registers a cwd in the ProjectRegistry so it
// appears in the session list even before claude has touched it. Sessions are then
// spawned via the in-row "+ New session" button (added in expandable project rows).
function openAddProjectSheet() {
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
  noteSheetOpen();
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
    const home = state.daemonInfo?.home;
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
      await loadSessions();
      const justAdded = state.projects.find((p) => p.cwd === cwd);
      if (justAdded) {
        setProjectExpanded(justAdded.projectDir, true);
        render();
      }
    } catch (err) {
      errorEl.textContent = `Network error: ${err?.message ?? err}`;
      errorEl.hidden = false;
    }
  });
}

function closeAddProjectSheet() {
  const backdrop = document.getElementById('add-project-sheet-backdrop');
  const sheet = document.getElementById('add-project-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => { backdrop?.remove(); sheet?.remove(); }, 360);
}

function cwdPickerBodyHtml(initialError) {
  const recents = state.projects.map((p) => {
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
  const hasRecents = state.projects.length > 0;
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
    // Client-side ~ expansion using the daemon's $HOME (surfaced via /api/info). The
    // daemon enforces absolute paths anyway, so a missing home just means the user has
    // to type the absolute path themselves.
    const home = state.daemonInfo?.home;
    const expanded = (home && raw.startsWith('~')) ? raw.replace(/^~/, home) : raw;
    commitNewSessionCwd(expanded);
  };
  if (form) form.addEventListener('submit', submitCustom);
}

// Commit handler: closes the picker, then opens a new session under the chosen cwd.
// Phase 2b: callers in git-repo projects pass spawnMode='worktree' + baseBranch so the
// daemon spins up a per-session worktree. Non-git callers (or explicit shared overrides)
// omit those fields and get the shared-cwd behavior.
function commitNewSessionCwd(cwd, opts = {}) {
  closeCwdPickerSheet();
  const id = crypto.randomUUID();
  state.pendingNewSession = { id, cwd };
  openSession(id, { cwd, ...(opts.spawnMode ? { spawn: opts.spawnMode } : {}), ...(opts.baseBranch ? { base: opts.baseBranch } : {}) });
}

// Approval cards now route through the same formatter the transcript uses, so the
// label, summary chip, detail line, expandable payload (diff for Edit, content for
// Write, shell for Bash, etc.) all match. We add the approval chrome (accent left
// border, "Approval needed" banner, Approve/Reject buttons) around it. The expand
// state uses a synthetic "approval-<id>" key so it doesn't collide with the tool_use_id
// state used by the transcript tiles.
function approvalCardHtml(a) {
  const f = formatToolUse(a.toolName, a.toolInput, a.summary);
  const detail = f.detail ? `<div class="tool-detail">${escapeHtml(f.detail)}</div>` : '';
  const expandable = a.toolInput !== undefined && a.toolInput !== null;
  const expandId = `approval-${a.approvalId}`;
  const expanded = expandable && state.expandedTools.has(expandId);
  const cls = `msg tool_use approval-card${expandable ? ' tool_use-expandable' : ''}${expanded ? ' tool_use-expanded' : ''}`;
  const idAttr = expandable ? ` data-tool-id="${escapeHtml(expandId)}"` : '';
  const chev = expandable ? `<span class="tool-chev" aria-hidden="true"></span>` : '';
  const expandedBody = expandable ? renderToolExpandedBody(a.toolName, a.toolInput) : '';
  const summary = f.body
    ? f.bodyKind === 'code'
      ? `<div class="tool-summary tool-summary-code"><code>${escapeHtml(f.body)}</code></div>`
      : `<div class="tool-summary">${escapeHtml(f.body)}</div>`
    : '';
  const enqueuedAt = a.enqueuedAt || Date.now();
  return (
    `<div class="${cls}"${idAttr} data-approval-id="${escapeHtml(a.approvalId)}" data-enqueued-at="${enqueuedAt}">` +
      `<div class="approval-banner">` +
        `<span class="approval-banner-label">Approval needed</span>` +
        `<span class="approval-banner-meta" data-countdown>${escapeHtml(formatApprovalCountdown(enqueuedAt))}</span>` +
      `</div>` +
      `<span class="tool-label">${escapeHtml(f.label)}${chev}</span>` +
      `<div class="tool-content">` +
        summary +
        detail +
        expandedBody +
      `</div>` +
      `<div class="approval-actions">` +
        `<button class="approve" data-id="${escapeHtml(a.approvalId)}" type="button" aria-label="Approve ${escapeHtml(f.label)}">Approve</button>` +
        `<button class="reject" data-id="${escapeHtml(a.approvalId)}" type="button" aria-label="Reject ${escapeHtml(f.label)}">Reject</button>` +
      `</div>` +
      (a.suggestion ? (
        `<div class="approval-suggestion" data-approval-id="${escapeHtml(a.approvalId)}">` +
          `<div class="suggestion-text">` +
            `You've approved this ${a.suggestion.matchCount}× ${a.suggestion.triggerWindow === '24h' ? 'in the past day' : 'this week'}.` +
          `</div>` +
          `<div class="suggestion-controls">` +
            `<label class="suggestion-scope">` +
              `Always allow <code>${escapeHtml(a.suggestion.suggestedValue)}</code> in ` +
              `<select class="suggestion-scope-select">` +
                `<option value="project">this project</option>` +
                `<option value="global">all projects</option>` +
              `</select>` +
            `</label>` +
            `<button class="suggestion-confirm" type="button">Always allow</button>` +
          `</div>` +
        `</div>`
      ) : '') +
    `</div>`
  );
}

// Suggest an allowlist rule that would cover a given tool call. Returns { kind, value,
// label } where `label` is the human-readable form shown in the confirm sheet, and
// { kind, value } is the POST body for /api/allowlist/rules.
//
// Strategy by tool:
//   - generic tools: just the tool name → kind='tool'.
//   - Bash: take leading whitespace-separated tokens that look like commands/subcommands
//     (alphanum or hyphen, no flags), stop at the first flag/arg → kind='bash' with an
//     anchored pattern. Mirrors how the existing config patterns are written.
//   - mcp__ tools: exact match anchored at both ends → kind='mcp'.
// Returns null if we can't derive a sensible rule (e.g. empty Bash command).
function suggestAllowRule(toolName, toolInput) {
  if (toolName === 'Bash') {
    const cmd = (toolInput && typeof toolInput.command === 'string') ? toolInput.command.trim() : '';
    if (!cmd) return null;
    const rawTokens = cmd.split(/\s+/);
    const tokens = [];
    let truncated = false;
    for (const tok of rawTokens) {
      if (!/^[a-zA-Z0-9_][\w.-]*$/.test(tok)) { truncated = true; break; }
      tokens.push(tok);
      if (tokens.length === 3) { truncated = rawTokens.length > 3; break; }
    }
    if (tokens.length === 0) return null;
    // Refuse to derive a rule when the command starts with a destructive verb and we had
    // to truncate the tokens (because a path / flag value broke the strict token regex).
    // Without this guard, 'rm -rf /tmp/x' yields '^rm \\-rf(\\s|$)' which forever allows
    // 'rm -rf <anything>'. Make the user write the rule by hand if they really mean it.
    const DESTRUCTIVE = new Set(['rm', 'mv', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'mkfs', 'fdisk', 'sudo', 'doas', 'curl', 'wget']);
    if (truncated && DESTRUCTIVE.has(tokens[0])) return null;
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ');
    const pattern = `^${escaped}(\\s|$)`;
    return { kind: 'bash', value: pattern, label: `Bash · ${tokens.join(' ')}${truncated ? ' …' : ''}` };
  }
  if (toolName.startsWith('mcp__')) {
    const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { kind: 'mcp', value: `^${escaped}$`, label: toolName };
  }
  return { kind: 'tool', value: toolName, label: toolName };
}

// Confirm-sheet + POST to /api/allowlist/rules. On success: refresh /api/info so the
// list-footer rule count updates, then approve the original call. On a duplicate rule
// the server returns added:false; we still approve the call but skip the "rule added"
// toast since nothing actually changed.
async function alwaysAllowAndApprove(approvalId, toolName, toolInput) {
  const suggested = suggestAllowRule(toolName, toolInput);
  if (!suggested) {
    showStatusToast('Cannot derive a rule from this call');
    return;
  }
  const ok = await confirmInSheet({
    title: 'Always allow this?',
    body: `Future tool calls matching “${suggested.label}” will be auto-approved without prompting. Saved to the allowlist on disk.`,
    confirmLabel: 'Always allow',
    danger: false,
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/allowlist/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: suggested.kind, value: suggested.value }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (state.daemonInfo) state.daemonInfo.allowlistRuleCount = data.ruleCount;
    showStatusToast(data.added ? 'Rule added — call approved' : 'Rule already present', 'success');
  } catch (e) {
    showStatusToast(`Save failed: ${(e && e.message) || 'unknown'}`);
    return;
  }
  decideApproval(approvalId, 'allow');
}

// Approval countdown — "8m left" / "45s left" / "expired". Reads the timeout from
// /api/info (with a 10-min fallback for the brief window before info loads). Returns the
// remaining time as a short human string; under 60s remaining the renderer wraps the
// span in a `.approval-banner-meta-urgent` class to danger-tint it.
function formatApprovalCountdown(enqueuedAt) {
  const timeoutMs = state.daemonInfo?.approvalTimeoutMs ?? 10 * 60 * 1000;
  const remaining = enqueuedAt + timeoutMs - Date.now();
  if (remaining <= 0) return 'expired';
  if (remaining < 60_000) return `${Math.ceil(remaining / 1000)}s left`;
  return `${Math.ceil(remaining / 60_000)}m left`;
}

// Walk every visible approval card's countdown span and update its text + urgent class.
// Returns true if any card has under 60s remaining — used by the adaptive scheduler to
// upgrade to a 1s tick so the user doesn't see "expired" stuck for up to a full tick
// past actual expiry.
function tickApprovalCountdowns() {
  let anyUrgent = false;
  for (const card of document.querySelectorAll('.approval-card[data-enqueued-at]')) {
    const enqueuedAt = Number(card.dataset.enqueuedAt) || 0;
    if (!enqueuedAt) continue;
    const meta = card.querySelector('[data-countdown]');
    if (!meta) continue;
    meta.textContent = formatApprovalCountdown(enqueuedAt);
    const timeoutMs = state.daemonInfo?.approvalTimeoutMs ?? 10 * 60 * 1000;
    const remaining = enqueuedAt + timeoutMs - Date.now();
    if (remaining > 0 && remaining < 60_000) anyUrgent = true;
    meta.classList.toggle('approval-banner-meta-urgent', remaining > 0 && remaining < 60_000);
    meta.classList.toggle('approval-banner-meta-expired', remaining <= 0);
  }
  return anyUrgent;
}
// Adaptive cadence: when any visible card is under 60s, tick every second so "45s left"
// stays accurate; otherwise tick every 15s (a minute-precision countdown doesn't need
// faster). Re-schedules itself after each tick so cadence reacts as cards age in.
(function scheduleApprovalCountdown() {
  const urgent = tickApprovalCountdowns();
  setTimeout(scheduleApprovalCountdown, urgent ? 1_000 : 15_000);
})();

// Per-tool verb shown on the thinking strip when that tool is in flight. Tools not in
// this map (mcp__*, Skill, Task*, ToolSearch, ScheduleWakeup, etc.) fall back to
// "thinking" so the strip still has something to say but doesn't claim a specific action.
const TOOL_VERBS = {
  Read: 'reading',
  Grep: 'grepping',
  Glob: 'globbing',
  Bash: 'bashing',
  Edit: 'editing',
  MultiEdit: 'editing',
  Write: 'writing',
  NotebookEdit: 'editing',
  WebSearch: 'surfing',
  WebFetch: 'surfing',
  Agent: 'delegating',
};

// How long the strip keeps showing a tool's verb after its result lands. Fast tools
// (Read, Grep, Glob) often finish in well under a second — without the linger, the
// verb flashes too briefly to read. A new tool firing during the linger cuts it short
// and switches immediately, so the verb stays responsive to actual activity.
const VERB_LINGER_MS = 10_000;

// Persistent status strip sitting above the agents bar — visible whenever the assistant
// is doing something. Hidden when the session is blocked on user input (the approval
// card itself is signal enough) and when no work is in flight. The verb tracks the top
// of state.activeTools so it reflects the currently-in-flight tool; falls back to
// "thinking" between calls (and for tools without a dedicated verb).
function thinkingStripHtml() {
  if (!state.thinking) return '';
  // Hide only when a REGULAR approval card is rendered inline — that card carries the
  // call-to-action so the strip would just be noise. AskUserQuestion (popup sheet) and
  // subagent approvals (routed to the agents sheet) both leave the parent transcript
  // without a visible call-to-action, so keep the alive signal up: a user who dismissed
  // the Ask sheet otherwise has no clue claude is still working.
  const blockedOnInlineCard = state.pendingApprovals.some((a) =>
    a.sessionId === state.currentSessionId
    && a.toolName !== 'AskUserQuestion'
    && !a.agentId
  );
  if (blockedOnInlineCard) return '';
  const top = state.activeTools.length > 0 ? state.activeTools[state.activeTools.length - 1] : null;
  const verb = top
    ? (TOOL_VERBS[top.toolName] || 'thinking')
    : (state.lingeringVerb || 'thinking');
  return (
    `<div class="thinking-strip" role="status" aria-live="polite">` +
      `<span class="thinking-strip-label">${escapeHtml(verb)}</span>` +
      `<span class="thinking-strip-meta">${escapeHtml(thinkingMetaText())}</span>` +
      `<span class="thinking-strip-dots" aria-hidden="true"><span></span><span></span><span></span></span>` +
    `</div>`
  );
}

function thinkingMetaText() {
  if (!state.thinkingStartedAt) return '';
  const elapsedMs = Date.now() - state.thinkingStartedAt;
  const secs = elapsedMs / 1000;
  // 0.0–9.9s → one decimal; 10s+ → integer; 60s+ → mm:ss.
  let t;
  if (secs < 10) t = `${secs.toFixed(1)}s`;
  else if (secs < 60) t = `${Math.floor(secs)}s`;
  else {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    t = `${m}:${String(s).padStart(2, '0')}`;
  }
  const tok = state.thinkingOutputTokens > 0 ? `${state.thinkingOutputTokens.toLocaleString()} tok` : '';
  return tok ? `${t} · ${tok}` : t;
}

function startThinking() {
  state.thinking = true;
  state.thinkingStartedAt = Date.now();
  state.thinkingOutputTokens = 0;
  state.thinkingOutputChars = 0;
  if (state.thinkingTicker) clearInterval(state.thinkingTicker);
  // 200ms cadence: fast enough that the seconds counter reads smoothly without spiking
  // CPU; we're mutating a single text node, not re-rendering the transcript.
  state.thinkingTicker = setInterval(updateThinkingMeta, 200);
}

function stopThinking() {
  state.thinking = false;
  state.thinkingStartedAt = 0;
  state.thinkingOutputTokens = 0;
  state.thinkingOutputChars = 0;
  state.activeTools = [];
  if (state.thinkingTicker) {
    clearInterval(state.thinkingTicker);
    state.thinkingTicker = null;
  }
  if (state.lingeringTimer) {
    clearTimeout(state.lingeringTimer);
    state.lingeringTimer = null;
  }
  state.lingeringVerb = null;
}

// Just patch the meta span — avoids a full renderSession() rebuild every 200ms.
function updateThinkingMeta() {
  if (!state.thinking) return;
  const el = document.querySelector('.thinking-strip .thinking-strip-meta');
  if (el) el.textContent = thinkingMetaText();
}

// Transient status toast for ephemeral feedback. tone='danger' (default) for failures,
// 'success' for positive confirmations like clipboard copy. Replaces any prior toast.
function showStatusToast(text, tone) {
  document.getElementById('status-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'status-toast';
  t.className = `status-toast${tone === 'success' ? ' status-toast-success' : ''}`;
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
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
    const sid = a.sessionId;
    const isSubagent = !!a.agentId;
    // Navigate to the session, then for subagent approvals also pop the agents sheet
    // so the user lands directly on the pending feed — saves them another tap to find
    // it. Tab sort + auto-advance handle which tab is shown.
    const nav = openSession(sid);
    if (isSubagent) {
      Promise.resolve(nav).finally(() => {
        if (state.currentSessionId === sid && state.subagents.size > 0) openAgentsSheet();
      });
    }
  };
  document.body.appendChild(toast);
  // Match the CSS animation timeline: 0.34s in, 6.6s wait, 0.34s out → ~7.3s total.
  setTimeout(() => toast.remove(), 7400);
}

function sendMessage() {
  const composer = document.getElementById('composer');
  const text = composer.textContent.trim();
  if (!text) return;
  if (state.ws?.readyState !== WebSocket.OPEN) {
    // Keep the text in the composer so the user can retry once reconnected — silently
    // dropping the message would be the worst possible failure mode here.
    showStatusToast('Disconnected — not sent');
    return;
  }
  state.transcript.push({ role: 'user', text });
  startThinking();
  state.ws.send(JSON.stringify({ type: 'user_message', content: text }));
  composer.textContent = '';
  document.getElementById('send')?.classList.remove('armed');
  renderSession();
  // Force the scroll even if the user was reading history — they just sent a message
  // and almost certainly want to see it land. renderSession's stuck-to-bottom heuristic
  // would otherwise leave them up in history wondering if the send went through.
  scrollTranscriptBottom();
}

// Send an approval decision over the most reliable channel available. Notifications WS is
// the preferred channel — it's engineered to survive iOS backgrounding and is the one that
// delivered the approval_pending. If both WSs are down (rare but possible), queue the
// decide for flush when the notifications WS next opens. Returns true if the decision was
// sent immediately, false if queued.
function sendApprovalDecide(payload) {
  const msg = { type: 'approval_decide', ...payload };
  const wire = JSON.stringify(msg);
  if (state.notifyWs?.readyState === WebSocket.OPEN) { state.notifyWs.send(wire); return true; }
  if (state.ws?.readyState === WebSocket.OPEN) { state.ws.send(wire); return true; }
  state.pendingDecides.push(payload);
  return false;
}

function flushPendingDecides() {
  if (state.pendingDecides.length === 0) return;
  if (state.notifyWs?.readyState !== WebSocket.OPEN) return;
  const drain = state.pendingDecides;
  state.pendingDecides = [];
  for (const p of drain) state.notifyWs.send(JSON.stringify({ type: 'approval_decide', ...p }));
}

function decideApproval(id, decision, reason) {
  // Route through sendApprovalDecide so the notifications WS is the preferred channel —
  // iOS backgrounding can close the session WS while leaving notifications WS alive, and
  // approvals only died because we were sending strictly over the session WS. Falls back
  // to the session WS, then to a pendingDecides queue flushed on next notifications open.
  const sent = sendApprovalDecide({ approvalId: id, decision, ...(reason ? { reason } : {}) });
  if (!sent) showStatusToast('Queued — will send when connected');
  state.pendingApprovals = state.pendingApprovals.filter((a) => a.approvalId !== id);
  // Mirror the decision into any matching subagent bucket entry. The entry stays in
  // the list so the agent feed continues to read as a continuous mini-transcript;
  // only the entry's decision field flips, which switches its renderer from approval-
  // card chrome to a plain resolved tool tile.
  for (const [, bucket] of state.subagents) {
    for (const e of bucket.entries) {
      if (e.approvalId === id && e.decision === null) {
        e.decision = decision === 'allow' ? 'allow' : 'deny';
        break;
      }
    }
  }
  // No auto-advance on decide. The user explicitly didn't want tabs reordering
  // when they finished the last approval in a tab — and the tab order is now
  // stable across decisions (see bringAgentToFront + state.agentTabOrder).
  // New-pending arrivals still bring an agent to front and auto-switch focus
  // when the active tab is idle — see the approval_pending branch above.
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
    // Refresh from the server so projects whose last session was just deleted naturally
    // disappear from the list.
    await loadSessions();
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
  let longPressTimer = null;
  let longPressFired = false;
  // The delete button is a sibling of the row inside the same .session-row-wrap.
  // Driving its transform in lockstep with the row keeps it off-screen at rest
  // (no flicker during scroll) and lets it slide in cleanly during a swipe.
  const deleteAction = row.parentElement?.querySelector('.delete-action');

  const cancelLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  };

  row.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    currentX = 0; isSwiping = false; swipeStarted = false; gestureCancelled = false;
    longPressFired = false;
    // Long-press = 550ms held without horizontal swipe; copies `claude --resume <id>` so
    // the user can pick the session back up on their laptop without typing the id by hand.
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      longPressTimer = null;
      copyResumeCommand(row.dataset.id);
    }, 550);
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    if (gestureCancelled) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (!swipeStarted) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Any meaningful movement aborts the long-press — treat the gesture as a
      // swipe/scroll instead.
      cancelLongPress();
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
    cancelLongPress();
    row.classList.remove('swiping');
    deleteAction?.classList.remove('swiping');
    if (!isSwiping) return;
    if (currentX < -SWIPE_OPEN_THRESHOLD) snapRowOpen(row);
    else snapRowClosed(row);
  });
  row.addEventListener('touchcancel', cancelLongPress);

  row.addEventListener('click', (e) => {
    // If the long-press already fired (clipboard write + toast), swallow the click so we
    // don't also open the session out from under the user.
    if (longPressFired) {
      e.preventDefault();
      e.stopPropagation();
      longPressFired = false;
      return;
    }
    if (row.dataset.openOffset) {
      e.preventDefault();
      e.stopPropagation();
      snapRowClosed(row);
      return;
    }
    openSession(row.dataset.id);
  });
}

// Copy `claude --resume <id>` to the clipboard so the user can pick the session back up
// from their laptop. Falls back to a status toast on failure (some browsers gate
// clipboard.writeText behind a permission prompt that fails silently).
async function copyResumeCommand(id) {
  if (!id) return;
  const cmd = `claude --resume ${id}`;
  try {
    await navigator.clipboard.writeText(cmd);
    showStatusToast('Resume command copied', 'success');
  } catch {
    showStatusToast('Copy blocked — check clipboard permissions');
  }
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

  // Phase 2: chunk into blocks separated by blank lines, then re-split each chunk so
  // headings and tables always end up as their own block — even when Claude writes them
  // back-to-back without an intervening blank line (e.g. "### In Progress\n| ID | ... |").
  // Without this second pass, a heading-then-table block doesn't match the heading regex
  // (multi-line input) AND doesn't match the table-start check (first line is the heading,
  // not a pipe-row), so it fell through to plain-paragraph rendering with literal `###`
  // and `|---|` artifacts.
  const blocks = withFences.split(/\n{2,}/).flatMap((block) => {
    const lines = block.split('\n');
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(buf.join('\n')); buf = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isHeading = /^#{1,6}\s/.test(line);
      // A table starts when the current line is a pipe-row AND the next line is the
      // standard markdown divider — same shape the table renderer below checks for.
      const isTableStart =
        i + 1 < lines.length
        && /^\s*\|.*\|\s*$/.test(line)
        && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1]);
      if (isHeading) {
        flush();
        out.push(line);
      } else if (isTableStart && buf.length) {
        flush();
        buf.push(line);
      } else {
        buf.push(line);
      }
    }
    flush();
    return out;
  });
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
  // Stash the rendered anchor in a placeholder so the bare-URL autolinker below doesn't
  // re-match the href inside it.
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (full, label, href) => {
    if (!/^(?:https?:\/\/|mailto:|tel:|\/)/.test(href)) return full;
    links.push(`<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return `\x00LINK${links.length - 1}\x00`;
  });

  // Bare URLs: linkify http(s)://… so URLs Claude prints inline (e.g. a `gh run` link)
  // are tappable. Trim trailing sentence punctuation back out of the href so "see
  // https://example.com." doesn't include the period.
  s = s.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
    let trail = '';
    while (url.length && /[.,;:!?)\]}'"]/.test(url.slice(-1))) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    if (!url) return trail;
    links.push(`<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return `\x00LINK${links.length - 1}\x00${trail}`;
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

  // Restore link placeholders before code, so anchors don't get mistakenly wrapped in
  // <code> if a future transform ever shifts ordering.
  s = s.replace(/\x00LINK(\d+)\x00/g, (_, i) => links[Number(i)] ?? '');

  // Restore inline code
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
    const code = inlineCodes[Number(i)];
    return `<code class="md-code">${escapeHtml(code)}</code>`;
  });

  return s;
}

/* ───── Utils ───────────────────────────────────────────────────── */

function persistExpandedProjects() {
  try { localStorage.setItem('op:expandedProjects', JSON.stringify(state.expandedProjects)); }
  catch { /* localStorage full or unavailable — non-fatal */ }
}
function isProjectExpanded(projectDir, isMostRecent) {
  if (Object.prototype.hasOwnProperty.call(state.expandedProjects, projectDir)) {
    return state.expandedProjects[projectDir] === true;
  }
  return !!isMostRecent;
}
function setProjectExpanded(projectDir, expanded) {
  state.expandedProjects[projectDir] = expanded;
  persistExpandedProjects();
}

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

const VALID_THEMES = ['livekit', 'almanac', 'terminal', 'nordic', 'ink', 'botanical', 'plasma', 'atlas', 'library'];
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
  // Old accept-edits-toggle is gone; segmented control is the source of truth.
  renderApprovalModes();
}

// Toggle accept-edits mode. Persisted to localStorage so the setting survives reload,
// since the user typically picks this once at the start of a high-edit session and
// doesn't want to retoggle after every refresh.
function setAcceptEdits(v) {
  state.acceptEdits = !!v;
  if (state.acceptEdits) localStorage.setItem('cr:acceptEdits', 'true');
  else localStorage.removeItem('cr:acceptEdits');
  refreshSheetSelection();
  // Refresh the session view so the header chip appears/disappears immediately.
  if (state.view === 'session') renderSession();
}

function openSettings() {
  if (document.getElementById('sheet').classList.contains('open')) return;
  refreshSheetSelection();
  const sheet = document.getElementById('sheet');
  pinSheetBelowHeader(sheet);
  document.getElementById('sheet-backdrop').classList.add('open');
  sheet.classList.add('open');
  noteSheetOpen();
}
function closeSettings() {
  if (!document.getElementById('sheet').classList.contains('open')) return;
  document.getElementById('sheet-backdrop').classList.remove('open');
  document.getElementById('sheet').classList.remove('open');
  noteSheetClose();
}

// Sheet UI wiring. Event delegation on the picker containers so the handlers stay
// stable even if the sheet's markup gets re-rendered.
document.getElementById('sheet-close').onclick = closeSettings;
document.getElementById('sheet-backdrop').onclick = closeSettings;
makeSheetDismissible(document.getElementById('sheet'), closeSettings);
document.getElementById('theme-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.theme-card');
  if (card?.dataset.themeKey) applyTheme(card.dataset.themeKey);
});
// Wire up the segmented permission-mode control. The single source of truth for
// the mode is the server (broadcast on attach via `approval_mode`); the PWA mirrors
// that into state.approvalMode and reflects it in the UI. Clicking a mode sends
// `approval_mode_set` and waits for the server's echo to update local state.
function setApprovalMode(mode) {
  if (state.approvalMode === mode) return;
  if (mode === 'bypass' && state.approvalMode !== 'bypass' && !state.bypassConfirmPending) {
    state.bypassConfirmPending = true;
    renderApprovalModes();
    setTimeout(() => {
      if (state.bypassConfirmPending) {
        state.bypassConfirmPending = false;
        renderApprovalModes();
      }
    }, 4000);
    return;
  }
  state.bypassConfirmPending = false;
  if (state.ws?.readyState === WebSocket.OPEN) {
    // Connected: send to server and wait for the echo to commit state.approvalMode.
    state.ws.send(JSON.stringify({ type: 'approval_mode_set', mode }));
    // Online: defer state.approvalMode + setAcceptEdits to the server's echo (handled in the
    // `approval_mode` WS message branch). Just send and wait.
  } else {
    // Offline (no session yet, or WS not connected): optimistically reflect the choice locally
    // so the segmented control updates immediately. The push-back logic on next WS attach
    // syncs this to the server.
    state.approvalMode = mode;
    setAcceptEdits(mode === 'accept-edits');
    renderApprovalModes();
  }
}

document.getElementById('permission-modes')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn?.dataset.mode) setApprovalMode(btn.dataset.mode);
});

function renderApprovalModes() {
  const desired = state.approvalMode ?? 'ask';
  const showBypassConfirm = state.bypassConfirmPending === true;
  for (const btn of document.querySelectorAll('.permission-mode')) {
    const m = btn.dataset.mode;
    btn.setAttribute('aria-pressed', m === desired && !showBypassConfirm ? 'true' : 'false');
    if (m === 'bypass' && showBypassConfirm) {
      btn.textContent = 'Tap again to confirm';
    } else if (m === 'bypass') {
      btn.textContent = 'Bypass';
    }
  }
  for (const span of document.querySelectorAll('.permission-desc [data-for-mode]')) {
    span.hidden = span.dataset.forMode !== desired;
  }
}

document.getElementById('mode-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn?.dataset.mode) applyMode(btn.dataset.mode);
});

syncThemeColorMeta();
renderApprovalModes();

// When the PWA comes back to the foreground (user unlocks phone, switches back from
// another app), iOS may have severed the WS without firing onclose yet — the next
// retry tick is up to 1.5s away. Fire a reconnect immediately so the user doesn't see
// a stale snapshot while waiting.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Check the live readyState rather than our state mirror — iOS can put the socket
  // into CLOSED without notifying, in which case state.notifyWsReady is stale.
  const notifyDead = !state.notifyWs || state.notifyWs.readyState !== WebSocket.OPEN;
  const sessionDead = state.currentSessionId
    && (!state.ws || state.ws.readyState !== WebSocket.OPEN);
  if (notifyDead || sessionDead) forceReconnect();
  // Even if both WSs survived the background, in-memory state may have drifted from
  // disk truth — e.g. a backgrounded subagent's task-notification can land on disk but
  // not on the WS our PWA was listening to. Force a disk reconcile on every foreground
  // transition while in a session. Dedup via seenBlockSigs / readSubagents merging
  // makes this a no-op when nothing changed, and a recovery when something did.
  if (state.currentSessionId && state.view === 'session') {
    catchUpFromDisk(state.currentSessionId);
  }
});

// Keep --header-h in sync with the actual header height so the cross-session approval
// toast clears the header on every theme/safe-area combination instead of relying on a
// 56px guess.
(function trackHeaderHeight() {
  const header = document.getElementById('header');
  if (!header) return;
  const apply = () => {
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  };
  apply();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(apply).observe(header);
  } else {
    window.addEventListener('resize', apply);
  }
})();
// ───── Phase 4: Web Push subscription flow ─────────────────────────────
// Settings sheet section: iOS install banner, subscribe/unsubscribe toggle, test push.
// The handler also listens for messages from the service worker so foreground pushes
// (suppressed by the SW when a window is visible) and deep-link taps can route into
// existing in-page surfaces.

const PUSH = {
  permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  subscribed: false,
  endpoint: null,
};

function isiOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator.standalone === true); // iOS Safari legacy
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function setPushStatus(text) {
  const el = document.getElementById('push-status');
  if (el) el.textContent = text ?? '';
}

function refreshPushUI() {
  const banner = document.getElementById('push-ios-banner');
  const toggle = document.getElementById('push-toggle');
  const toggleState = document.getElementById('push-toggle-state');
  const test = document.getElementById('push-test');
  if (!banner || !toggle || !toggleState || !test) return;
  const needIosInstall = isiOS() && !isStandalone() && PUSH.permission !== 'granted';
  banner.hidden = !needIosInstall;
  toggle.setAttribute('aria-pressed', PUSH.subscribed ? 'true' : 'false');
  toggleState.textContent = PUSH.subscribed ? 'On' : 'Off';
  toggle.disabled = needIosInstall || typeof Notification === 'undefined';
  test.disabled = !PUSH.subscribed;
}

async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setPushStatus('Push not supported in this browser.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    PUSH.permission = perm;
    if (perm !== 'granted') {
      setPushStatus('Permission not granted.');
      refreshPushUI();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const vapid = state.daemonInfo?.vapidPublicKey;
    if (!vapid) {
      setPushStatus('Daemon has no VAPID key yet — reload and try again.');
      return;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
    }
    const subJson = sub.toJSON();
    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: subJson, userAgent: navigator.userAgent }),
    });
    if (!r.ok) throw new Error(`subscribe POST ${r.status}`);
    PUSH.subscribed = true;
    PUSH.endpoint = subJson.endpoint;
    setPushStatus('Subscribed.');
  } catch (e) {
    console.warn('subscribePush failed', e);
    setPushStatus(`Subscribe failed: ${e?.message ?? e}`);
  }
  refreshPushUI();
}

async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch('/api/push/subscribe', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
    }
    PUSH.subscribed = false;
    PUSH.endpoint = null;
    setPushStatus('Unsubscribed.');
  } catch (e) {
    console.warn('unsubscribePush failed', e);
    setPushStatus(`Unsubscribe failed: ${e?.message ?? e}`);
  }
  refreshPushUI();
}

async function sendTestPush() {
  try {
    setPushStatus('Sending…');
    const r = await fetch('/api/push/test', { method: 'POST' });
    if (!r.ok) throw new Error(`test POST ${r.status}`);
    setPushStatus('Test push sent.');
  } catch (e) {
    setPushStatus(`Test failed: ${e?.message ?? e}`);
  }
}

document.getElementById('push-toggle')?.addEventListener('click', () => {
  if (PUSH.subscribed) unsubscribePush();
  else subscribePush();
});
document.getElementById('push-test')?.addEventListener('click', sendTestPush);

// Hydrate PUSH state on load so a reload shows "On" if the registration still has a sub.
(async function hydratePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      refreshPushUI();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    PUSH.subscribed = !!sub;
    PUSH.endpoint = sub?.endpoint ?? null;
  } catch { /* hydration is informational */ }
  refreshPushUI();
})();

// SW → page bridge. The SW posts {type:'push',...} when foreground-suppressed; we don't
// double-render here because the existing notifications WS already delivered the event.
// {type:'deepLink',...} fires when the user taps a notification while a PWA window is
// open — the SW focused us, now we apply the session+approval routing without nav.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'deepLink') {
      applyDeepLink({ sessionId: msg.sessionId, approvalId: msg.approvalId });
    }
  });
}

// ───── Phase 4: deep-link handling ─────────────────────────────────────
// URL shape: /?session=<id>&approval=<id>. Used when the user taps a push notification
// and the PWA either launches cold OR is already open (SW posts via 'deepLink' message).

function readDeepLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  const approvalId = params.get('approval');
  if (!sessionId) return null;
  return { sessionId, approvalId };
}

function highlightApprovalCard(approvalId) {
  const el = document.querySelector(`.approval-card[data-approval-id="${CSS.escape(approvalId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('approval-card-highlight');
  setTimeout(() => el.classList.remove('approval-card-highlight'), 2000);
  return true;
}

function applyDeepLink(target) {
  if (!target?.sessionId) return;
  const go = () => {
    if (state.currentSessionId !== target.sessionId) {
      openSession(target.sessionId);
    }
    if (!target.approvalId) return;
    // Approval card may not be in the DOM until openSession finishes hydrating. Retry
    // briefly before giving up.
    let tries = 0;
    const tick = () => {
      if (highlightApprovalCard(target.approvalId)) return;
      if (++tries > 30) return;
      setTimeout(tick, 100);
    };
    tick();
  };
  if (state.projects.length === 0) setTimeout(go, 0);
  else go();
}

// Cold-start deep link: capture before stripping the URL so reload/forward/back doesn't
// re-fire the highlight.
const initialDeepLink = readDeepLinkFromUrl();
if (initialDeepLink) {
  history.replaceState(null, '', location.pathname + location.hash);
}

loadDaemonInfo();
loadSessions().then(() => {
  if (initialDeepLink) applyDeepLink(initialDeepLink);
});
connectNotificationWs();

// Test instrumentation: expose helpers so Playwright tests can send raw WS messages
// and wait for specific incoming messages without needing window.state (ESM modules
// don't expose top-level bindings to window). Named with double underscores to be
// clearly non-API.
//
// __outpostSendWs(msg): sends msg over the open session WS. Returns true if sent.
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostSendWs = (msg) => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    return true;
  }
  return false;
};
// __outpostWaitWsMsg(predicate): returns a Promise that resolves with the first incoming
// session WS message for which predicate(msg) returns true. Adds a one-shot addEventListener
// so it doesn't interfere with app.js's own ws.onmessage handler.
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostWaitWsMsg = (predicate) => new Promise((resolve) => {
  if (!state.ws) { resolve(null); return; }
  const ws = state.ws;
  const handler = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (predicate(msg)) {
      ws.removeEventListener('message', handler);
      resolve(msg);
    }
  };
  ws.addEventListener('message', handler);
});
// __outpostGetState(): returns selected state fields. Lets Playwright poll JS state
// directly without needing the segmented-control buttons to be in the DOM (they only
// exist while the settings sheet is open, which it isn't in session view).
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostGetState = () => ({
  approvalMode: state.approvalMode,
  acceptEdits: state.acceptEdits,
  connState: state.connState,
  currentSessionId: state.currentSessionId,
  lastSeenSeq: state.lastSeenSeq,
  replayGapCount: state.replayGapCount ?? 0,
});
// __outpostForceCloseSessionWs(): close the session WS to drive the reconnect path.
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostForceCloseSessionWs = () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close();
};
// __outpostSessionWsReadyState(): expose the live readyState so tests can wait for reconnect.
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostSessionWsReadyState = () => state.ws?.readyState ?? -1;
// __outpostSetLastSeenSeq(n): rewind lastSeenSeq to force a stale ?since= on next connect.
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostSetLastSeenSeq = (n) => { state.lastSeenSeq = n; };
// __outpostOpenSession({id, cwd, spawn?, base?}): synthesize a session WS open with the
// given query params. Used by Phase 2b e2e tests that need to spawn a worktree session
// without going through the in-row click (which the PWA UI work in T8 wires up).
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostOpenSession = (opts) => {
  if (!opts?.id) throw new Error('__outpostOpenSession requires an id');
  openSession(opts.id, {
    cwd: opts.cwd,
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.base ? { base: opts.base } : {}),
  });
};
// __outpostRefreshSessions(): re-fetches /api/sessions and re-renders the list. Lets
// tests pull in a newly-registered project without doing a full page reload (which
// would wipe state.approvalMode set optimistically in list view before opening a session).
// @ts-expect-error — intentional globalThis assignment for test infrastructure only
globalThis.__outpostRefreshSessions = () => loadSessions();
