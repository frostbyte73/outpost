import { describe, it, expect, vi } from 'vitest';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { claudeHooks, gatedPreToolUse } from '../../src/runtime/claude/hooks.js';
import type { RuntimeHost } from '../../src/runtime/types.js';

const opts = { signal: new AbortController().signal };
const preTool = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push' } } as never;

// Claude Code reads a hook that throws or runs out of time as a non-blocking error and runs the call, past every pin.
describe('gatedPreToolUse', () => {
  it('denies the call when the gate throws', async () => {
    const hook = gatedPreToolUse(() => { throw new Error('store unavailable'); }, 1000);
    expect(await hook(preTool, 'tu-1', opts)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('denies the call when the gate has not answered by its deadline', async () => {
    const hook = gatedPreToolUse(() => new Promise(() => {}), 5);
    expect(await hook(preTool, 'tu-1', opts)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

// The event names and field mappings are what the old HTTP settings once got wrong without a test noticing.
describe('claudeHooks', () => {
  const host = () => ({
    gateToolCall: vi.fn(), onToolFailed: vi.fn(), onToolCompleted: vi.fn(),
    onTurnEnded: vi.fn(), onTurnFailed: vi.fn(), onUsage: vi.fn(),
  }) satisfies RuntimeHost;
  const fire = (m: HookCallbackMatcher[] | undefined, input: object) => m![0]!.hooks[0]!(input as never, undefined, opts);

  it('releases a failed call by its tool_use_id, and keeps an interrupted one spent', async () => {
    const h = host();
    const hooks = claudeHooks(h, { isAction: false, approvalTimeoutMs: 1000 });
    await fire(hooks.PostToolUseFailure, { session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'tu-9', error: 'x' });
    await fire(hooks.PostToolUseFailure, { session_id: 's', tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu-10', error: 'x', is_interrupt: true });
    expect(h.onToolFailed).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: 's', toolUseId: 'tu-9', interrupted: false }));
    expect(h.onToolFailed).toHaveBeenNthCalledWith(2, expect.objectContaining({ toolUseId: 'tu-10', interrupted: true }));
  });

  it('ends the turn on Stop and fails it on StopFailure', async () => {
    const h = host();
    const hooks = claudeHooks(h, { isAction: false, approvalTimeoutMs: 1000 });
    await fire(hooks.Stop, { session_id: 's' });
    await fire(hooks.StopFailure, { session_id: 's', error: 'authentication_failed', error_details: 'expired' });
    expect(h.onTurnEnded).toHaveBeenCalledWith('s');
    expect(h.onTurnFailed).toHaveBeenCalledWith('s', 'authentication_failed', 'expired');
  });
});
