// WebSocket message dispatcher. Every frame the client receives — whether on a
// per-session `/ws/sessions/<id>` socket or the singleton `/ws/notifications`
// socket — routes through here.
//
// Two dispatch tables: `sessionHandlers` for messages arriving on a session WS
// (session-scoped mutations, transcript growth, subprocess lifecycle) and
// `broadcastHandlers` for the global notification WS (approvals, cross-session
// state changes, background events).
//
// State stores and stateless helpers are imported directly. App-level side
// effects (renderers, toasts, sheet openers, thinking-lifecycle helpers) can't
// import from app.js without cycling, so they're passed in via
// installDispatchDeps() at boot.

import { sessions, applyPendingExpand, expandToolByContent } from '../state/sessions.js';
import { approvals } from '../state/approvals.js';
import {
  subagents,
  applyTaskUse,
  applyTaskResult,
  applyTaskNotification,
  recordParentAgentInvocation,
  applyAgentMessageUse,
  applyAgentMessageResult,
  addSubagentEntry,
  bringAgentToFront,
} from '../state/subagents.js';
import { usage } from '../state/usage.js';
import { baseModelId } from '../utils/context-usage.js';
import { work } from '../state/work.js';
import { sessionActivity } from '../state/session-activity.js';
import { settings } from '../state/settings.js';
import { EDIT_TOOLS, TASK_TOOL_NAMES, isHighDetailTool } from '../components/tool-use-tile.js';
import { TOOL_VERBS } from '../components/session-view/regions.js';
import { sendApprovalModeSet } from '../components/session-view/session-ws.js';
import { restoreRefused } from '../components/session-view/attachments.js';
import { openSession } from '../app-bridge.js';
import { agentResultSummary, toolUseEntry } from '../vm/session-events.js';

let deps = /** @type {any} */ (null);

// How long the thinking strip keeps showing a just-finished tool's verb
// before falling back to "thinking" — long enough that fast tools (Read,
// Grep, Glob) don't flash the verb too briefly to read.
const VERB_LINGER_MS = 10_000;

// Debounces work_launch_changed bursts (a governor drain() pass can fire onChange
// several times in a row) into a single jobs-list refetch.
let launchStatusRefetchTimer = null;
function scheduleLaunchStatusRefetch() {
  if (launchStatusRefetchTimer) return;
  launchStatusRefetchTimer = setTimeout(() => {
    launchStatusRefetchTimer = null;
    void work.loadAll();
  }, 200);
}

// Fields expected on the deps object:
//   state — the app.js mutable state object (pendingNewSession, lingeringTimer, bypassConfirmPending)
//   renderSession / renderList / render — top-level renderers. renderSession
//     is a no-op today (session-view/index.js's own paint() already repaints
//     reactively via store subscriptions for whichever session is mounted;
//     kept only so this module's many call sites don't need a follow-up edit)
//   showApprovalToast, openCwdPickerSheet, refreshHeaderModeChip, setAcceptEdits — UI side effects
//   applyTaskUse, applyTaskResult, applyTaskNotification, applyPendingExpand,
//   expandToolByContent, recordUsage, startThinking, stopThinking,
//   recordParentAgentInvocation, addSubagentEntry, bringAgentToFront,
//   ensureAskInlineTile, leaveSession, sendApprovalDecide — app.js helpers
export function installDispatchDeps(d) {
  deps = d;
}

// Canonical session events (src/runtime/types.ts) plus daemon frames; subagent events belong to the agents sheet.
export function dispatchSession(msg, sid) {
  if (msg.subagent) return;
  const resolvedSid = sid ?? sessions.get().currentSessionId;
  const isCurrent = resolvedSid === sessions.get().currentSessionId;
  if (msg.type !== 'daemon_error' && deps.state.pendingNewSession && deps.state.pendingNewSession.id === resolvedSid) {
    deps.state.pendingNewSession = null;
  }
  const h = sessionHandlers[msg.type];
  if (h) h(msg, resolvedSid, isCurrent);
}

