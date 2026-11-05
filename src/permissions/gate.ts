import { gatedMatch, type Allowlist } from './allowlist.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';
import { ApprovalModeStore, PLAN_MODE_ALWAYS, isPlanModeReadableMcpTool } from './approval-mode.js';
import type { ActionAllowlist } from '../actions/types.js';
import { verifyFileDigests } from '../work/write-draft.js';
import { isMcpTool } from '../runtime/tools.js';
import type { GateDecision, GateRequest } from '../runtime/types.js';

export interface GateDeps {
  allowlist: Allowlist;
  queue: ApprovalQueue;
  modes: ApprovalModeStore;
  // Lookup a session's cwd for project-scoped allowlist resolution. Returns undefined
  // if the session is unknown to the daemon (e.g. brand-new); allowlist then falls back
  // to global rules only.
  cwdForSession?: (sessionId: string) => string | undefined;
  // Lookup a session's active worktree path (from WorktreeManager). Returns undefined for
  // sessions without a worktree record (e.g. interactive PWA sessions). Used to auto-allow
  // path-shaped tool inputs that live inside the session's own worktree.
  worktreePathForSession?: (sessionId: string) => string | undefined;
  // Lookup a session's bound action name. The orchestrator binds this when it spawns
  // a step session; PWA-spawned sessions return undefined.
  actionForSession?: (sessionId: string) => string | undefined;
  // The action's gated rules — calls matching these run only when pinned by an approved
  // WriteDraft. `undefined` here means the registry doesn't recognize `action` at all
  // (e.g. deleted/renamed mid-run), NOT "inherits no gated group": a known action's `gated`
  // is always an ActionAllowlist, even an all-empty one, and gatedMatch never matches that.
  gatedForAction?: (action: string) => ActionAllowlist | undefined;
  // `fileDigests` is present when the pinned call's payload references a file (see
  // write-draft.ts's FILE_REFERENCING_FLAGS) — verified below before the pin is honoured.
  pinFor?: (sessionId: string, toolName: string, toolInput: unknown) =>
    { id: string; fileDigests?: Record<string, string> } | undefined;
  // `toolUseId` is recorded on the pin so a later tool failure can prove it's releasing
  // the pin THIS call spent — see WorkEngine.consumePin/releaseConsumedPin.
  onPinConsumed?: (sessionId: string, callId: string, toolUseId?: string) => void;
  // The session's draft state, consulted only to pick the right deny-reason wording when a
  // gated call has no live pin — see gatedDenyReason.
  draftStateFor?: (sessionId: string) => 'none' | 'pending' | 'approved';
  // A gated call was denied for a reason worth leaving evidence of (see the call sites for
  // which denials qualify). Journal-only — deliberately distinct from onActionDenial, which
  // offers a rule suggestion that makes no sense here (no rule would "fix" an unpinned
  // write). `action` is passed explicitly rather than left for the callee to derive from the
  // session's step: for a dispatch session, the bound step is the parent orchestrated step,
  // whose action is the CONTROLLER, not the child action the gate actually denied.
  onGatedDenial?: (sessionId: string, action: string, reason: string) => void;
  // Has the user taken the wheel on this session? A driven session is gated as a manual one —
  // its action binding is ignored until the user hands it back.
  interactiveFor?: (sessionId: string) => boolean;
  onNotify: (approval: PendingApproval) => void;
  // Called when an action-bound session has a tool call denied by allowlist-miss.
  // The daemon stores these so the user can review + add suggested rules in the PWA.
  onActionDenial?: (denial: {
    actionName: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
  }) => void;
}

const ALLOW: GateDecision = { allow: true };
const deny = (reason: string): GateDecision => ({ allow: false, reason });

// Kept in sync with the PWA's EDIT_TOOLS (src/pwa/components/tool-use-tile.js) —
// accept-edits mirrors --permission-mode=acceptEdits: file-mutating tools skip
// the prompt, everything else still gates.
const EDIT_TOOLS: ReadonlySet<string> = new Set(['file_edit', 'file_write', 'file_multi_edit', 'notebook_edit']);

