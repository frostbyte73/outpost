import { describe, it, expect, vi } from 'vitest';
import { handleHook } from '../../src/hook-handler.js';
import { Allowlist } from '../../src/allowlist.js';
import { ApprovalQueue } from '../../src/approvals.js';
import { ApprovalModeStore } from '../../src/approval-mode.js';
import allowlistCfg from '../../config/allowlist.default.json' with { type: 'json' };

describe('handleHook', () => {
  const allowlist = new Allowlist(allowlistCfg);

  it('auto-allows read-only tool calls without enqueuing', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const spy = vi.spyOn(queue, 'enqueue');
    const result = await handleHook({
      hookInput: { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, session_id: 's' },
      allowlist,
      queue,
      modes: new ApprovalModeStore(),
      onNotify: () => {},
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(spy).not.toHaveBeenCalled();
  });

  it('queues writes and resolves to allow when decided', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const promise = handleHook({
      hookInput: { tool_name: 'mcp__incident-io__incident_update', tool_input: { id: 'INC-1' }, session_id: 's' },
      allowlist,
      queue,
      modes: new ApprovalModeStore(),
      onNotify: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    const pending = queue.listPending();
    expect(pending).toHaveLength(1);
    queue.decide(pending[0]!.id, { allow: true });
    const result = await promise;
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('resolves to deny when user rejects', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const promise = handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'kubectl delete pod x' }, session_id: 's' },
      allowlist,
      queue,
      modes: new ApprovalModeStore(),
      onNotify: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    const id = queue.listPending()[0]!.id;
    queue.decide(id, { allow: false, reason: 'no thanks' });
    const result = await promise;
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('no thanks');
  });

  it('calls onNotify when enqueuing a write', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const notify = vi.fn();
    const p = handleHook({
      hookInput: { tool_name: 'mcp__claude_ai_Slack__slack_send_message', tool_input: { channel: 'C', text: 'hi' }, session_id: 's' },
      allowlist,
      queue,
      modes: new ApprovalModeStore(),
      onNotify: notify,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).toHaveBeenCalledOnce();
    queue.decide(queue.listPending()[0]!.id, { allow: false });
    await p;
  });
});

describe('handleHook — approval modes', () => {
  const allowlist = new Allowlist(allowlistCfg);

  it('bypass mode: allows any tool without enqueuing', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const spy = vi.spyOn(queue, 'enqueue');
    const modes = new ApprovalModeStore();
    modes.set('s', 'bypass');
    const result = await handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/foo' }, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(spy).not.toHaveBeenCalled();
  });

  it('plan mode: allows Read', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const modes = new ApprovalModeStore();
    modes.set('s', 'plan');
    const result = await handleHook({
      hookInput: { tool_name: 'Read', tool_input: { file_path: '/x' }, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('plan mode: denies Bash with "Plan mode" reason', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const spy = vi.spyOn(queue, 'enqueue');
    const modes = new ApprovalModeStore();
    modes.set('s', 'plan');
    const result = await handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/plan mode/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('plan mode: allows MCP read-shaped tool', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const modes = new ApprovalModeStore();
    modes.set('s', 'plan');
    const result = await handleHook({
      hookInput: { tool_name: 'mcp__github__pull_request_read', tool_input: {}, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('plan mode: denies MCP write tool', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const modes = new ApprovalModeStore();
    modes.set('s', 'plan');
    const result = await handleHook({
      hookInput: { tool_name: 'mcp__incident-io__incident_update', tool_input: {}, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ask mode (default): falls through to allowlist + queue as before', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const modes = new ApprovalModeStore();
    // Don't set anything; default is 'ask'.
    const result = await handleHook({
      hookInput: { tool_name: 'Read', tool_input: { file_path: '/x' }, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    // Read is in the default global allowlist, so it auto-allows.
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('accept-edits mode: still enqueues writes (client-side mirror auto-approves)', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const spy = vi.spyOn(queue, 'enqueue');
    const modes = new ApprovalModeStore();
    modes.set('s', 'accept-edits');
    const p = handleHook({
      hookInput: { tool_name: 'Edit', tool_input: { file_path: '/x', old_string: 'a', new_string: 'b' }, session_id: 's' },
      allowlist,
      queue,
      modes,
      onNotify: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledOnce();
    queue.decide(queue.listPending()[0]!.id, { allow: true });
    const result = await p;
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
