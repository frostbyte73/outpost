import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { validateDispositions } from '../../src/work/reconcile.js';
import type { ActionStep, JobRecord, JobState } from '../../src/work/work-types.js';

const BUILTIN = new Set(['meta.session', 'meta.wait', 'meta.job']);
const actionRegistry = {
  getAction(name: string) {
    return { frontmatter: { outpost: { runner: BUILTIN.has(name) ? 'builtin' : 'claude' } } };
  },
  listActions() { return []; },
} as never;

function makeEngine(dir = mkdtempSync(join(tmpdir(), 'engine-job-step-'))) {
  const queue = new JobQueue(dir);
  const sessionManager = {
    spawnDetached() {}, sendTurn() {}, isWorking() { return false; }, sendOrResume() {},
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager,
    worktreeManager: { get: () => undefined, provision: async () => ({ path: '/wt' }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue, dir };
}

function step(id: string, extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id, type: 'action', title: id, description: '', goal: 'g', action: 'read.investigate',
    state: 'running', workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

const jobStep = (id: string, inputs: Record<string, unknown>) => step(id, { action: 'meta.job', inputs });

function seed(queue: JobQueue, engine: WorkEngine, steps: ActionStep[], extra: Partial<JobRecord> = {}): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps, ...extra }));
  return job.id;
}

function standalone(queue: JobQueue, engine: WorkEngine, state: JobState, extra: Partial<JobRecord> = {}): string {
  const job = engine.createJob({ source: 'manual', title: 'existing', description: 'x' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state, ...extra }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string, id: string) =>
  queue.get(jobId)!.steps.find((s) => s.id === id) as ActionStep;

const resolve = (queue: JobQueue, jobId: string, id: string) =>
  queue.mutate(jobId, (j) => ({ ...j, steps: j.steps.map((s) => s.id === id ? { ...s, state: 'resolved', reviewed: true } as ActionStep : s) }));

const create = { title: 'Child', brief: 'Do the thing' };

describe('meta.job: starting a child', () => {
  it('creates the child only when the step becomes active', async () => {
    const { engine, queue } = makeEngine();
    const parent = seed(queue, engine, [step('a'), jobStep('b', create)]);
    const childId = `${parent}-b`;

    await engine.tick(parent);
    expect(queue.get(childId)).toBeUndefined();

    resolve(queue, parent, 'a');
    await engine.tick(parent);

    const child = queue.get(childId)!;
    expect(child.parentRef).toEqual({ jobId: parent, stepId: 'b' });
    expect(child.title).toBe('Child');
    expect(child.description).toBe('Do the thing');
    expect(child.source).toBe('job-step');
    expect(stepOf(queue, parent, 'b').childJobId).toBe(childId);
  });

  it('never creates a second child', async () => {
    const { engine, queue } = makeEngine();
    const parent = seed(queue, engine, [jobStep('b', create)]);

    await engine.tick(parent);
    await engine.tick(parent);
    queue.mutate(parent, (j) => ({ ...j, steps: j.steps.map((s) => ({ ...s, inputs: { title: 'Child', brief: 'Rewritten' } } as ActionStep)) }));
    await engine.tick(parent);

    const children = queue.list().filter((j) => j.parentRef?.jobId === parent);
    expect(children).toHaveLength(1);
    expect(children[0]!.description).toBe('Do the thing');
  });

  it('inherits runtime, planReview and highPriority but not preapprovals', async () => {
    const { engine, queue } = makeEngine();
    const parent = seed(queue, engine, [jobStep('b', create)], {
      runtime: 'codex' as JobRecord['runtime'], planReview: 'auto', highPriority: true, preapprovals: { push: true },
    });

    await engine.tick(parent);

    const child = queue.get(`${parent}-b`)!;
    expect(child.runtime).toBe('codex');
    expect(child.planReview).toBe('auto');
    expect(child.highPriority).toBe(true);
    expect(child.preapprovals).toBeUndefined();
  });

  it('links an existing job', async () => {
    const { engine, queue } = makeEngine();
    const existing = standalone(queue, engine, 'executing');
    const parent = seed(queue, engine, [jobStep('b', { job_id: existing })]);

    await engine.tick(parent);

    expect(queue.get(existing)!.parentRef).toEqual({ jobId: parent, stepId: 'b' });
    expect(stepOf(queue, parent, 'b').childJobId).toBe(existing);
  });

  it('resolves at once when the linked job is already done', async () => {
    const { engine, queue } = makeEngine();
    const existing = standalone(queue, engine, 'done');
    const parent = seed(queue, engine, [jobStep('b', { job_id: existing })]);

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').state).toBe('resolved');
  });

  it('refuses to link a job that does not exist', async () => {
    const { engine, queue } = makeEngine();
    const parent = seed(queue, engine, [jobStep('b', { job_id: 'nope' })]);

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/not found/);
  });

  it('refuses to link a job that already belongs to another parent', async () => {
    const { engine, queue } = makeEngine();
    const existing = standalone(queue, engine, 'executing', { parentRef: { jobId: 'other', stepId: 's' } });
    const parent = seed(queue, engine, [jobStep('b', { job_id: existing })]);

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/already belongs to/);
  });

  it('refuses to link an ancestor', async () => {
    const { engine, queue } = makeEngine();
    const grandparent = standalone(queue, engine, 'executing');
    const parent = seed(queue, engine, [jobStep('b', { job_id: grandparent })], { parentRef: { jobId: grandparent, stepId: 'x' } });

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/ancestor/);
  });
});

