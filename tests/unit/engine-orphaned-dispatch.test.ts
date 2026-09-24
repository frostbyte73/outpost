import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { Dispatch, JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

// A dispatch's `status: 'queued'` does not mean "the daemon intends to run this" — it means its
// launch closure is parked in LaunchGovernor's in-memory map, and the flip to `running` happens
// inside that closure. A restart drops the map, so the dispatch is stranded in a state nothing
// re-drives, while `untilAllDispatchesDone` holds its parent controller open forever. That is
// how one review step sat parked for 44 days on a child that had never started.
// reconcileInterruptedSteps already fails an orphaned `running` dispatch for the same reason;
// this is the sibling case, and it re-drives rather than fails — a queued dispatch never ran,
// so there is nothing to recover from and no reason to spend one of its attempts.

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-orphan-'));
  const queue = new JobQueue(dir);
  const spawned: string[] = [];
  const engine = new WorkEngine({
    queue,
    sessionManager: {
      spawnDetached(sessionId: string) { spawned.push(sessionId); },
      send() {}, isWorking() { return false; }, sendOrResume() {},
    } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }) } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `sess-${++n}`; })(),
    now: () => 5000,
  });
  return { engine, queue, spawned };
}

function dispatch(id: string, status: Dispatch['status']): Dispatch {
  return { id, action: 'code.review-diff', brief: 'b', status, attempts: 1 };
}

function seed(queue: JobQueue, engine: WorkEngine, dispatches: Dispatch[], over: Partial<OrchestratedStep> = {}): string {
  const step: OrchestratedStep = {
    id: 'step-1', type: 'orchestrated', title: 't', description: 'd', goal: 'g',
    controller: 'code.orchestrate-review', workspace: { kind: 'readonly', repoCwd: '/tmp/repo' },
    dispatches, inbox: [], roundsSpent: 2, consecutiveSelfRounds: 0,
    state: 'waiting', waitingOn: { reason: 'r', untilAllDispatchesDone: true },
    createdAt: 1000, updatedAt: 1000, ...over,
  };
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step] }));
  return job.id;
}

const settled = () => new Promise((r) => setImmediate(r));

function dispatchesOf(queue: JobQueue, jobId: string): Dispatch[] {
  return (queue.get(jobId)!.steps[0] as OrchestratedStep).dispatches;
}

describe('WorkEngine.reconcilePendingLaunches — orphaned dispatches', () => {
  it('re-drives a queued dispatch stranded by a restart', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seed(queue, engine, [dispatch('d1', 'done'), dispatch('d2', 'queued')]);

    engine.reconcilePendingLaunches();
    await settled();

    const [d1, d2] = dispatchesOf(queue, jobId);
    expect(d1!.status).toBe('done');
    expect(d2!.status).toBe('running');
    expect(d2!.sessionId).toBeDefined();
    expect(spawned).toEqual([d2!.sessionId]);
  });

  it('spends no extra attempt re-driving it', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [dispatch('d1', 'queued')]);

    engine.reconcilePendingLaunches();
    await settled();

    expect(dispatchesOf(queue, jobId)[0]!.attempts).toBe(1);
  });

  it('leaves settled dispatches alone', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seed(queue, engine, [
      dispatch('d1', 'done'), dispatch('d2', 'failed'), dispatch('d3', 'cancelled'),
    ]);

    engine.reconcilePendingLaunches();
    await settled();

    expect(dispatchesOf(queue, jobId).map((d) => d.status)).toEqual(['done', 'failed', 'cancelled']);
    expect(spawned).toEqual([]);
  });

  // An awaiting_approval dispatch is parked on the user's write draft, not on a launch slot —
  // re-driving it would spawn a second session for work already mid-flight.
  it('leaves a dispatch parked on a write draft alone', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seed(queue, engine, [dispatch('d1', 'awaiting_approval')]);

    engine.reconcilePendingLaunches();
    await settled();

    expect(dispatchesOf(queue, jobId)[0]!.status).toBe('awaiting_approval');
    expect(spawned).toEqual([]);
  });

  it('skips a cancelled step', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seed(queue, engine, [dispatch('d1', 'queued')], { cancelled: true });

    engine.reconcilePendingLaunches();
    await settled();

    expect(dispatchesOf(queue, jobId)[0]!.status).toBe('queued');
    expect(spawned).toEqual([]);
  });

  it('skips a step that already settled', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seed(queue, engine, [dispatch('d1', 'queued')], { state: 'resolved' });

    engine.reconcilePendingLaunches();
    await settled();

    expect(dispatchesOf(queue, jobId)[0]!.status).toBe('queued');
    expect(spawned).toEqual([]);
  });
});

// A parked dispatch is keyed `${jobId}#${stepId}#${dispatchId}`, which launchStatusFor never
// asked the governor about — so the one step whose work was queued behind a busy slot rendered
// as idle, while its card went on quoting a `waitingOn.reason` written when the fan-out began
// ("Running code.review-diff, code.security-review") long after both claims stopped being true.
describe('WorkEngine.launchStatusFor — dispatch launches', () => {
  function withGovernor(queuedKeys: string[]) {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [dispatch('d1', 'queued'), dispatch('d2', 'running')]);
    (engine as unknown as { opts: { governor: unknown } }).opts.governor = {
      describe: (key: string) => (queuedKeys.some((k) => key.endsWith(k))
        ? { state: 'queued', reason: '1/1 slots busy' }
        : { state: 'idle' }),
    };
    return { engine, queue, jobId };
  }

  it('reports a step as queued while one of its dispatches is parked', () => {
    const { engine, queue, jobId } = withGovernor(['#d1']);

    const status = engine.launchStatusFor(queue.get(jobId)!);

    expect(status.steps['step-1']).toEqual({ state: 'queued', reason: '1/1 slots busy' });
  });

  it('leaves a step idle when nothing of its is parked', () => {
    const { engine, queue, jobId } = withGovernor([]);

    const status = engine.launchStatusFor(queue.get(jobId)!);

    expect(status.steps['step-1']).toEqual({ state: 'idle' });
  });

  it('prefers the step\'s own launch state over a dispatch\'s', () => {
    const { engine, queue, jobId } = withGovernor(['#step-1', '#d1']);

    const status = engine.launchStatusFor(queue.get(jobId)!);

    expect(status.steps['step-1']).toEqual({ state: 'queued', reason: '1/1 slots busy' });
  });
});
