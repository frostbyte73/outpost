import { gateToolCall, onToolFailed, type GateDeps } from '../permissions/gate.js';
import { readInputKey, recordableRead } from '../permissions/read-recording.js';
import { AUTH_STOP_ERRORS } from '../work/job-liveness.js';
import type { Allowlist } from '../permissions/allowlist.js';
import type { ApprovalQueue } from '../permissions/approvals.js';
import type { ApprovalModeStore } from '../permissions/approval-mode.js';
import type { ActionRegistry } from '../actions/index.js';
import type { WorkEngine } from '../work/engine.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import type { InteractiveStore } from '../session/interactive-store.js';
import type { RecurrenceTracker } from '../storage/recurrence-tracker.js';
import type { StopHookTracker } from '../storage/stop-hook-tracker.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { ActionRunLedger } from '../work/action-run-ledger.js';
import type { RunsCapture } from '../storage/runs-capture.js';
import type { PushSender } from '../push-sender.js';
import { canonicalToolName } from './tools.js';
import type { RuntimeHost, StatuslineUsage } from './types.js';

export interface RuntimeHostDeps {
  engine: WorkEngine;
  manager: SessionManager;
  allowlist: Allowlist;
  queue: ApprovalQueue;
  modes: ApprovalModeStore;
  actionRegistry: ActionRegistry;
  worktreeManager: WorktreeManager;
  interactive: InteractiveStore;
  recurrence: RecurrenceTracker;
  stopTracker: StopHookTracker;
  pushSender: PushSender;
  runBlobs: BlobStore;
  actionRunLedger: ActionRunLedger;
  runsCapture: RunsCapture;
  latestStatuslineBySession: Map<string, StatuslineUsage>;
  pullBashPatterns: () => readonly string[];
  cwdForSession: (sessionId: string) => string | undefined;
  findSessionTitle: (sessionId: string) => string | undefined;
  notifyAll: (message: unknown) => void;
  recordActionDenial: NonNullable<GateDeps['onActionDenial']>;
  endTurn: (sessionId: string) => void;
  noteAuthFailure: (sessionId: string, message: string) => void;
}

