import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalQueue } from '../src/approvals.js';

describe('ApprovalQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves enqueue when decide is called with matching id', async () => {
    const q = new ApprovalQueue({ timeoutMs: 60_000 });
    const pending = q.enqueue({ sessionId: 's', toolName: 'Bash', toolInput: {} });
    const ids = q.listPending();
    expect(ids).toHaveLength(1);
    q.decide(ids[0]!.id, { allow: true });
    const decision = await pending;
    expect(decision.allow).toBe(true);
  });

  it('times out to deny with reason when no decision arrives', async () => {
    const q = new ApprovalQueue({ timeoutMs: 1000 });
    const pending = q.enqueue({ sessionId: 's', toolName: 'Bash', toolInput: {} });
    vi.advanceTimersByTime(1500);
    const decision = await pending;
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/timed out/i);
  });

  it('decide on unknown id is a no-op (does not crash)', () => {
    const q = new ApprovalQueue({ timeoutMs: 60_000 });
    expect(() => q.decide('does-not-exist', { allow: true })).not.toThrow();
  });

  it('two concurrent approvals do not cross-resolve', async () => {
    const q = new ApprovalQueue({ timeoutMs: 60_000 });
    const a = q.enqueue({ sessionId: 's', toolName: 'Bash', toolInput: { cmd: 'a' } });
    const b = q.enqueue({ sessionId: 's', toolName: 'Bash', toolInput: { cmd: 'b' } });
    const ids = q.listPending();
    expect(ids).toHaveLength(2);
    q.decide(ids[0]!.id, { allow: true });
    q.decide(ids[1]!.id, { allow: false, reason: 'no' });
    const decisionA = await a;
    const decisionB = await b;
    expect(decisionA.allow).toBe(true);
    expect(decisionB.allow).toBe(false);
  });

  it('after decide, the entry leaves listPending()', () => {
    const q = new ApprovalQueue({ timeoutMs: 60_000 });
    q.enqueue({ sessionId: 's', toolName: 'Bash', toolInput: {} });
    const id = q.listPending()[0]!.id;
    q.decide(id, { allow: true });
    expect(q.listPending()).toHaveLength(0);
  });
});
