import type { Allowlist } from './allowlist.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';
import { ApprovalModeStore, PLAN_MODE_ALWAYS, isPlanModeReadableMcpTool } from './approval-mode.js';

export interface HookInput {
  tool_name: string;
  tool_input: unknown;
  session_id: string;
  // Claude's stream-json id for the tool_use block this hook is gating. We forward it
  // to the PWA so the client can match an approval-card decision against the eventual
  // tool_use entry that arrives over the session WS (used by the "expand-by-default
  // unless user approved" logic).
  tool_use_id?: string;
  // Claude Code's PreToolUse hook sets these for tool calls coming from a subagent
  // (Explore / general-purpose / etc.). Absent for the parent session's own calls.
  // We pass them through so the PWA can route subagent approvals into a dedicated
  // agents feed instead of mixing them into the parent transcript.
  agent_id?: string;
  agent_type?: string;
}

export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

export interface HandleHookOpts {
  hookInput: HookInput;
  allowlist: Allowlist;
  queue: ApprovalQueue;
  modes: ApprovalModeStore;
  // Lookup a session's cwd for project-scoped allowlist resolution. Returns undefined
  // if the session is unknown to the daemon (e.g. brand-new); allowlist then falls back
  // to global rules only.
  cwdForSession?: (sessionId: string) => string | undefined;
  onNotify: (approval: PendingApproval) => void;
}

function allowResp(): HookResponse {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}

function denyResp(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export async function handleHook(opts: HandleHookOpts): Promise<HookResponse> {
  const { hookInput, allowlist, queue, modes, cwdForSession, onNotify } = opts;
  const mode = modes.get(hookInput.session_id);

  // Bypass: short-circuit before any check. Equivalent to --dangerously-skip-permissions.
  if (mode === 'bypass') return allowResp();

  // Plan: allow read-shaped only; deny everything else with a clear reason. Plan mode
  // overrides even the allowlist — we want it to be a positive "lock the session into
  // read-only" gesture, not a "merge with allowlist" gesture.
  if (mode === 'plan') {
    if (PLAN_MODE_ALWAYS.has(hookInput.tool_name)) return allowResp();
    if (hookInput.tool_name.startsWith('mcp__') && isPlanModeReadableMcpTool(hookInput.tool_name)) {
      return allowResp();
    }
    return denyResp('Plan mode — read-only');
  }

  // Ask / accept-edits: consult allowlist (global ∪ project). Accept-edits handling
  // for Edit/Write/etc. is client-side in the PWA today (mirror); it auto-resolves the
  // approval after enqueue. The server side just enqueues normally for those tools.
  const projectCwd = cwdForSession?.(hookInput.session_id);
  if (allowlist.allows(hookInput.tool_name, hookInput.tool_input, projectCwd)) {
    return allowResp();
  }

  const decisionPromise = queue.enqueue({
    sessionId: hookInput.session_id,
    toolName: hookInput.tool_name,
    toolInput: hookInput.tool_input,
    toolUseId: hookInput.tool_use_id,
    agentId: hookInput.agent_id,
    agentType: hookInput.agent_type,
  });
  const pending = queue.listPending().at(-1);
  if (pending) onNotify(pending);

  const decision = await decisionPromise;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
}
