import { describe, it, expect } from 'vitest';
import { handleHook } from '../../src/permissions/hook-handler.js';
import { ApprovalModeStore } from '../../src/permissions/approval-mode.js';

const PUSH = {
  alwaysAllow: [], alwaysAllowPathPatterns: [], alwaysAllowMcpPatterns: [],
  alwaysAllowBashPatterns: ['^git push origin [A-Za-z0-9._/-]+$'],
};

const NO_GATED = {
  alwaysAllow: [], alwaysAllowPathPatterns: [], alwaysAllowMcpPatterns: [],
  alwaysAllowBashPatterns: [],
};

function run(over: Record<string, unknown> = {}) {
  const modes = new ApprovalModeStore();
  modes.set('s1', 'ask');
  return handleHook({
    hookInput: { tool_name: 'Bash', tool_input: { command: 'rg needle' }, session_id: 's1' },
    allowlist: { allows: () => false } as never,
    queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
    modes,
    actionForSession: () => 'code.implement',
    gatedForAction: () => NO_GATED,
    interactiveFor: () => true,
    onNotify: () => {},
    ...over,
  });
}

describe('hook — an action session the user is driving', () => {
  it('enqueues an approval card on a miss instead of denying', async () => {
    const r = await run();
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('records no denial — the user steering is not the action failing', async () => {
    const denials: unknown[] = [];
    await run({ onActionDenial: (d: unknown) => denials.push(d) });
    expect(denials).toHaveLength(0);
  });

  it('still denies on a miss when the session is on autopilot', async () => {
    const denials: unknown[] = [];
    const r = await run({ interactiveFor: () => false, onActionDenial: (d: unknown) => denials.push(d) });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denials).toHaveLength(1);
  });

  it('honours plan mode, which is inert on autopilot', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'plan');
    const r = await run({
      modes,
      hookInput: { tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: 's1' },
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('Plan mode');
  });

  it('still requires a pin for a gated write — the card cannot show a --body-file body', async () => {
    const r = await run({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: 's1' },
      gatedForAction: () => PUSH,
      pinFor: () => undefined,
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('submit_write_draft');
  });

  it('does not let a stray bypass lift the write gate', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'bypass');
    const r = await run({
      modes,
      hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: 's1' },
      gatedForAction: () => PUSH,
      pinFor: () => undefined,
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
