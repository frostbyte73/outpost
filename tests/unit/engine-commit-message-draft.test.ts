import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep, Step } from '../../src/work/work-types.js';

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-commitmsg-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }) } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue };
}

function seed(queue: JobQueue, engine: WorkEngine, step: Step): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step] }));
  engine.rehydrateSessionBindings();
  return job.id;
}

function orchestratedStep(artifacts: Record<string, string>): OrchestratedStep {
  return {
    id: 'st-1', type: 'orchestrated', title: 'Land it', description: 'd', goal: 'g',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, sessionId: 'sess-1',
    dispatches: [], inbox: [], roundsSpent: 3, consecutiveSelfRounds: 0,
    artifacts, state: 'running', createdAt: 1000, updatedAt: 1000,
  };
}

function artifactsOf(queue: JobQueue, jobId: string): Record<string, string> | undefined {
  return (queue.get(jobId)!.steps[0] as OrchestratedStep).artifacts;
}

// The commit-message draft describes UNCOMMITTED work. Every other artifact accumulates for the
// step's whole life; if this one did too, the diff viewer would pre-fill round N's message over
// round N+1's diff — the staleness the artifact exists to fix.
describe('WorkEngine.consumeCommitMessageDraft', () => {
  it('drops only the commitMessage key, leaving every other artifact intact', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, orchestratedStep({
      implementation: 'touched 3 files', spec: 'the spec', commitMessage: 'Cap tailscale CLI calls',
    }));

    engine.consumeCommitMessageDraft('sess-1');

    expect(artifactsOf(queue, jobId)).toEqual({ implementation: 'touched 3 files', spec: 'the spec' });
  });

  it('is a no-op when there is no draft, an unknown session, or a plain action step', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, orchestratedStep({ implementation: 'touched 3 files' }));
    const before = queue.get(jobId)!.updatedAt;

    engine.consumeCommitMessageDraft('sess-1');
    engine.consumeCommitMessageDraft('sess-does-not-exist');

    expect(artifactsOf(queue, jobId)).toEqual({ implementation: 'touched 3 files' });
    expect(queue.get(jobId)!.updatedAt).toBe(before);
  });
});