// The daemon's answers to everything a runtime reports: tool gating, turn ends, usage.
export function createRuntimeHost(d: RuntimeHostDeps): RuntimeHost {
  const { engine, manager, allowlist, pushSender } = d;

  const gateDeps: GateDeps = {
    allowlist,
    queue: d.queue,
    modes: d.modes,
    cwdForSession: d.cwdForSession,
    worktreePathForSession: (id) => {
      // Step sessions: sessionId ≠ stepId; ask the orchestrator to resolve session → step → worktree.
      const viaOrch = engine.worktreePathForSession(id);
      if (viaOrch) return viaOrch;
      // Interactive/adopted sessions where the record is keyed directly by session id.
      const rec = d.worktreeManager.get(id);
      return rec && !rec.archivedAt ? rec.worktreePath : undefined;
    },
    actionForSession: (id) => engine.actionForSession(id),
    interactiveFor: (id) => d.interactive.isInteractive(id),
    gatedForAction: (name) => d.actionRegistry.gatedFor(name),
    pinFor: (sid, tool, input) => engine.pinFor(sid, tool, input),
    onPinConsumed: (sid, callId, toolUseId) => engine.consumePin(sid, callId, toolUseId),
    draftStateFor: (sid) => engine.draftStateFor(sid),
    onGatedDenial: (sid, act, reason) => engine.journalGatedDenial(sid, act, reason),
    onNotify: (approval) => {
      console.log(`[hook] enqueued approval ${approval.id.slice(0,8)} for ${approval.toolName}`);
      const summary = summarizeToolInput(approval.toolName, approval.toolInput);
      const sessionTitle = d.findSessionTitle(approval.sessionId);
      const cwd = d.cwdForSession(approval.sessionId);
      const suggestion = cwd ? d.recurrence.suggestionFor(cwd, approval.toolName, approval.toolInput) : null;
      d.notifyAll({
        type: 'approval_pending',
        approvalId: approval.id,
        sessionId: approval.sessionId,
        tool: approval.tool,
        toolName: approval.toolName,
        // AskUserQuestion popup needs the full questions/options structure.
        toolInput: approval.toolInput,
        toolUseId: approval.toolUseId,
        // Subagent provenance routes the approval into the agents feed.
        agentId: approval.agentId,
        agentType: approval.agentType,
        summary,
        sessionTitle,
        suggestion,
      });
      // Web Push so devices ring when backgrounded; tag collapses repeats per approval.
      void pushSender.send({
        title: sessionTitle ? `Approval: ${approval.toolName} (${sessionTitle})` : `Approval: ${approval.toolName}`,
        body: summary,
        tag: `approval-${approval.id}`,
        data: { kind: 'approval', sessionId: approval.sessionId, approvalId: approval.id },
      });
    },
    onActionDenial: (denial) => d.recordActionDenial(denial),
  };

  return {
    async gateToolCall(req) {
      const { sessionId, tool, rawName, input, subagent } = req;
      // Proof of life for the session — disarms any "ended without submitting" check left
      // by an earlier Stop. Subagent calls count (they carry the parent's session id).
      engine.noteSessionActivity(sessionId);
      // "What is meta.build-action doing right now" for the inline edit card; parent-session calls only.
      if (!subagent && manager.getKind(sessionId) === 'action-edit') {
        d.notifyAll({ type: 'action_edit_activity', sessionId, tool, toolName: rawName, at: Date.now() });
      }
      // Auto-allowed calls bypass the approval queue, so emit dedicated mirror events:
      // subagent buckets need agent_activity (their feed would otherwise be empty for
      // read-only agents), and parent transcripts need tool_auto_allowed for expand-by-default.
      if (allowlist.allows(tool, input)) {
        d.notifyAll(subagent
          ? {
            type: 'agent_activity', sessionId, tool, toolName: rawName, toolInput: input,
            agentId: subagent.agentId, agentType: subagent.agentType, toolUseId: req.toolUseId,
          }
          : { type: 'tool_auto_allowed', sessionId, tool, toolName: rawName, toolInput: input });
      }
      const decision = await gateToolCall(req, gateDeps);
      console.log(`[hook] decision: ${decision.allow ? 'allow' : 'deny'} for ${rawName}`);
      return decision;
    },

    onToolFailed(r) {
      onToolFailed(r, (sid, tool, input, toolUseId) => engine.releaseConsumedPin(sid, tool, input, toolUseId));
    },

    onToolCompleted({ sessionId, rawName, input, response }) {
      if (!engine.actionForSession(sessionId)) return;
      if (!recordableRead(rawName, input, d.pullBashPatterns())) return;
      const responseRef = d.runBlobs.put(JSON.stringify(response ?? null));
      if (!responseRef) return;
      d.actionRunLedger.noteRead(sessionId, { tool: rawName, inputKey: readInputKey(rawName, input), responseRef });
    },

    onTurnEnded(sessionId) {
      d.endTurn(sessionId);
      engine.clearStall(sessionId);
      const { shouldNotify, turnDurationMs } = d.stopTracker.consume(sessionId);
      console.log(`[hook] stop session=${sessionId.slice(0,8)} durationMs=${turnDurationMs ?? 'n/a'} push=${shouldNotify}`);
      // A resume queued behind an in-flight turn (e.g. a fast spec approval dispatching
      // /code.plan before the spec turn's Stop landed) leaves a trailing Stop that belongs
      // to the superseded round. Attributing it to the current round would spuriously fail
      // a step that's actively running — drop it here and wait for the real turn-end Stop.
      if (engine.consumeStaleTurnStop(sessionId)) {
        console.log(`[work] stop session=${sessionId.slice(0,8)} → stale (superseded round), ignored`);
      } else {
        // If this session is bound to an unresolved step, the assistant ended its turn
        // without calling submit_step_output. Arm the failure rather than applying it —
        // a round that yielded to background subagents gets re-invoked, and the next tool
        // call on the session calls the check off (see WorkEngine.armUnresolvedCheck).
        if (engine.armUnresolvedCheck(
          sessionId,
          'Session ended without submitting output via mcp__outpost__submit_step_output',
        )) {
          console.log(`[work] stop session=${sessionId.slice(0,8)} → unresolved-step check armed`);
        }
        engine.onControllerTurnEnded(sessionId);
      }
      if (!shouldNotify) return;
      const title = d.findSessionTitle(sessionId);
      void pushSender.send({
        title: title ? `Claude finished: ${title}` : 'Claude finished',
        body: turnDurationMs
          ? `Turn took ${(turnDurationMs / 1000).toFixed(0)}s. Tap to continue.`
          : 'Tap to continue.',
        tag: `stop-${sessionId}`,
        data: { kind: 'stop', sessionId },
      });
    },

    // An API error ended the turn (auth, rate limit, overload, billing). Unhandled, every such
    // turn left its session `working` forever: the job read Running, its governor slot stayed
    // held, and a lapsed sign-in mid-run went unannounced.
    onTurnFailed(sessionId, error, details) {
      d.endTurn(sessionId);
      d.stopTracker.consume(sessionId);
      console.warn(`[hook] stop-failure session=${sessionId.slice(0, 8)} error=${error}${details ? ` (${details})` : ''}`);
      const auth = AUTH_STOP_ERRORS.has(error);
      if (auth) d.noteAuthFailure(sessionId, details ?? error);
      // The trailing turn end of a round a queued resume already superseded — that resume is
      // the live round now, so there is nothing to park.
      if (engine.consumeStaleTurnStop(sessionId)) return;
      // Auth already pushed its one card above; anything else gets its own, tagged per error so
      // a rate limit hitting every running job at once lands as one notification.
      if (!engine.onApiStop(sessionId, error) || auth) return;
      const title = d.findSessionTitle(sessionId);
      void pushSender.send({
        title: `Stopped on an API error: ${error.replace(/_/g, ' ')}`,
        body: `${title ? `${title} — ` : ''}open the job to resume it.`,
        tag: `api-error-${error}`,
        data: { kind: 'stop', sessionId },
      });
    },

    onUsage(sessionId, usage) {
      const sl = usage.statusline;
      if (!sl) return;
      d.latestStatuslineBySession.set(sessionId, sl);
      manager.broadcast(sessionId, { type: 'usage.updated', usage });
      d.runsCapture.onStatusline(sessionId, sl);
      if (typeof sl.cost?.total_cost_usd === 'number') d.actionRunLedger.noteSessionCost(sessionId, sl.cost.total_cost_usd);
      if (typeof sl.model?.id === 'string' && sl.model.id) d.actionRunLedger.noteSessionModel(sessionId, sl.model.id);
    },
  };
}

export function summarizeToolInput(toolName: string, toolInput: unknown): string {
  try {
    if (canonicalToolName(toolName) === 'shell') return (toolInput as { command?: string }).command?.slice(0, 200) ?? toolName;
    return `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`;
  } catch {
    return toolName;
  }
}
