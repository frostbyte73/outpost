import type { Allowlist } from './allowlist.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';

export interface HookInput {
  tool_name: string;
  tool_input: unknown;
  session_id: string;
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
