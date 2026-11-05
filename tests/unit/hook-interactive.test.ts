import { describe, it, expect } from 'vitest';
import { handleHook } from '../../src/runtime/claude/hooks.js';
import { ApprovalModeStore } from '../../src/permissions/approval-mode.js';

const PUSH = {
  alwaysAllow: [], alwaysAllowPathPatterns: [], alwaysAllowMcpPatterns: [],
  alwaysAllowBashPatterns: ['^git push origin [A-Za-z0-9._/-]+$'],
};

function run(over: Record<string, unknown> = {}) {
  const modes = new ApprovalModeStore();
  modes.set('s1', 'ask');
  return handleHook({
    hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: 's1' },
    allowlist: { allows: () => false } as never,
    queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
    modes,
    actionForSession: () => 'code.implement',
    gatedForAction: () => PUSH,
    pinFor: () => undefined,
    interactiveFor: () => true,
    onNotify: () => {},
    ...over,
  });
}

describe('hook — an action session the user is driving', () => {
  it('gates as a manual session: no action scope, a miss raises a card, nothing recorded', async () => {
    const scopes: unknown[] = [];
    const denials: unknown[] = [];
    const enqueued: unknown[] = [];
    const r = await run({
      allowlist: { allows: (...a: unknown[]) => { scopes.push(a[3]); return false; } } as never,
      queue: { enqueue: async (a: unknown) => { enqueued.push(a); return { allow: true }; }, listPending: () => [] } as never,
      onActionDenial: (d: unknown) => denials.push(d),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(scopes).toEqual([undefined]);
    expect(enqueued).toHaveLength(1);
    expect(denials).toHaveLength(0);
  });

  it('honours bypass', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'bypass');
    const r = await run({ modes, queue: { enqueue: async () => ({ allow: false }), listPending: () => [] } as never });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('honours plan mode', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'plan');
    const r = await run({ modes, hookInput: { tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: 's1' } });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('Plan mode');
  });
});

describe('hook — the same session once handed back', () => {
  it('denies an unpinned gated write and ignores bypass', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'bypass');
    const r = await run({ modes, interactiveFor: () => false, allowlist: { allows: () => true } as never });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies a miss and records it against the action', async () => {
    const denials: unknown[] = [];
    const r = await run({
      interactiveFor: () => false,
      gatedForAction: () => ({ ...PUSH, alwaysAllowBashPatterns: [] }),
      onActionDenial: (d: unknown) => denials.push(d),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denials).toHaveLength(1);
  });
});
