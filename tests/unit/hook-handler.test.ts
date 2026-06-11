import { describe, it, expect, vi } from 'vitest';
import { handleHook } from '../../src/hook-handler.js';
import { Allowlist } from '../../src/allowlist.js';
import { ApprovalQueue } from '../../src/approvals.js';
import allowlistCfg from '../../config/allowlist.json' with { type: 'json' };

describe('handleHook', () => {
  const allowlist = new Allowlist(allowlistCfg);

  it('auto-allows read-only tool calls without enqueuing', async () => {
    const queue = new ApprovalQueue({ timeoutMs: 60_000 });
    const spy = vi.spyOn(queue, 'enqueue');
    const result = await handleHook({
      hookInput: { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, session_id: 's' },
      allowlist,
      queue,
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
      onNotify: notify,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).toHaveBeenCalledOnce();
    queue.decide(queue.listPending()[0]!.id, { allow: false });
    await p;
  });
});
