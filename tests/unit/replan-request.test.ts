import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { parseReplanRequest } from '../../src/work/work-launch.js';
import type { ActionStep, JobRecord, OrchestratedStep, Step } from '../../src/work/work-types.js';
import type { OrchestratorEnvelope } from '../../src/work/envelope.js';

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'replan-request-'));
  const queue = new JobQueue(dir);
  const spawned: { sessionId: string; env: Record<string, string> }[] = [];
  const closed: string[] = [];
  const journal: { action: string; outcome: string; lesson: string }[] = [];
  const engine = new WorkEngine({
    queue,
    sessionManager: {
      spawnDetached(sessionId: string, _cwd: string, env: Record<string, string>) { spawned.push({ sessionId, env }); },
      sendTurn() {}, isWorking() { return false; }, sendOrResume() {},
      async close(sid: string) { closed.push(sid); },
    } as never,
    worktreeManager: { get: () => undefined, provision: async () => ({ path: '/wt' }), archive: async () => {} } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }), listActions: () => [] } as never,
    journalStore: {
      append: (e: { action: string; outcome: string; lesson: string }) => { journal.push(e); return null; },
      recent: () => [], hasEntryForStep: () => false,
    } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  const orchestratorEnvelope = () => {
    const path = spawned.at(-1)?.env.OUTPOST_ENVELOPE;
    return path ? JSON.parse(readFileSync(path, 'utf8')) as OrchestratorEnvelope : undefined;
  };
  return { engine, queue, spawned, closed, journal, orchestratorEnvelope };
}