// The deny reason a gated miss gets, branched on why it missed — a model denied here reliably
// retries with a different spelling or a helper script unless told plainly not to, and the
// wrong branch actively misdirects it (telling it to draft again when one is already approved
// costs the user a second, redundant approval). `pinMatched` covers Critical-1's case: an
// approved pin whose payload still fails the action's own allowlist — approval never overrides
// it, so this is not the same as "no pin at all" and must not be told to (re)draft.
function gatedDenyReason(pinMatched: boolean, draftState: 'none' | 'pending' | 'approved'): string {
  if (pinMatched) {
    return 'This call matches a payload you had approved, but it is not permitted by this '
      + "action's own allowlist — an approved draft never overrides the allowlist. Do not retry "
      + 'it, and do not try a different spelling or a workaround; the allowlist needs to grant '
      + 'this exact call before it can run.';
  }
  if (draftState === 'approved') {
    return 'An approved draft already exists for this step, but this exact call is not one of '
      + 'its remaining approved pins. Do not draft again — that costs the user a second approval '
      + 'for a payload they already approved. Run one of the calls in your envelope\'s '
      // `writeGate` sits under `typePayload` for an action-type step but at the top level for
      // an orchestrated one (no typePayload wrapper there) — say just the part that's the same
      // in both rather than a path that's wrong for whichever role reads this.
      + 'writeGate.approvedCalls verbatim instead, and do not try a different spelling or a '
      + 'workaround.';
  }
  if (draftState === 'pending') {
    return "A draft for this step is still awaiting the user's review. Wait for it to be approved "
      + 'before writing — do not attempt this call now, do not submit a second draft, and do not '
      + 'try a different spelling or a workaround.';
  }
  return "You haven't drafted this write yet. Compose the payload and call "
    + 'mcp__outpost__submit_write_draft — it runs only once the user approves it. Do not attempt '
    + 'this write directly, and do not try a different spelling or a workaround.';
}

// The pin matched the command text, but a file it references (--input/--body-file/
// --notes-file) no longer hashes the same as it did at approval — rewritten, or gone. The
// command-text match alone can't see this; verifyFileDigests is the other half of the pin.
// Told explicitly not to retry: the daemon cannot tell whether the CURRENT content is what the
// session intends, only that it differs from what the user approved, so the only safe recovery
// is a fresh draft the user gets to see.
function fileDigestMismatchReason(): string {
  return 'The file this call references has changed since the draft was approved (rewritten, '
    + 'or no longer exists) — the payload that would run is not provably the one the user '
    + 'approved. Do not retry this call. Compose a fresh draft with the current content via '
    + 'mcp__outpost__submit_write_draft and wait for a new approval.';
}

