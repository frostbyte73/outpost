import { describe, it, expect, vi } from 'vitest';
import { submitDraft, type DraftHost } from '../../src/work/write-draft-runner.js';
import type { JobRecord, OrchestratedStep, Preapprovals, Step } from '../../src/work/work-types.js';
import type { PinnedCall, WriteDraft } from '../../src/work/write-draft.js';

// A pre-approval replaces the user's click, never the pin: the daemon calls acceptDraft itself
// with the drafted calls, so everything below the decision is the same path a manual Accept takes.

const SHA = 'b'.repeat(40);

function harness(step: Step, jobPre?: Preapprovals, readiness?: string | Error, global?: { pre?: Preapprovals; merging?: boolean }) {
  let cur: Step = step;
  const resumeRaiser = vi.fn();
  const events: string[] = [];
  const host: DraftHost = {
    now: () => 1000,
    newId: (() => { let n = 0; return () => `d${++n}`; })(),
    getJob: (): JobRecord => ({
      id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
      steps: [cur], createdAt: 0, updatedAt: 0, ...(jobPre ? { preapprovals: jobPre } : {}),
    }),
    getStep: () => cur,
    mutateStep: (_j, _s, fn) => { cur = fn(cur); },
    appendStepEvent: (_j, _s, _who, body) => { events.push(body); },
    resumeRaiser,
    settleDispatch: () => {},
    notifyControllerDenied: () => {},
    declineStep: () => {},
    journal: () => {},
    mergeReadiness: async () => {
      if (readiness instanceof Error) throw readiness;
      return readiness;
    },
    preapprovalDefaults: () => global?.pre,
    mergingFromBase: async () => global?.merging ?? false,
  };
  return { host, step: () => cur, resumeRaiser, events };
}

function step(over: Partial<OrchestratedStep> = {}): OrchestratedStep {
  return {
    id: 's1', type: 'orchestrated', title: 'bump', description: '', controller: 'code.orchestrate-pr', goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'deps/bump-ws' }, baseBranch: 'main',
    boundAction: 'code.orchestrate-pr', dispatches: [], inbox: [], roundsSpent: 3, consecutiveSelfRounds: 0,
    state: 'running', sessionId: 'sess1', createdAt: 0, updatedAt: 0, ...over,
  };
}

const draft = (calls: PinnedCall[], action = 'code.orchestrate-pr'): Omit<WriteDraft, 'id' | 'requestedAt'> =>
  ({ action, raisedBy: { kind: 'controller' }, summary: 's', calls });

const push: PinnedCall = { id: 'c1', label: 'push', bash: 'git push -u origin deps/bump-ws' };
const prCreate: PinnedCall = { id: 'c2', label: 'open PR', bash: 'gh pr create --base main --head deps/bump-ws --title t --body b' };
const merge: PinnedCall = { id: 'c3', label: 'merge', bash: `gh pr merge 42 --squash --match-head-commit ${SHA}` };
const withPr = { pr: { prUrl: 'https://github.com/livekit/agents-js/pull/42', prState: 'open' as const } };

describe('a step with no pre-approvals', () => {
  it('parks the draft exactly as before', async () => {
    const h = harness(step());
    expect(await submitDraft(h.host, 'j1', 's1', draft([push]))).toEqual({ ok: true });
    expect(h.step().state).toBe('gate_pending_approval');
    expect(h.step().drafts![0]!.approvedAt).toBeUndefined();
    expect(h.step().drafts![0]!.autoApproveMiss).toBeUndefined();
  });
});

