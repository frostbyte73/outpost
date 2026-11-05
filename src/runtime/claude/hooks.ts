import { gateToolCall, onToolFailed, type GateDeps } from '../../permissions/gate.js';
import { parseJsonObject } from '../../routes/util.js';
import { canonicalToolName } from '../tools.js';
import type { GateDecision, GateRequest, RuntimeHost, StatuslineUsage } from '../types.js';

export interface HookInput {
  tool_name: string;
  tool_input: unknown;
  session_id: string;
  // Claude's id for the tool_use block this hook is gating.
  tool_use_id?: string;
  // Set by Claude Code for tool calls coming from a subagent; absent for the parent's own calls.
  agent_id?: string;
  agent_type?: string;
}

export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: unknown;
  };
}

// A Bash non-zero exit (a rejected `git push` included) fires PostToolUseFailure, not PostToolUse
export interface PostToolFailureHookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  // The same id PreToolUse saw for this call, so the release targets the pin this call spent.
  tool_use_id?: string;
  error?: string;
  // An abort cut the call short, so whether the write landed is unknown — the pin stays spent.
  is_interrupt?: boolean;
}

export type HandleHookOpts = GateDeps & { hookInput: HookInput };

export function denyResp(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function toGateRequest(h: HookInput): GateRequest {
  return {
    sessionId: h.session_id,
    tool: canonicalToolName(h.tool_name),
    rawName: h.tool_name,
    input: h.tool_input,
    ...(h.tool_use_id ? { toolUseId: h.tool_use_id } : {}),
    ...(h.agent_id ? { subagent: { agentId: h.agent_id, ...(h.agent_type ? { agentType: h.agent_type } : {}) } } : {}),
  };
}

export function toHookResponse(d: GateDecision): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.allow ? 'allow' : 'deny',
      ...(!d.allow && d.reason ? { permissionDecisionReason: d.reason } : {}),
    },
  };
}

// The PreToolUse hook's answer: the gate's decision on this call, in Claude's response shape.
export async function handleHook(opts: HandleHookOpts): Promise<HookResponse> {
  const { hookInput, ...deps } = opts;
  return toHookResponse(await gateToolCall(toGateRequest(hookInput), deps));
}

export function handlePostToolFailureHook(
  input: PostToolFailureHookInput,
  releaseConsumedPin: (sessionId: string, toolName: string, toolInput: unknown, toolUseId?: string) => void,
): void {
  const req = toFailedRequest(input);
  if (req) onToolFailed(req, releaseConsumedPin);
}

function toFailedRequest(input: PostToolFailureHookInput) {
  if (!input.session_id || !input.tool_name) return undefined;
  return {
    sessionId: input.session_id,
    tool: canonicalToolName(input.tool_name),
    input: input.tool_input,
    interrupted: !!input.is_interrupt,
    ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
  };
}

// Schema: https://code.claude.com/docs/en/statusline#available-data.
interface StatusLinePayload {
  session_id?: string;
  model?: StatuslineUsage['model'];
  context_window?: unknown;
  cost?: StatuslineUsage['cost'];
  rate_limits?: unknown;
  effort?: unknown;
  exceeds_200k_tokens?: boolean;
}

function parseBody<T>(body: string): T {
  const payload = parseJsonObject(body);
  if (!payload) throw new Error('invalid json body');
  return payload as T;
}

// Claude Code's hooks as RuntimeHost calls; `evalPreTool` answers an eval replay session's PreToolUse instead.
export function claudeHookHandlers(host: RuntimeHost, evalPreTool: (h: HookInput) => HookResponse | undefined) {
  return {
    onPreToolHook: async (body: string): Promise<string> => {
      const h = parseBody<HookInput>(body);
      console.log(`[hook] ${h.tool_name} session=${h.session_id?.slice(0,8)}${h.agent_id ? ` agent=${h.agent_type ?? '?'}/${h.agent_id.slice(0,8)}` : ''} input=${JSON.stringify(h.tool_input).slice(0, 200)}`);
      const replayed = evalPreTool(h);
      if (replayed) return JSON.stringify(replayed);
      return JSON.stringify(toHookResponse(await host.gateToolCall(toGateRequest(h))));
    },
    onPostToolFailureHook: async (body: string): Promise<string> => {
      const req = toFailedRequest(parseBody<PostToolFailureHookInput>(body));
      if (req) host.onToolFailed(req);
      return '{}';
    },
    onPostToolHook: async (body: string): Promise<void> => {
      const input = parseBody<{ session_id?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown }>(body);
      if (!input.session_id || !input.tool_name) return;
      host.onToolCompleted({
        sessionId: input.session_id,
        tool: canonicalToolName(input.tool_name),
        rawName: input.tool_name,
        input: input.tool_input,
        response: input.tool_response,
      });
    },
    onStopHook: async (body: string): Promise<void> => {
      const { session_id } = parseBody<{ session_id?: string }>(body);
      if (session_id) host.onTurnEnded(session_id);
    },
    // Fired by Claude Code INSTEAD of Stop when an API error ended the turn.
    onStopFailureHook: async (body: string): Promise<void> => {
      const p = parseBody<{ session_id?: string; error?: string; error_details?: string }>(body);
      if (p.session_id) host.onTurnFailed(p.session_id, p.error ?? 'unknown', p.error_details);
    },
    onStatusLineHook: async (body: string): Promise<void> => {
      const p = parseBody<StatusLinePayload>(body);
      if (!p.session_id) return;
      host.onUsage(p.session_id, {
        statusline: {
          model: p.model,
          contextWindow: p.context_window,
          cost: p.cost,
          rateLimits: p.rate_limits,
          effort: p.effort,
          exceeds200k: p.exceeds_200k_tokens,
        },
      });
    },
  };
}