function actionStep(id: string, extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id, type: 'action', title: `Step ${id}`, description: '', goal: 'g', action: 'read.investigate',
    state: 'running', sessionId: `sess-${id}`, parallelGroup: 'g1',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

function controllerStep(extra: Partial<OrchestratedStep> = {}): OrchestratedStep {
  return {
    id: 'c', type: 'orchestrated', title: 'PR', description: '', goal: 'g', controller: 'code.orchestrate-pr',
    workspace: { kind: 'writable', repoCwd: '/repo', branch: 'feat/x' }, state: 'running', sessionId: 'sess-c',
    dispatches: [], inbox: [], roundsSpent: 3, consecutiveSelfRounds: 0,
    pr: { prUrl: 'https://github.com/o/r/pull/7', prState: 'open' },
    createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

function seed(queue: JobQueue, engine: WorkEngine, steps: Step[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string, id: string) => queue.get(jobId)!.steps.find((s) => s.id === id)!;

function proposeKeep(engine: WorkEngine, jobId: string) {
  engine.onPlanReady(jobId, 'replan', [{
    keepId: 'a', type: 'action', title: 'Step a', description: '', goal: 'investigate the gateway',
    action: 'read.investigate', workspace: { kind: 'none' },
  } as never]);
}

describe('replan requests', () => {
  it('parks the step and runs the planner at once, without waiting for its group', () => {
    const { engine, queue, closed, journal, orchestratorEnvelope } = makeEngine();
    const jobId = seed(queue, engine, [actionStep('a'), actionStep('b')]);

    engine.onReplanRequested(jobId, 'a', { reason: 'the bug is in the gateway', evidence: 'gw.go:12' });

    const a = stepOf(queue, jobId, 'a');
    expect(a.state).toBe('replan_requested');
    expect(a.replanRequest).toMatchObject({ reason: 'the bug is in the gateway', evidence: 'gw.go:12' });
    expect(stepOf(queue, jobId, 'b').state).toBe('running');
    expect(queue.get(jobId)!.state).toBe('planning');
    expect(closed).toContain('sess-a');
    expect(journal).toEqual([expect.objectContaining({ action: 'meta.orchestrate', outcome: 'replan-requested' })]);
    expect(orchestratorEnvelope()).toMatchObject({
      mode: 'replan',
      replanRequest: { stepId: 'a', action: 'read.investigate', reason: 'the bug is in the gateway', evidence: 'gw.go:12' },
    });
  });

  it('takes a controller replan with an open PR, but not while a dispatch is in flight', () => {
    const { engine, queue } = makeEngine();
    const running = { id: 'd1', action: 'code.review-diff', brief: 'b', status: 'running' as const, attempts: 1 };
    const jobId = seed(queue, engine, [controllerStep({ dispatches: [running] })]);
    const replan = { kind: 'replan' as const, reason: 'the PR targets the wrong service' };

    engine.onStepProgress(jobId, 'c', { memo: 'm1', next: replan });
    expect(stepOf(queue, jobId, 'c').state).toBe('running');
    expect((stepOf(queue, jobId, 'c') as OrchestratedStep).lastDelivered).toEqual([
      expect.objectContaining({ kind: 'policy-rejection', reason: expect.stringMatching(/dispatch\(es\) still in flight/) }),
    ]);

    queue.mutate(jobId, (j) => ({
      ...j,
      steps: j.steps.map((s) => s.type === 'orchestrated'
        ? { ...s, pendingRound: undefined, dispatches: [{ ...running, status: 'done' as const }] } : s),
    }));
    engine.onStepProgress(jobId, 'c', { memo: 'm2', next: replan });

    const c = stepOf(queue, jobId, 'c') as OrchestratedStep;
    expect(c.state).toBe('replan_requested');
    expect(c.memo).toBe('m2');
    expect(queue.get(jobId)!.state).toBe('planning');
  });

  it('refuses a dispatched child that passes its dispatch id as stepId', () => {
    const child = { id: 'd1', action: 'code.review-diff', brief: 'b', status: 'running' as const, attempts: 1, sessionId: 'child-sess' };
    const job = { steps: [controllerStep({ dispatches: [child] })] } as unknown as JobRecord;

    expect(parseReplanRequest(job, { stepId: 'd1', reason: 'r' })).toMatch(/dispatched child/);
    expect(parseReplanRequest(job, { stepId: 'c', reason: 'r' })).toMatch(/kind: "replan"/);
  });

  it.each([
    ['the planner keeps the plan', (e: WorkEngine, id: string) => e.onOrchestratorContinue(id, 'plan holds'), 'the planner kept the plan'],
    ['the amendment is discarded', (e: WorkEngine, id: string) => { proposeKeep(e, id); e.onReconciliationDiscarded(id); }, 'the amendment was discarded'],
  ])('fails the requester when %s, so the job halts instead of stalling', async (_name, settle, why) => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [actionStep('a', { parallelGroup: undefined })]);
    engine.onReplanRequested(jobId, 'a', { reason: 'wrong repo' });

    settle(engine, jobId);
    await new Promise((r) => setTimeout(r, 0));

    const a = stepOf(queue, jobId, 'a');
    expect(a).toMatchObject({ state: 'failed', failure: { reason: `replan request not taken: ${why}` } });
    expect(a.replanRequest).toBeUndefined();
    expect(queue.get(jobId)!.state).toBe('failed');
  });

  it('a repeat Discard leaves a requester the reopened planner is still answering', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [actionStep('a', { parallelGroup: undefined })]);
    engine.onReplanRequested(jobId, 'a', { reason: 'wrong repo' });
    proposeKeep(engine, jobId);

    engine.onReconciliationDiscarded(jobId, 'try again');
    engine.onReconciliationDiscarded(jobId);

    expect(stepOf(queue, jobId, 'a').state).toBe('replan_requested');
    expect(queue.get(jobId)!.state).toBe('planning');
  });

  it('a kept step re-runs with the request as an attempt, and a second request fails it', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [actionStep('a', { parallelGroup: undefined })]);
    engine.onReplanRequested(jobId, 'a', { reason: 'wrong repo', suggestion: 'point it at gateway' });

    proposeKeep(engine, jobId);
    engine.onReconciliationApproved(jobId);

    const kept = stepOf(queue, jobId, 'a');
    expect(kept.state).toBe('running');
    expect(kept.goal).toBe('investigate the gateway');
    expect(kept.replanRequest).toBeUndefined();
    expect(kept.attempts).toEqual([
      { at: 1000, kind: 'replan', failure: 'asked for a replan: wrong repo', note: 'point it at gateway' },
    ]);

    engine.onReplanRequested(jobId, 'a', { reason: 'still the wrong repo' });
    expect(stepOf(queue, jobId, 'a').failure?.reason).toBe('asked for a replan twice: still the wrong repo');
  });
});
