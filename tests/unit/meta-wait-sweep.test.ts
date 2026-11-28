import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';

// meta.wait is gone from the registry, like it is after the upgrade; meta.session is the next step
// so advancing is observable without a real action session.
const actionRegistry = {
  getAction(name: string) {
    return name === 'meta.session' ? { frontmatter: { outpost: { runner: 'builtin' } } } : undefined;
  },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'meta-wait-sweep-'));
  const queue = new JobQueue(dir);
  const spawned: string[] = [];
  const sessionManager = {
    spawnDetached(id: string) { spawned.push(id); }, sendTurn() {}, isWorking() { return false; }, sendOrResume() {},
  } as never;
  const worktreeManager = { get: () => undefined, provision: async () => ({ path: dir }) } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never, actionRegistry, jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1_000_000,
  });
  return { engine, queue, spawned };
}

function step(id: string, action: string, extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g', action, inputs: { prompt: 'p' },
    state: 'running', workspace: { kind: 'none' }, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function seed(queue: JobQueue, engine: WorkEngine, state: JobRecord['state'], steps: ActionStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state, steps }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string, id: string) =>
  queue.get(jobId)!.steps.find((s) => s.id === id) as ActionStep;

describe('reconcileStartDelays sweeps removed meta.wait steps', () => {
  it('cancels a running or parked meta.wait and lets the plan advance without spawning for it', async () => {
    const { engine, queue, spawned } = makeEngine();
    const running = seed(queue, engine, 'executing', [step('w', 'meta.wait'), step('next', 'meta.session')]);
    const parked = seed(queue, engine, 'executing', [step('w', 'meta.wait', { state: 'waiting' }), step('next', 'meta.session')]);

    engine.reconcileStartDelays();

    for (const jobId of [running, parked]) {
      expect(stepOf(queue, jobId, 'w').cancelled).toBe(true);
      expect(queue.get(jobId)!.events?.some((e) => /meta\.wait was removed/.test(e.body ?? ''))).toBe(true);
      await vi.waitFor(() => expect(stepOf(queue, jobId, 'next').state).toBe('waiting'));
    }
    expect(spawned).toHaveLength(2);
  });

  it('lifts the halt on a job that a failed meta.wait was holding', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, 'failed', [
      step('w', 'meta.wait', { failure: { reason: 'x', at: 1 } }), step('next', 'meta.session'),
    ]);

    engine.reconcileStartDelays();

    expect(stepOf(queue, jobId, 'w').cancelled).toBe(true);
    await vi.waitFor(() => expect(queue.get(jobId)!.state).toBe('executing'));
  });

  it('leaves resolved and already-cancelled meta.wait steps as history', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, 'executing', [
      step('r', 'meta.wait', { state: 'resolved', output: '{"resumed_by":"user"}', reviewed: true }),
      step('c', 'meta.wait', { cancelled: true }),
    ]);
    const before = queue.get(jobId)!.events?.length ?? 0;

    engine.reconcileStartDelays();

    expect(stepOf(queue, jobId, 'r').state).toBe('resolved');
    expect(stepOf(queue, jobId, 'r').cancelled).toBeUndefined();
    expect(queue.get(jobId)!.events?.length ?? 0).toBe(before);
  });
});
