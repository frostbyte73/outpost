import type {
  HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput,
  PostToolUseFailureHookInput, PostToolUseHookInput, StopFailureHookInput, StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { gateToolCall, onToolFailed, type GateDeps } from '../../permissions/gate.js';
import { canonicalToolName } from '../tools.js';
import type { GateDecision, GateRequest, RuntimeHost } from '../types.js';

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
    updatedInput?: Record<string, unknown>;
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

// A hook that throws or runs out of time is a non-blocking error to Claude Code, which would run the call ungated
export function gatedPreToolUse(decide: (h: HookInput) => Promise<HookResponse> | HookResponse, deadlineMs: number): HookCallback {
  return async (input) => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<HookResponse>((resolve) => {
      timer = setTimeout(() => resolve(denyResp('Outpost\'s permission gate did not answer in time, so this call was not run.')), deadlineMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => decide(input as HookInput)), deadline]);
    } catch (e) {
      console.error('[hook] gate threw:', (e as Error).stack);
      return denyResp('Outpost\'s permission gate failed on this call, so it was not run.');
    } finally {
      clearTimeout(timer);
    }
  };
}

// `waitMs` is the longest the gate may legitimately take (an approval); the SDK's timer must outlast it.
export function gateMatcher(waitMs: number, decide: (h: HookInput) => Promise<HookResponse> | HookResponse): HookCallbackMatcher {
  const timeoutS = Math.ceil(waitMs / 1000) + 60;
  return { timeout: timeoutS, onFailure: 'block', hooks: [gatedPreToolUse(decide, (timeoutS - 10) * 1000)] };
}

function on<T>(fn: (input: T) => void): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    fn(input as T);
    return {};
  };
}

// Claude Code's hooks as in-process RuntimeHost calls.
export function claudeHooks(
  host: RuntimeHost,
  opts: { isAction: boolean; approvalTimeoutMs: number },
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [gateMatcher(opts.approvalTimeoutMs, async (h) => {
      console.log(`[hook] ${h.tool_name} session=${h.session_id?.slice(0,8)}${h.agent_id ? ` agent=${h.agent_type ?? '?'}/${h.agent_id.slice(0,8)}` : ''} input=${JSON.stringify(h.tool_input).slice(0, 200)}`);
      return toHookResponse(await host.gateToolCall(toGateRequest(h)));
    })],
    // Only tools whose responses can be recorded for eval replay; failures have their own event.
    ...(opts.isAction ? {
      PostToolUse: [{
        matcher: 'Bash|WebFetch|WebSearch|mcp__.*',
        hooks: [on<PostToolUseHookInput>((i) => host.onToolCompleted({
          sessionId: i.session_id,
          tool: canonicalToolName(i.tool_name),
          rawName: i.tool_name,
          input: i.tool_input,
          response: i.tool_response,
        }))],
      }],
    } : {}),
    PostToolUseFailure: [{
      hooks: [on<PostToolUseFailureHookInput>((i) => {
        const req = toFailedRequest(i);
        if (req) host.onToolFailed(req);
      })],
    }],
    Stop: [{ hooks: [on<StopHookInput>((i) => host.onTurnEnded(i.session_id))] }],
    // Fires instead of Stop when an API error ended the turn — without it that turn never ends.
    StopFailure: [{
      hooks: [on<StopFailureHookInput>((i) => host.onTurnFailed(i.session_id, i.error, i.error_details))],
    }],
  };
}
