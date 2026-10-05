import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { OrchestratedStep, ProposedStep } from '../../src/work/work-types.js';

// Every effective pre-approval must trace to the user. The planner proposes; only plan approval,
// job creation, a schedule, or the running-step editor make a value real.

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'preapproval-authority-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }), get: () => undefined } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }), gatedFor: () => undefined, listActions: () => [] } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue };
}

const prStep = (over: Record<string, unknown> = {}): ProposedStep => ({
  type: 'orchestrated', title: 'bump', description: 'd', controller: 'code.orchestrate-pr', goal: 'g',
  workspace: { kind: 'writable', repoCwd: '/tmp/r', branch: 'deps/x' }, ...over,
} as ProposedStep);

const steps = (queue: JobQueue, id: string) => queue.get(id)!.steps as OrchestratedStep[];

describe('the planner', () => {
  it('cannot set real pre-approvals on a proposed step', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep({ preapprovals: { push: true }, specApprovedAt: 5, baseBranch: 'x' })]);
    const s = steps(queue, j.id)[0]!;
    expect(s.preapprovals).toBeUndefined();
    expect(s.specApprovedAt).toBeUndefined();
    expect(s.baseBranch).toBeUndefined();
  });

  it('cannot seed any daemon-owned step state on a new step', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep({
      pr: { prUrl: 'https://github.com/o/r/pull/57', prState: 'open' },
      artifacts: { spec: 'S', implPlan: 'P' },
      gateApproved: true,
      drafts: [{ id: 'x', action: 'code.merge-pr', raisedBy: { kind: 'controller' }, summary: 's', calls: [], requestedAt: 0, approvedAt: 1 }],
      memo: 'm', phase: 'pr_open', boundAction: 'code.merge-pr',
    })]);
    const s = steps(queue, j.id)[0]! as unknown as Record<string, unknown>;
    for (const k of ['pr', 'artifacts', 'gateApproved', 'drafts', 'memo', 'phase', 'boundAction']) expect(s[k]).toBeUndefined();
    expect(s.goal).toBe('g');
  });

  it('can propose, and the proposal is inert until the user approves the plan', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep({ proposedPreapprovals: { push: true, openPr: true } })]);
    expect(steps(queue, j.id)[0]!.preapprovals).toBeUndefined();
    expect(steps(queue, j.id)[0]!.proposedPreapprovals).toEqual({ push: true, openPr: true });
    expect(queue.get(j.id)!.state).toBe('plan_pending_review');
  });

  it('cannot widen a running step through an amendment', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep()]);
    engine.onPlanApproved(j.id);
    const id = steps(queue, j.id)[0]!.id;
    engine.onPlanReady(j.id, 'replan', [
      prStep({ keepId: id, preapprovals: { merge: true } }),
      prStep({ title: 'new', preapprovals: { push: true } }),
    ], []);
    engine.onReconciliationApproved(j.id);
    expect(steps(queue, j.id)[0]!.preapprovals).toBeUndefined();
    expect(steps(queue, j.id)[1]!.preapprovals).toBeUndefined();
  });
});

describe('plan approval', () => {
  it('writes exactly the values the user submitted', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep({ proposedPreapprovals: { push: true, openPr: true } })]);
    const id = steps(queue, j.id)[0]!.id;
    engine.onPlanApproved(j.id, { [id]: { push: true } });
    expect(steps(queue, j.id)[0]!.preapprovals).toEqual({ push: true });
  });

  it('applies the user-submitted values to an amendment, keyed by step id or proposal index', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep()]);
    engine.onPlanApproved(j.id);
    const id = steps(queue, j.id)[0]!.id;
    engine.onPlanReady(j.id, 'replan', [prStep({ keepId: id }), prStep({ title: 'new' })], []);
    engine.onReconciliationApproved(j.id, { [id]: { spec: 'auto' }, '#1': { push: true } });
    expect(steps(queue, j.id)[0]!.preapprovals).toEqual({ spec: 'auto' });
    expect(steps(queue, j.id)[1]!.preapprovals).toEqual({ push: true });
  });
});

describe('a job whose plan review is pre-approved', () => {
  it('executes without a user, clamping every proposal to the job ceiling', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({
      source: 'manual', title: 't', description: 'd',
      preapprovals: { spec: 'auto', push: true }, planReview: 'auto',
    });
    engine.onPlanReady(j.id, 'initial', [
      prStep({ proposedPreapprovals: { spec: 'skip', push: true, merge: true } }),
      prStep({ title: 'other' }),
    ]);
    expect(queue.get(j.id)!.state).toBe('executing');
    expect(steps(queue, j.id)[0]!.preapprovals).toEqual({ spec: 'auto', push: true, merge: false });
    expect(steps(queue, j.id)[1]!.preapprovals).toBeUndefined();
  });

  it('auto-applies an amendment with the same clamp', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd', preapprovals: { push: true }, planReview: 'auto' });
    engine.onPlanReady(j.id, 'initial', [prStep()]);
    const id = steps(queue, j.id)[0]!.id;
    engine.onPlanReady(j.id, 'replan', [prStep({ keepId: id }), prStep({ title: 'new', proposedPreapprovals: { openPr: true, push: true } })], []);
    expect(queue.get(j.id)!.pendingReconciliation).toBeUndefined();
    expect(steps(queue, j.id)[1]!.preapprovals).toEqual({ openPr: false, push: true });
  });
});

describe('an auto-approved amendment', () => {
  it('cannot undo a setting the user revoked on a kept step', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd', preapprovals: { merge: true }, planReview: 'auto' });
    engine.onPlanReady(j.id, 'initial', [prStep()]);
    const id = steps(queue, j.id)[0]!.id;
    engine.setStepPreapprovals(j.id, id, { merge: false });
    engine.onPlanReady(j.id, 'replan', [prStep({ keepId: id, proposedPreapprovals: { merge: true } })], []);
    expect(steps(queue, j.id)[0]!.preapprovals).toEqual({ merge: false });
  });
});

describe('the running-step editor', () => {
  it('sets and clears a step override', () => {
    const { engine, queue } = makeEngine();
    const j = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(j.id, 'initial', [prStep()]);
    const id = steps(queue, j.id)[0]!.id;
    expect(engine.setStepPreapprovals(j.id, id, { merge: true })).toBe(true);
    expect(steps(queue, j.id)[0]!.preapprovals).toEqual({ merge: true });
    engine.setStepPreapprovals(j.id, id, undefined);
    expect(steps(queue, j.id)[0]!.preapprovals).toBeUndefined();
  });
});