// Entry point for notification-WS messages. No sid resolution — these are
// global broadcasts that carry their own sessionId (or none) inside the frame.
export function dispatchBroadcast(msg) {
  const h = broadcastHandlers[msg.type];
  if (h) h(msg);
}

const sessionHandlers = {
  // claude -p holds the turn's first API request until every pending MCP server connects; the
  // session start is the only event that says so
  'session.started'(e, sid, isCurrent) {
    if (!e.mcpServers?.some((s) => s.status === 'pending')) return;
    sessions.for(sid).setMcpPending(true);
    if (!sessions.getSlice(sid)?.thinking) deps.startThinking(sid);
    if (isCurrent) deps.renderSession();
  },

  'turn.started'(_e, sid, isCurrent) {
    noteStreaming(sid, isCurrent);
  },

  // Estimate ~4 chars/token between usage updates to keep the counter climbing. No eager
  // repaint here — the per-mount 200ms metaTicker repaints the strip; painting per-delta
  // made the digits shimmer sub-frame.
  'content.delta'(e, sid, isCurrent) {
    noteStreaming(sid, isCurrent);
    const sl = sessions.getSlice(sid);
    if (!sl?.thinking || !e.text) return;
    const chars = (sl.thinkingOutputChars ?? 0) + e.text.length;
    const estimated = Math.ceil(chars / 4);
    sessions.for(sid).updateThinking(estimated > (sl.thinkingOutputTokens ?? 0) ? { chars, tokens: estimated } : { chars });
  },

  'item.started'(e, sid, isCurrent) {
    const item = e.item;
    if (item?.type !== 'tool_call') return;
    if (subagents.hasBlockSig(item.id)) return;
    subagents.markBlockSigSeen(item.id);
    const S = sessions.for(sid);
    if (TASK_TOOL_NAMES.has(item.tool)) {
      applyTaskUse(item.tool, item.input, item.id, sid);
    } else if (item.tool === 'ask_user') {
      deps.ensureAskInlineTile({ toolInput: item.input, msgId: item.messageId, toolUseId: item.id }, sid);
    } else {
      // hook stream only carries agent_id+agent_type; capture parent description for binding
      if (item.tool === 'subagent' && item.input && typeof item.input === 'object') {
        recordParentAgentInvocation({
          toolUseId: item.id,
          subagentType: item.input.subagent_type,
          description: item.input.description,
        });
      }
      // a send to a finished agent resumes it — un-stick its bucket from "done"
      if (item.tool === 'send_message' && item.input && typeof item.input === 'object') {
        applyAgentMessageUse(item.input, sid);
      }
      // approval card races the tool call's arrival; pre-stamp if already rejected
      const preReject = approvals.get().rejectionReasons.get(item.id);
      S.appendTranscript({
        ...toolUseEntry(item),
        ...(preReject ? { decision: 'deny', rejectReason: preReject.reason } : {}),
      });
      applyPendingExpand(item.rawName, item.input, item.id, sid);
      S.recordActiveTool({ toolUseId: item.id, toolName: item.rawName, tool: item.tool });
      if (deps.state.lingeringTimer) clearTimeout(deps.state.lingeringTimer);
      S.setLingeringVerb(null);
      deps.state.lingeringTimer = null;
      // auto-expansion is driven by tool_auto_allowed, NOT tool call arrival — otherwise
      // user-approved calls would expand whenever the call raced ahead of the click
    }
    if (!sessions.getSlice(sid)?.thinking) deps.startThinking(sid);
    if (isCurrent) deps.renderSession();
  },

  'item.completed'(e, sid, isCurrent) {
    const item = e.item;
    if (item?.type === 'assistant_message') {
      const sig = `${item.messageId}|${item.text}`;
      if (subagents.hasBlockSig(sig)) return;
      subagents.markBlockSigSeen(sig);
      sessions.for(sid).appendTranscript({ role: 'assistant', text: item.text, msgId: item.messageId });
      if (!sessions.getSlice(sid)?.thinking) deps.startThinking(sid);
      if (isCurrent) deps.renderSession();
      return;
    }
    if (item?.type === 'tool_call' && completeToolCall(item, sid) && isCurrent) deps.renderSession();
  },

  'usage.updated'(e, sid) {
    const u = e.usage ?? {};
    if (u.response) deps.recordUsage(u.response, u.model, sid);
    if (!sid) return;
    // The only place --print mode states a model's context window — statusLine never fires there
    for (const [model, size] of Object.entries(u.contextWindows ?? {})) {
      sessions.for(sid).setContextWindow(baseModelId(model), size);
    }
    if (typeof u.streamingOutputTokens === 'number') {
      sessions.for(sid).setMcpPending(false);
      const slice = sessions.getSlice(sid);
      if (slice?.thinking && u.streamingOutputTokens > slice.thinkingOutputTokens) {
        sessions.for(sid).updateThinking({ tokens: u.streamingOutputTokens });
      }
    }
    // authoritative; carries real context_window_size so 1M Opus doesn't look 5× over.
    // Attributed to the socket's own session id, not the mobile-singleton
    // `currentSessionId` pointer — desktop's multi-live sessions each have
    // their own per-session WS and need their own statusline entry (the
    // Sessions right rail's info card reads the slice's statusline per session).
    const sl = u.statusline;
    if (sl) {
      sessions.for(sid).setStatusline({
        model: sl.model ?? null,
        contextWindow: sl.contextWindow ?? null,
        cost: sl.cost ?? null,
        rateLimits: sl.rateLimits ?? null,
        effort: sl.effort ?? null,
        exceeds200k: !!sl.exceeds200k,
      });
    }
  },

  'turn.completed'(_e, sid, isCurrent) {
    sessions.for(sid).setMcpPending(false);
    deps.stopThinking(sid);
    if (isCurrent) deps.renderSession();
  },

  'task.notification'(e, _sid, isCurrent) {
    if (applyTaskNotification(e) && isCurrent) deps.renderSession();
  },

  // The daemon's Stop hook fired: the assistant ended its turn. The stream's own
  // terminal stop_reason normally gets there first — this is the backstop for a
  // client that was disconnected across it, or that never saw one (an assistant
  // frame carrying no block this handler recognises returns before the check).
  daemon_turn_end(_msg, sid, isCurrent) {
    if (!sessions.getSlice(sid)?.thinking) return;
    deps.stopThinking(sid);
    if (isCurrent) deps.renderSession();
  },

  daemon_error(msg, sid, isCurrent) {
    if (deps.state.pendingNewSession && deps.state.pendingNewSession.id === sid) {
      const failedCwd = deps.state.pendingNewSession.cwd;
      deps.state.pendingNewSession = null;
      if (isCurrent) deps.leaveSession();
      deps.openCwdPickerSheet({ message: msg.message, failedCwd });
      return;
    }
    // A refused message never reached claude: it leaves the transcript and goes back in the
    // composer, and the turn it was queued into is still running
    if (msg.clientId) {
      const S = sessions.for(sid);
      S.setTranscript((sessions.getSlice(sid)?.transcript ?? []).filter((m) => m.clientId !== msg.clientId));
      restoreRefused(sid, msg.clientId);
      S.appendTranscript({ role: 'error', text: msg.message });
      if (isCurrent) deps.renderSession();
      return;
    }
    sessions.for(sid).appendTranscript({ role: 'error', text: msg.message });
    deps.stopThinking(sid);
    if (isCurrent) deps.renderSession();
  },

  daemon_proc_exit(msg, sid, isCurrent) {
    const S = sessions.for(sid);
    deps.stopThinking(sid);
    // Subprocess exit → this session's slice becomes 'inactive'. Background
    // sessions never get demoted otherwise, so this is where we detect death.
    // The socket stays open: the daemon keeps it watching for the next wake.
    sessions.setRunState(sid, 'inactive');
    const now = Date.now();
    for (const [agentId, bucket] of subagents.forSession(sid).byId) {
      if (!bucket.completion) subagents.setCompletion(agentId, sid, { status: 'killed', completedAt: now });
    }
    const slice = sessions.getSlice(sid);
    if (slice?.expectedInterrupt) {
      // user-initiated stop: skip the error+Reopen tile and resume transparently
      S.clearExpectInterrupt();
      if (sid) { openSession({ id: sid }); return; }
    }
    if (slice?.expectedArchive) {
      // user archived the session: the SIGTERM is expected, so show a calm
      // notice rather than a crash tile — and no Reopen (the worktree is gone).
      S.clearExpectArchive();
      S.appendTranscript({ role: 'archived', text: 'Session archived.' });
      if (isCurrent) deps.renderSession();
      return;
    }
    if (msg.expected) {
      // A reap, reload or restart resumes on the next keystroke, so only a teardown is worth saying.
      if (msg.reason === 'archived') {
        S.appendTranscript({ role: 'archived', text: 'Session archived.' });
        if (isCurrent) deps.renderSession();
      }
      return;
    }
    S.appendTranscript({ role: 'error', text: `Session subprocess exited (code ${msg.code}).` });
    if (isCurrent) deps.renderSession();
  },

  // A `!` command finished — fill in the tile the composer appended when it was sent.
  // Matched on execId rather than position: several can be in flight at once. Nothing
  // matches when this is a replay into a reloaded page (or a second client that didn't
  // type it), in which case the frame IS the tile.
  shell_result(msg, sid) {
    const known = sessions.getSlice(sid)?.transcript
      ?.some((m) => m.role === 'shell' && m.execId === msg.execId);
    if (!known) {
      sessions.for(sid).appendTranscript({
        role: 'shell',
        execId: msg.execId,
        text: msg.command ?? '',
        stdout: msg.stdout ?? '',
        stderr: msg.stderr ?? '',
      });
      return;
    }
    sessions.for(sid).mapTranscript((m) => (
      m.role === 'shell' && m.execId === msg.execId
        ? { ...m, running: false, stdout: msg.stdout ?? '', stderr: msg.stderr ?? '' }
        : m
    ));
  },

  approval_mode(msg, sid, isCurrent) {
    // first broadcast on a fresh session: push the per-client default if it differs from 'ask'.
    // Flag lives on the slice so mobile and desktop tabs share the same trigger; the send
    // routes through session-ws regardless.
    const slice = sessions.getSlice(sid);
    const desired = settings.get().defaultApprovalMode;
    if (slice?.pendingDefaultPush && desired !== 'ask' && desired !== msg.mode) {
      sessions.for(sid).setPendingDefaultPush(false);
      const sent = sendApprovalModeSet(sid, desired);
      if (sent) return;
    }
    sessions.for(sid).setPendingDefaultPush(false);
    sessions.for(sid).setApprovalMode(msg.mode);
    if (isCurrent) sessions.setApprovalMode(msg.mode);
    deps.state.bypassConfirmPending = false;
    if (isCurrent) deps.setAcceptEdits(msg.mode === 'accept-edits');
    deps.refreshHeaderModeChip();
  },
};

