// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { approvals } from '../../src/pwa/state/approvals.js';

beforeEach(() => {
  approvals.setPending([]);
  // wipe drafts / rejections / etc by reaching past the reset hook
});

describe('approvals store', () => {
  it('addPending appends and is idempotent by approvalId', () => {
    approvals.addPending({ approvalId: 'a1', toolName: 'Bash', sessionId: 's1' });
    approvals.addPending({ approvalId: 'a1', toolName: 'Bash', sessionId: 's1' });
    expect(approvals.get().pending).toHaveLength(1);
  });

  it('removePending drops by id', () => {
    approvals.addPending({ approvalId: 'a1', toolName: 'Bash', sessionId: 's1' });
    approvals.addPending({ approvalId: 'a2', toolName: 'Read', sessionId: 's1' });
    approvals.removePending('a1');
    const ids = approvals.get().pending.map((a: any) => a.approvalId);
    expect(ids).toEqual(['a2']);
  });

  it('setPending fully replaces', () => {
    approvals.addPending({ approvalId: 'a1', toolName: 'Bash', sessionId: 's1' });
    approvals.setPending([{ approvalId: 'b1', toolName: 'Edit', sessionId: 's2' }]);
    expect(approvals.get().pending.map((a: any) => a.approvalId)).toEqual(['b1']);
  });

  it('rejection draft round-trip', () => {
    approvals.setRejectionDraft('a1', 'no');
    expect(approvals.get().rejectionDrafts.get('a1')).toBe('no');
    approvals.clearRejectionDraft('a1');
    expect(approvals.get().rejectionDrafts.has('a1')).toBe(false);
  });

  it('drainDecides returns queue and resets it', () => {
    approvals.enqueueDecide({ approvalId: 'a1', decision: 'allow' });
    approvals.enqueueDecide({ approvalId: 'a2', decision: 'deny', reason: 'x' });
    const drained = approvals.drainDecides();
    expect(drained).toHaveLength(2);
    expect(approvals.get().pendingDecides).toEqual([]);
  });
});
