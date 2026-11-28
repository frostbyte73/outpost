import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine, WaitSessionError } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord, ProposedStep } from '../../src/work/work-types.js';

// The delayed step is a meta.session so "started" is observable without a real action session:
// its builtin runner parks it in `waiting` the moment it starts.
const actionRegistry = {
  getAction(name: string) {
    return { frontmatter: { outpost: { runner: name.startsWith('meta.') ? 'builtin' : 'claude' } } };
  },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-step-delay-'));
  const queue = new JobQueue(dir);
  const clock = { now: 1_000_000 };
  const sessionManager = {
    spawnDetached() {}, sendTurn() {}, isWorking() { return false; }, sendOrResume() {},
  } as never;
  const worktreeManager = { get: () => undefined, provision: async () => ({ path: dir }) } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => clock.now,
  });
  return { engine, queue, clock };
}

function done(id: string): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g', action: 'read.investigate',
    state: 'resolved', output: '{}', reviewed: true, workspace: { kind: 'none' }, createdAt: 1, updatedAt: 1,
  };
}

function delayed(id: string, delaySec: number, extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g', action: 'meta.session',
    inputs: { prompt: 'check it' }, state: 'running', delaySec,
    workspace: { kind: 'none' }, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function seed(queue: JobQueue, engine: WorkEngine, steps: ActionStep[], extra: Partial<JobRecord> = {}): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps, ...extra }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string, id: string) =>
  queue.get(jobId)!.steps.find((s) => s.id === id) as ActionStep;

afterEach(() => { vi.useRealTimers(); });

describe('delaySec', () => {
  it('stamps startAt when the step becomes next, and starts it only once that passes', async () => {
    const { engine, queue, clock } = makeEngine();
    const jobId = seed(queue, engine, [done('a'), delayed('b', 60)]);

    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'b').startAt).toBe(1_000_000 + 60_000);
    expect(stepOf(queue, jobId, 'b').state).toBe('running');

    clock.now += 59_000;
    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'b').state).toBe('running');

    clock.now += 2_000;
    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'b').state).toBe('waiting');
    expect(stepOf(queue, jobId, 'b').startAt).toBe(1_000_000 + 60_000);
  });

  it('does not start the clock while the previous group is still being reviewed', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [done('a'), delayed('b', 60)], { reviewingStepId: 'a' });
    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'b').startAt).toBeUndefined();
  });

  it('re-arms a future startAt after a restart and starts the step when it fires', async () => {
    vi.useFakeTimers();
    const { engine, queue, clock } = makeEngine();
    const jobId = seed(queue, engine, [done('a'), delayed('b', 60, { startAt: clock.now + 30_000 })]);

    engine.reconcileStartDelays();
    clock.now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stepOf(queue, jobId, 'b').state).toBe('waiting');
  });

  it('Start now starts a held step immediately, and refuses one that has started', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [done('a'), delayed('b', 3600)]);
    await engine.tick(jobId);

    engine.startStepNow(jobId, 'b');
    await vi.waitFor(() => expect(stepOf(queue, jobId, 'b').state).toBe('waiting'));

    expect(() => engine.startStepNow(jobId, 'b')).toThrow(WaitSessionError);
    expect(() => engine.startStepNow(jobId, 'a')).toThrow(/not waiting to start/);
  });

  it('never holds a step that already began when an amendment gives it a delay', async () => {
    const { engine, queue, clock } = makeEngine();
    const live = delayed('b', 0, { state: 'waiting', manualSession: { id: 'm', cwd: '/x' } });
    delete live.delaySec;
    const jobId = seed(queue, engine, [done('a'), live]);

    const proposed = [
      { type: 'action', keepId: 'a', title: 'a', description: 'd', goal: 'g', action: 'read.investigate' },
      { type: 'action', keepId: 'b', title: 'b', description: 'd', goal: 'g', action: 'meta.session', delaySec: 600 },
    ] as ProposedStep[];
    queue.mutate(jobId, (j): JobRecord => ({ ...j, pendingReconciliation: { proposed, drops: [], feedback: '', proposedAt: clock.now } }));
    engine.onReconciliationApproved(jobId);
    await engine.tick(jobId);

    expect(stepOf(queue, jobId, 'b').delaySec).toBe(600);
    expect(stepOf(queue, jobId, 'b').startAt).toBeUndefined();
    expect(() => engine.startStepNow(jobId, 'b')).toThrow(/not waiting to start/);
  });

  it('Start now refuses a job that is not running, so a pending replan can still re-delay', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [done('a'), delayed('b', 3600)], { state: 'plan_pending_review' });
    expect(() => engine.startStepNow(jobId, 'b')).toThrow(/plan_pending_review/);
    expect(stepOf(queue, jobId, 'b').startAt).toBeUndefined();
  });

  it('re-stamps a not-yet-started step whose delay an amendment changes', async () => {
    const { engine, queue, clock } = makeEngine();
    const jobId = seed(queue, engine, [done('a'), delayed('b', 3600)]);
    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'b').startAt).toBe(clock.now + 3_600_000);

    const proposed = [
      { type: 'action', keepId: 'a', title: 'a', description: 'd', goal: 'g', action: 'read.investigate' },
      { type: 'action', keepId: 'b', title: 'b', description: 'd', goal: 'g', action: 'meta.session', delaySec: 120 },
    ] as ProposedStep[];
    queue.mutate(jobId, (j): JobRecord => ({ ...j, pendingReconciliation: { proposed, drops: [], feedback: '', proposedAt: clock.now } }));
    engine.onReconciliationApproved(jobId);

    await vi.waitFor(() => expect(stepOf(queue, jobId, 'b').startAt).toBe(clock.now + 120_000));
  });
});
