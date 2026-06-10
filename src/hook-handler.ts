import type { Allowlist } from './allowlist.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';

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
  onNotify: (approval: PendingApproval) => void;
}

export async function handleHook(opts: HandleHookOpts): Promise<HookResponse> {
  const { hookInput, allowlist, queue, onNotify } = opts;
  if (allowlist.allows(hookInput.tool_name, hookInput.tool_input)) {
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    };
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