describe('a merge from the base under the Settings default', () => {
  const calls: PinnedCall[] = [
    { id: 'm1', label: 'commit', bash: 'git commit --no-edit' },
    { id: 'm2', label: 'push', bash: 'git push origin deps/bump-ws' },
  ];

  it('is auto-approved while the merge is in progress', async () => {
    const h = harness(step(), undefined, undefined, { pre: { syncBase: true }, merging: true });
    expect(await submitDraft(h.host, 'j1', 's1', draft(calls, 'code.resolve-conflicts'))).toEqual({ ok: true, autoApproved: true });
  });

  it('reaches the user when the job turns syncBase off', async () => {
    const h = harness(step(), { syncBase: false }, undefined, { pre: { syncBase: true }, merging: true });
    expect(await submitDraft(h.host, 'j1', 's1', draft(calls, 'code.resolve-conflicts'))).toEqual({ ok: true });
  });
});

describe('a covered draft', () => {
  it('is approved by the daemon, marked as such, and resumes the raiser', async () => {
    const h = harness(step(), { push: true, openPr: true });
    expect(await submitDraft(h.host, 'j1', 's1', draft([push, prCreate]))).toEqual({ ok: true, autoApproved: true });
    const d = h.step().drafts![0]!;
    expect(d.approvedAt).toBe(1000);
    expect(d.approvedBy).toBe('preapproval');
    expect(d.calls.map((c) => c.bash)).toEqual([push.bash, prCreate.bash]);
    expect(h.step().state).toBe('running');
    expect(h.resumeRaiser).toHaveBeenCalledOnce();
    expect(h.events.at(-1)).toBe('auto-approved (push, openPr): push, open PR');
  });

  it('honours a step override that turns a job setting off', async () => {
    const h = harness(step({ preapprovals: { openPr: false } }), { push: true, openPr: true });
    await submitDraft(h.host, 'j1', 's1', draft([prCreate]));
    expect(h.step().state).toBe('gate_pending_approval');
  });
});

describe('a draft that is not fully covered', () => {
  it('goes to the user whole, with the reason recorded', async () => {
    const issue: PinnedCall = { id: 'c9', label: 'comment issue', bash: 'gh issue comment 5 --body hi' };
    const h = harness(step(), { push: true });
    expect(await submitDraft(h.host, 'j1', 's1', draft([push, issue]))).toEqual({ ok: true });
    const d = h.step().drafts![0]!;
    expect(d.approvedAt).toBeUndefined();
    expect(d.autoApproveMiss).toContain('comment issue');
    expect(h.step().state).toBe('gate_pending_approval');
    expect(h.resumeRaiser).not.toHaveBeenCalled();
  });
});

describe('a pre-approved merge', () => {
  it('is approved when the fresh readiness check passes', async () => {
    const h = harness(step(withPr), { merge: true }, undefined);
    expect(await submitDraft(h.host, 'j1', 's1', draft([merge], 'code.merge-pr'))).toEqual({ ok: true, autoApproved: true });
  });

  it('goes to the user when the readiness check names a blocker', async () => {
    const h = harness(step(withPr), { merge: true }, 'review is CHANGES_REQUESTED');
    await submitDraft(h.host, 'j1', 's1', draft([merge], 'code.merge-pr'));
    expect(h.step().drafts![0]!.autoApproveMiss).toContain('CHANGES_REQUESTED');
  });

  it('goes to the user, not a throw, when the readiness check itself fails', async () => {
    const h = harness(step(withPr), { merge: true }, new Error('gh: timeout'));
    await expect(submitDraft(h.host, 'j1', 's1', draft([merge], 'code.merge-pr'))).resolves.toEqual({ ok: true });
    expect(h.step().drafts![0]!.autoApproveMiss).toContain('gh: timeout');
  });
});

describe('drafts that are never auto-approved', () => {
  it('leaves an action step alone', async () => {
    const h = harness({
      id: 's1', type: 'action', title: 't', description: '', action: 'write.linear-comment', goal: 'g',
      workspace: { kind: 'none' }, state: 'running', sessionId: 'x', createdAt: 0, updatedAt: 0,
    }, { push: true });
    await submitDraft(h.host, 'j1', 's1', { ...draft([push]), raisedBy: { kind: 'step' } });
    expect(h.step().state).toBe('gate_pending_approval');
    expect(h.resumeRaiser).not.toHaveBeenCalled();
  });
});
