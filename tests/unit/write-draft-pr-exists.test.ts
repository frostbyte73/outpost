import { describe, it, expect } from 'vitest';
import { submitDraft, type DraftHost } from '../../src/work/write-draft-runner.js';
import type { JobRecord, OrchestratedStep, Step } from '../../src/work/work-types.js';
import type { PinnedCall, WriteDraft } from '../../src/work/write-draft.js';

// Row 8 of code.orchestrate-pr opens the PR, and `pr.prUrl` is its falsifier. A controller that
// re-walks the ladder from its memo rather than from the envelope takes the row anyway: the
// observed case drafted `gh pr create` on a turn whose envelope already carried the PR's URL,
// its `open` state and a `headRefOid` equal to the controller's own HEAD, woken by a delivery
// that read "PR open". The card reaches the user every time they open the PR themselves, and
// denying is their only recourse. These pin the refusal, and the two shapes it must not eat.

const NOW = 1_700_000_000_000;

function harness(step: Step) {
  let cur: Step = step;
  const host: DraftHost = {
    now: () => NOW,
    newId: () => 'd1',
    getJob: (): JobRecord => ({
      id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
      orchestratorAction: 'meta.orchestrate', steps: [cur], createdAt: 0, updatedAt: 0,
    }),
    getStep: () => cur,
    mutateStep: (_j, _s, fn) => { cur = fn(cur); },
    appendStepEvent: () => {},
    resumeRaiser: () => {},
    settleDispatch: () => {},
    notifyControllerDenied: () => {},
    declineStep: () => {},
    journal: () => {},
  };
  return { host, step: () => cur };
}

function stepWith(pr: OrchestratedStep['pr']): OrchestratedStep {
  return {
    id: 's1', type: 'orchestrated', title: 'ship it', description: '',
    controller: 'code.orchestrate-pr', goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'fix/thing' },
    boundAction: 'code.orchestrate-pr', dispatches: [], inbox: [],
    roundsSpent: 28, consecutiveSelfRounds: 0,
    state: 'running', sessionId: 'sess1', createdAt: 0, updatedAt: 0, pr,
  };
}

function draft(calls: PinnedCall[]): Omit<WriteDraft, 'id' | 'requestedAt'> {
  return {
    action: 'code.orchestrate-pr', raisedBy: { kind: 'controller' },
    summary: 'Open a PR for fix/thing against main', calls,
  };
}

const openPr: PinnedCall = {
  id: 'c1', label: 'open PR',
  bash: 'gh pr create --repo livekit/egress --base main --head fix/thing --title "Fix it" --body-file /tmp/b.md',
};

describe('drafting a PR that already exists', () => {
  it('is refused, naming the PR the step already has', () => {
    const h = harness(stepWith({ prUrl: 'https://github.com/livekit/egress/pull/1411', prState: 'open' }));

    const res = submitDraft(h.host, 'j1', 's1', draft([openPr]));

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('egress/pull/1411');
    expect(h.step().drafts ?? []).toHaveLength(0);
    expect(h.step().state).toBe('running');
  });

  it('still allows the row-8 draft the step is actually for', () => {
    const h = harness(stepWith(undefined));

    expect(submitDraft(h.host, 'j1', 's1', draft([openPr]))).toEqual({ ok: true });
    expect(h.step().state).toBe('gate_pending_approval');
  });

  it('leaves every other write against an open PR alone', () => {
    const h = harness(stepWith({ prUrl: 'https://github.com/livekit/egress/pull/1411', prState: 'open' }));
    const merge: PinnedCall = { id: 'c1', label: 'merge', bash: 'gh pr merge 1411 --squash' };

    expect(submitDraft(h.host, 'j1', 's1', draft([merge]))).toEqual({ ok: true });
  });
});