function childOf(queue: JobQueue, engine: WorkEngine) {
  return async (steps: ActionStep[] = [jobStep('b', create)]) => {
    const parent = seed(queue, engine, steps);
    await engine.tick(parent);
    return { parent, child: `${parent}-b` };
  };
}

const setChild = (queue: JobQueue, id: string, patch: Partial<JobRecord>) =>
  queue.mutate(id, (j) => ({ ...j, ...patch }));

describe('meta.job: settling from the child', () => {
  it('resolves when the child is done', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, {
      state: 'done',
      steps: [
        step('x', { state: 'resolved', output: 'ok' }),
        { id: 'y', type: 'orchestrated', state: 'resolved', pr: { prUrl: 'https://github.com/o/r/pull/1' } } as unknown as ActionStep,
      ],
    });

    await engine.tick(parent);

    const s = stepOf(queue, parent, 'b');
    expect(s.state).toBe('resolved');
    expect(JSON.parse(s.output!)).toEqual({
      child_job_id: child, state: 'done', prs: ['https://github.com/o/r/pull/1'], last_output: 'ok',
    });
  });

  it('fails when the child fails', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'failed' });

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/failed/);
    expect(queue.get(parent)!.state).toBe('failed');
  });

  it('fails when the child is abandoned', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'abandoned' });

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/abandoned/);
  });

  it('recovers when the child is retried', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'failed' });
    await engine.tick(parent);

    setChild(queue, child, { state: 'executing' });
    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure).toBeUndefined();
    expect(queue.get(parent)!.state).toBe('executing');
  });

  it('ticks the parent when the child changes', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();

    setChild(queue, child, { state: 'done' });
    await new Promise((r) => setTimeout(r, 0));

    expect(stepOf(queue, parent, 'b').state).toBe('resolved');
  });

  it('settles after a restart', async () => {
    const { engine, queue, dir } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'done' });

    const restarted = makeEngine(dir);
    await restarted.engine.tick(parent);

    expect(stepOf(restarted.queue, parent, 'b').state).toBe('resolved');
  });

  it('fails when the child is deleted', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    queue.delete(child);

    await engine.tick(parent);

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/child job deleted/);
  });
});