// Decides one tool call from any runtime: approval mode, then the action's pins and allowlist, else the user.
export async function gateToolCall(req: GateRequest, deps: GateDeps): Promise<GateDecision> {
  const {
    allowlist, queue, modes, cwdForSession, worktreePathForSession, actionForSession,
    gatedForAction, pinFor, onPinConsumed, draftStateFor, onGatedDenial, onNotify, onActionDenial,
    interactiveFor,
  } = deps;
  const { sessionId, tool, input } = req;
  const mode = modes.get(sessionId);
  const action = interactiveFor?.(sessionId) ? undefined : actionForSession?.(sessionId);

  // Bypass: short-circuit before any check — except for an action-bound session. A step
  // session is never put in bypass deliberately (it has no mode selector of its own), but
  // nothing stops a stray approval_mode_set / `?mode=` from reaching its session id anyway
  // (see src/ws/client-messages.ts's approval_mode_set, which has no action-bound guard);
  // that must not silently disable the write gate for the rest of the step.
  if (mode === 'bypass' && !action) return ALLOW;

  // Plan: allow read-shaped only; deny everything else with a clear reason. Plan mode
  // overrides even the allowlist — we want it to be a positive "lock the session into
  // read-only" gesture, not a "merge with allowlist" gesture. Same `!action` guard as
  // bypass below: nothing grants a gated write through PLAN_MODE_ALWAYS or a read-verb MCP
  // pattern today, but an action-bound session has no business getting Read/WebFetch/
  // WebSearch through a mode gesture instead of its own (possibly narrower) allowlist.
  if (mode === 'plan' && !action) {
    if (PLAN_MODE_ALWAYS.has(tool)) return ALLOW;
    if (isMcpTool(tool) && isPlanModeReadableMcpTool(tool)) return ALLOW;
    return deny('Plan mode — read-only');
  }

  // Accept-edits: file-mutating tools auto-allow without going through the allowlist
  // or the interactive queue. Enforced server-side so the mode works even when the PWA
  // is closed / disconnected. Action-bound sessions still fall through to allowlist
  // checking below (action steps set mode='ask' by construction).
  if (mode === 'accept-edits' && EDIT_TOOLS.has(tool) && !action) return ALLOW;

  // Action sessions run with explicit allowlist only: hit → allow, miss → deny
  // and record a denial so the user can review what was attempted. We never enqueue
  // for interactive approval because there's no human attached to an action step.
  const projectCwd = cwdForSession?.(sessionId);
  const worktreePath = worktreePathForSession?.(sessionId);
  if (action) {
    const gated = gatedForAction?.(action);
    if (gatedForAction && !gated) {
      // The registry has never heard of this action — not "inherits no gated group" (that
      // case is an all-empty ActionAllowlist, still truthy). Fail closed rather than fall
      // through to allows(), which would consult global/project/session scopes regardless of
      // whatever narrow allowlist this now-unknown action was meant to be confined to.
      const reason = `Action \`${action}\` is not recognized by the daemon right now — it may `
        + 'have been deleted or renamed while this job was running. Do not retry this or any '
        + 'other write, and do not try a workaround; stop and let the user know the job needs '
        + 'attention.';
      onGatedDenial?.(sessionId, action, reason);
      return deny(reason);
    }
    // Gated calls match the ordinary allowlist too (that's how they were auto-approved
    // before drafts existed), so this must run before the plain allows() check below or every
    // gated write would pass through unpinned. A call only runs once it BOTH matches a pin
    // from a draft the user approved AND clears allows() — a well-formed pin passes allows()
    // by construction (it only got gated because a gated rule matched it), so this only ever
    // rejects a smuggling shape the drafting/pinning path never validated (e.g. an unquoted
    // `$VAR` or a `>` redirect outside the worktree, see Critical 1 in review round 1).
    if (gated && gatedMatch(gated, tool, input)) {
      const pin = pinFor?.(sessionId, tool, input);
      const pinMatched = !!pin;
      if (!pin || !allowlist.allows(tool, input, projectCwd, action, worktreePath, sessionId)) {
        const draftState = draftStateFor?.(sessionId) ?? 'none';
        const reason = gatedDenyReason(pinMatched, draftState);
        // Only the states that indicate an actual problem are worth a journal entry.
        // 'none' (attempted before drafting) and 'pending' (attempted while awaiting the
        // user) are ordinary first-turn/impatience behavior the deny message already
        // teaches in-band — journaling every one would be noise crowding out real lessons
        // in a bounded journal. `pinMatched` (Critical 1: an approved payload that still
        // fails the allowlist) and draftState 'approved' (an approved payload the model
        // can't reproduce — including a pin it already spent) are the wedge M6 exists to
        // surface.
        if (pinMatched || draftState === 'approved') onGatedDenial?.(sessionId, action, reason);
        return deny(reason);
      }
      // The pin matched command TEXT; a file it references (--input/--body-file/
      // --notes-file) could still have been rewritten since approval — verified here, not at
      // pinFor, because pinFor's job is "which pin matches," not "is it still trustworthy," and
      // because the pin must NOT be consumed on a mismatch (returning before onPinConsumed
      // below is what guarantees that).
      if (pin.fileDigests && !(await verifyFileDigests(pin.fileDigests))) {
        const reason = fileDigestMismatchReason();
        onGatedDenial?.(sessionId, action, reason);
        return deny(reason);
      }
      onPinConsumed?.(sessionId, pin.id, req.toolUseId);
      return ALLOW;
    }
    if (allowlist.allows(tool, input, projectCwd, action, worktreePath, sessionId)) return ALLOW;
    onActionDenial?.({ actionName: action, sessionId, toolName: req.rawName, toolInput: input });
    return deny(`Not in action \`${action}\` allowlist — review the suggestion in the PWA.`);
  }

  // Ask / accept-edits (interactive sessions): consult allowlist; on miss, enqueue for
  // interactive approval.
  if (allowlist.allows(tool, input, projectCwd, action, worktreePath, sessionId)) return ALLOW;

  const decisionPromise = queue.enqueue({
    sessionId,
    tool,
    toolName: req.rawName,
    toolInput: input,
    toolUseId: req.toolUseId,
    agentId: req.subagent?.agentId,
    agentType: req.subagent?.agentType,
  });
  const pending = queue.listPending().at(-1);
  if (pending) onNotify(pending);
  const decision = await decisionPromise;
  return decision.allow ? ALLOW : { allow: false, ...(decision.reason ? { reason: decision.reason } : {}) };
}

// Not on an interrupt: whether the write landed is unknown, and a release could let it run twice.
export function onToolFailed(
  r: { sessionId: string; toolUseId?: string; tool: string; input: unknown; interrupted: boolean },
  releaseConsumedPin: (sessionId: string, toolName: string, toolInput: unknown, toolUseId?: string) => void,
): void {
  if (r.interrupted) return;
  releaseConsumedPin(r.sessionId, r.tool, r.input, r.toolUseId);
}