// Any sign the model is streaming means the MCP wait is over and the turn is live.
function noteStreaming(sid, isCurrent) {
  sessions.for(sid).setMcpPending(false);
  if (sessions.getSlice(sid)?.thinking) return;
  deps.startThinking(sid);
  if (isCurrent) deps.renderSession();
}

// Applies a finished tool call to the active-tool stack, tasks, asks and subagents; true if the view changed.
function completeToolCall(item, sid) {
  const S = sessions.for(sid);
  const useId = item.id;
  const text = item.resultText ?? '';
  let touched = false;
  // pop the matching in-flight entry; thinking-strip verb falls back to next active or lingers
  const activeTools = sessions.getSlice(sid)?.activeTools ?? [];
  const popped = activeTools.find((t) => t.toolUseId === useId);
  if (popped) {
    S.clearActiveTool(useId);
    // empty stack: hold the verb long enough to read; next push clears lingering immediately
    const remaining = sessions.getSlice(sid)?.activeTools ?? [];
    if (remaining.length === 0 && TOOL_VERBS[popped.tool]) {
      S.setLingeringVerb(TOOL_VERBS[popped.tool]);
      if (deps.state.lingeringTimer) clearTimeout(deps.state.lingeringTimer);
      // S.setLingeringVerb(null) below is the only side effect that
      // matters — session-view's own slice subscription already repaints
      // the thinking strip from it, on both layouts.
      deps.state.lingeringTimer = setTimeout(() => {
        S.setLingeringVerb(null);
        deps.state.lingeringTimer = null;
      }, VERB_LINGER_MS);
    }
    touched = true;
  }
  // A name-addressed SendMessage only names the agent it woke here, in its result.
  if (applyAgentMessageResult(text, sid)) touched = true;
  // the live stream has no toolUseResult sidecar; agentId regex is the only completion signal
  const agentMatch = /agentId:\s*([a-f0-9]+)/i.exec(text);
  if (agentMatch) {
    const agentId = agentMatch[1];
    const bucket = subagents.forSession(sid).byId.get(agentId);
    if (bucket && !bucket.completion) {
      subagents.setCompletion(agentId, sid, {
        status: 'completed',
        summary: agentResultSummary(text),
        result: null,
        completedAt: Date.now(),
      });
      touched = true;
    }
  }
  if (subagents.get().pendingCreates.has(useId)) {
    applyTaskResult(useId, text, sid);
    touched = true;
  } else if (approvals.get().pendingAsks.has(useId)) {
    const entry = approvals.get().pendingAsks.get(useId);
    entry.answer = text;
    approvals.resolvePendingAsk(useId);
    approvals.markTaskResultConsumed(useId);
    touched = true;
  }
  return touched;
}