describe('meta.job: dropping and abandoning', () => {
  it('a dropped started step frees its child', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    const before = queue.get(child)!.state;

    expect(engine.cancelStepManually(parent, 'b')).toBe(true);

    expect(queue.get(child)!.parentRef).toBeUndefined();
    expect(queue.get(child)!.state).toBe(before);
  });

  it('a dropped unstarted step never creates a child', async () => {
    const { engine, queue } = makeEngine();
    const parent = seed(queue, engine, [step('a'), jobStep('b', create)]);

    engine.cancelStepManually(parent, 'b');
    resolve(queue, parent, 'a');
    await engine.tick(parent);

    expect(queue.get(`${parent}-b`)).toBeUndefined();
  });

  it('abandoning the parent abandons unfinished created children only', async () => {
    const { engine, queue } = makeEngine();
    const linked = standalone(queue, engine, 'executing');
    const parent = seed(queue, engine, [
      { ...jobStep('b', create), parallelGroup: 'g' },
      { ...jobStep('c', { title: 'Done child', brief: 'x' }), parallelGroup: 'g' },
      { ...jobStep('d', { job_id: linked }), parallelGroup: 'g' },
    ]);
    await engine.tick(parent);
    setChild(queue, `${parent}-c`, { state: 'done' });

    await engine.abandonJob(parent);

    expect(queue.get(`${parent}-b`)!.state).toBe('abandoned');
    expect(queue.get(`${parent}-c`)!.state).toBe('done');
    expect(queue.get(linked)!.state).toBe('executing');
    expect(queue.get(linked)!.parentRef).toBeUndefined();
  });

  it('the abandon cascade recurses', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'executing', steps: [jobStep('b', create)] });
    await engine.tick(child);
    const grandchild = `${child}-b`;
    expect(queue.get(grandchild)).toBeDefined();

    await engine.abandonJob(parent);

    expect(queue.get(child)!.state).toBe('abandoned');
    expect(queue.get(grandchild)!.state).toBe('abandoned');
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('meta.job: review fixes', () => {
  it('retrying a step whose child failed retries the child', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'failed', steps: [step('x', { failure: { reason: 'boom', at: 1 } })] });
    await engine.tick(parent);

    engine.onStepRetry(parent, 'b');
    await flush();

    expect(queue.get(child)!.state).toBe('executing');
    expect(stepOf(queue, parent, 'b').failure).toBeUndefined();
    expect(stepOf(queue, parent, 'b').childJobId).toBe(child);
  });

  it('retrying a step whose child was abandoned starts a fresh child from the current brief', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    setChild(queue, child, { state: 'abandoned' });
    await engine.tick(parent);
    queue.mutate(parent, (j) => ({ ...j, steps: j.steps.map((s) => ({ ...s, inputs: { title: 'Child', brief: 'New brief' } } as ActionStep)) }));

    engine.onStepRetry(parent, 'b');
    await engine.tick(parent);

    const fresh = stepOf(queue, parent, 'b').childJobId!;
    expect(fresh).toBe(`${child}-2`);
    expect(queue.get(fresh)!.description).toBe('New brief');
    expect(queue.get(child)!.parentRef).toBeUndefined();
  });

  it('deleting a linked child ticks its parent', async () => {
    const { engine, queue } = makeEngine();
    const linked = standalone(queue, engine, 'executing');
    const parent = seed(queue, engine, [jobStep('b', { job_id: linked })]);
    await engine.tick(parent);

    await engine.deleteJob(linked);
    await flush();

    expect(stepOf(queue, parent, 'b').failure?.reason).toMatch(/child job deleted/);
  });

  it('deleting the parent abandons created children and frees linked ones', async () => {
    const { engine, queue } = makeEngine();
    const linked = standalone(queue, engine, 'executing');
    const parent = seed(queue, engine, [
      { ...jobStep('b', create), parallelGroup: 'g' },
      { ...jobStep('d', { job_id: linked }), parallelGroup: 'g' },
    ]);
    await engine.tick(parent);

    await engine.deleteJob(parent);

    expect(queue.get(`${parent}-b`)!.state).toBe('abandoned');
    expect(queue.get(linked)!.parentRef).toBeUndefined();
  });

  it('resetting the parent abandons created children', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();

    await engine.resetJob(parent);

    expect(queue.get(child)!.state).toBe('abandoned');
  });

  it('a started job step cannot stop being a meta.job', async () => {
    const { engine, queue } = makeEngine();
    const { parent } = await childOf(queue, engine)();

    expect(() => engine.editStepManually(parent, 'b', { action: 'read.investigate' })).toThrow(/started job/);
  });

  it('a re-plan cannot turn a started job step into another action', async () => {
    const { engine, queue } = makeEngine();
    const { parent } = await childOf(queue, engine)();
    const cur = queue.get(parent)!.steps;

    const check = validateDispositions(cur, [{ ...jobStep('b', create), action: 'read.investigate', keepId: 'b' } as never], []);

    expect(check.ok).toBe(false);
  });

  it('a burst of child updates ticks the parent once', async () => {
    const { engine, queue } = makeEngine();
    const { parent, child } = await childOf(queue, engine)();
    await flush();
    const tick = vi.spyOn(engine, 'tick');

    for (let i = 0; i < 5; i++) setChild(queue, child, { title: `t${i}` });
    await flush();

    expect(tick.mock.calls.filter(([id]) => id === parent)).toHaveLength(1);
  });
});