const broadcastHandlers = {
  daemon_account_usage(msg) {
    // `breakdown` (per-model cost/burn-rate/runway) rides alongside rateLimits
    // in the same broadcast — folded into accountUsage so both the mobile meter
    // (five_hour/seven_day) and the desktop sidebar-foot popover (breakdown) read
    // one field. Absent on daemons that haven't computed it yet; consumers guard.
    // setAccountUsage's store mutation drives both the mobile meter and the
    // desktop sidebar-foot popover via their own usage.subscribe() hooks.
    usage.setAccountUsage(msg.rateLimits ? { ...msg.rateLimits, breakdown: msg.breakdown ?? null } : null);
  },

  notifications_snapshot(msg) {
    approvals.setPending(Array.isArray(msg.approvals) ? msg.approvals : []);
    for (const a of approvals.get().pending) {
      // Each approval carries its own sessionId — route the "expand this tool"
      // marker to that session's slice, not the current mobile session.
      if (isHighDetailTool(a.tool) && a.sessionId) {
        sessions.for(a.sessionId).markToolExpanded(`approval-${a.approvalId}`, true);
      }
    }
    // additive re-apply; addSubagentEntry dedupes so resolved entries aren't
    // dropped on reconnect. Scoped to sessions the client already has a slice
    // for (i.e. opened this browser session) rather than the mobile-only
    // currentSessionId pointer — desktop can have several live tabs at once,
    // and gating on "current" silently skipped every one of them there.
    const known = sessions.get().sessionsById;
    for (const a of approvals.get().pending) {
      if (!a.sessionId || !known.has(a.sessionId)) continue;
      if (a.agentId) {
        addSubagentEntry(a);
      } else if (a.tool === 'ask_user') {
        deps.ensureAskInlineTile({ toolInput: a.toolInput }, a.sessionId);
      }
    }
    const view = sessions.get().view;
    if (view === 'list') deps.renderList();
    else if (view === 'session') deps.renderSession();
  },

  work_job_changed(msg) {
    // Tracked-job surfaces (Tracked list/detail) already react to work.applyWsEvent
    // via their own store subscription — no forced re-render needed here.
    work.applyWsEvent({ jobId: msg.jobId, job: msg.job });
  },

  session_activity(msg) {
    sessionActivity.apply(msg);
  },

  sessions_changed() {
    // Daemon debounces the broadcast (200ms) already, so pull the fresh list here.
    // renderList / renderDesktop react to sessions.projects via subscribe, so
    // there's no need to force a re-render explicitly.
    deps.loadSessions();
  },

  actions_changed() {
    import('../state/actions.js').then(({ actions: actStore }) => { void actStore.load(); });
  },

  // Claude's own sign-in lapsed. Refetching is what lights the Settings warn-dot without
  // waiting for someone to open the section — the failure itself arrives on the stderr of one
  // dying session, which nobody is necessarily watching.
  claude_auth_failed() {
    import('../state/grants.js').then(({ grantsStore: g }) => { void g.loadClaudeAuth(); });
  },

  user_prs_changed(msg) {
    import('../state/user-prs.js').then(({ userPrs }) => userPrs.applyWsEvent(msg.snapshot));
  },

  update_status(msg) {
    import('../state/update.js').then(({ updateStore }) => updateStore.applyWsEvent(msg.status));
  },

  run_appended(msg) {
    import('../state/runs.js').then(({ runs }) => runs.applyWsAppend(msg.run));
  },

  action_run_settled(msg) {
    import('../state/library.js').then(({ library }) => library.invalidateScorecard(msg.action));
  },

  // The acting client refreshes its own history; improver edits land while nobody is acting.
  action_revised(msg) {
    import('../state/library.js').then(({ library }) => library.invalidateRevisions(msg.action));
  },

  launch_concurrency_changed(msg) {
    settings.applyLaunchConcurrency(msg.value);
  },

  // Governor state changed (a launch fired/parked/freed a slot) — carries no jobId,
  // so refetch the jobs list to pick up fresh launchStatus everywhere. Debounced: a
  // drain() pass can fire onChange several times in a row.
  work_launch_changed() {
    scheduleLaunchStatusRefetch();
  },

  schedules_changed(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => schedulesStore.applyWsEvent(msg));
  },

  schedule_run_changed(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => schedulesStore.applyWsEvent(msg));
  },

  schedule_draft_ready(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => {
      schedulesStore.setDraft(msg.sessionId, {
        name: msg.name, summary: msg.summary, trigger: msg.trigger, what: msg.what,
      });
    });
  },

  schedule_draft_failed(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => {
      schedulesStore.setDraftFailed(msg.sessionId, msg.reason);
    });
  },

  action_edit_activity(msg) {
    import('../state/actions.js').then(({ actions: actStore }) => {
      actStore.pushActivity(msg.sessionId, msg.tool, msg.at);
    });
  },

  agent_activity(msg) {
    // sent in place of approval_pending when allowlist short-circuits; needed so read-only subagents show up.
    // sessionId must ride along — addSubagentEntry's currentSessionId fallback
    // is a mobile-only pointer (null on desktop, wrong session on mobile when
    // the activity came from a background session).
    addSubagentEntry({
      toolUseId: msg.toolUseId,
      tool: msg.tool,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      agentId: msg.agentId,
      agentType: msg.agentType,
      sessionId: msg.sessionId,
      decision: 'allow',
    });
    if (msg.sessionId === sessions.get().currentSessionId) {
      const view = sessions.get().view;
      if (view === 'session') deps.renderSession();
      else if (view === 'list') deps.renderList();
    }
  },

  tool_auto_allowed(msg) {
    // Hook can fire before or after the tool call arrives — expandToolByContent matches
    // now or queues for later, either order works. Route to the source session's slice
    // so background sessions keep their expand-on-arrival behavior.
    if (isHighDetailTool(msg.tool) && msg.sessionId) {
      expandToolByContent(msg.toolName, msg.toolInput, msg.sessionId);
      if (msg.sessionId === sessions.get().currentSessionId && sessions.get().view === 'session') {
        deps.renderSession();
      }
    }
  },

  approval_pending(msg) {
    if (approvals.get().pending.some((a) => a.approvalId === msg.approvalId)) return;
    // Mark the target session's tool as expanded so its details are visible
    // when the user lands on the approval.
    if (isHighDetailTool(msg.tool) && msg.sessionId) {
      sessions.for(msg.sessionId).markToolExpanded(`approval-${msg.approvalId}`, true);
    }
    if (settings.get().acceptEdits && EDIT_TOOLS.has(msg.tool)) {
      // Decide on the notifications WS — the only channel that survives iOS backgrounding.
      // Session WS would re-introduce the silent-drop bug where a backgrounded close
      // caused the hook to time out 10min later with a denied edit.
      deps.sendApprovalDecide({ approvalId: msg.approvalId, decision: 'allow' });
      if (msg.agentId) {
        addSubagentEntry({ ...msg, decision: 'allow' });
      } else if (msg.sessionId) {
        expandToolByContent(msg.toolName, msg.toolInput, msg.sessionId);
      }
      if (msg.sessionId === sessions.get().currentSessionId && sessions.get().view === 'session') {
        deps.renderSession();
      }
      return;
    }
    approvals.addPending(msg);
    if (msg.agentId) {
      const targetSlice = subagents.forSession(msg.sessionId);
      const wasNew = !targetSlice.byId.has(msg.agentId);
      addSubagentEntry(msg);
      // Reorder / activate operations touch the TARGET session's slice —
      // not necessarily the mobile-current session's — so background sessions'
      // subagent state also updates in real-time.
      bringAgentToFront(msg.agentId, msg.sessionId);
      const targetSliceAfter = subagents.forSession(msg.sessionId);
      const cur = targetSliceAfter.activeId ? targetSliceAfter.byId.get(targetSliceAfter.activeId) : null;
      const curHasPending = cur ? cur.entries.some((e) => e.decision === null) : false;
      if (!curHasPending) subagents.setActive(msg.agentId, msg.sessionId);
      if (msg.sessionId === sessions.get().currentSessionId) {
        const view = sessions.get().view;
        if (view === 'session') deps.renderSession();
        else if (view === 'list') deps.renderList();
      }
      void wasNew;
      return;
    }
    if (msg.tool === 'ask_user' && msg.sessionId === sessions.get().currentSessionId) {
      deps.ensureAskInlineTile({ toolInput: msg.toolInput });
    }
    const view = sessions.get().view;
    if (view === 'session' && msg.sessionId === sessions.get().currentSessionId) deps.renderSession();
    else if (view === 'list') deps.renderList();
    // The toast is the cross-session nudge — suppress it whenever the session's
    // own transcript is already on screen (desktop's sessions surface renders the
    // card inline off the approvals store, no mobile-shaped view flip involved).
    if (!sessions.isVisible(msg.sessionId)) deps.showApprovalToast(msg);
  },

  // Fires for cross-device user decisions and for server-side timeouts.
  approval_resolved(msg) {
    const wasPending = approvals.get().pending.some((a) => a.approvalId === msg.approvalId);
    approvals.removePending(msg.approvalId);
    // Store-notifying write: the Sessions rail repaints only off
    // subagents.subscribe, so a direct in-place decision flip would leave its
    // subagent live-tail frozen until an unrelated store tick.
    subagents.resolveApproval(msg.approvalId, msg.decision, msg.timedOut);
    // Timed-out tile is recorded in the target session's transcript (was
    // previously dropped for background sessions).
    if (msg.timedOut && wasPending && msg.sessionId && !msg.agentId) {
      sessions.for(msg.sessionId).appendTranscript({
        role: 'error',
        text: `${msg.toolName} approval timed out after 10 minutes — re-prompt to retry.`,
      });
    }
    if (msg.sessionId === sessions.get().currentSessionId) {
      const view = sessions.get().view;
      if (view === 'session') deps.renderSession();
      else if (view === 'list') deps.renderList();
    }
  },
};
