import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord, WorkspaceRef } from '../../src/work/work-types.js';

const actionRegistry = {
  getAction(name: string) {
    const runner = name === 'meta.session' || name === 'meta.wait' ? 'builtin' : 'claude';
    return { frontmatter: { outpost: { runner } } };
  },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-session-step-'));
  const queue = new JobQueue(dir);
  const spawned: { id: string; cwd: string; env?: unknown }[] = [];
  const sent: { id: string; content: unknown }[] = [];
  const prompts = new Map<string, string>();
  const stamped = new Map<string, { action: string; title: string }>();
  const sessionManager = {
    spawnDetached(id: string, cwd: string, env?: unknown) { spawned.push({ id, cwd, env }); },
    sendTurn(id: string, turn: { text: string }) { sent.push({ id, content: turn.text }); },
    isWorking() { return false; }, sendOrResume() {},
  } as never;
  const worktreeManager = { get: () => undefined, provision: async () => ({ path: '/wt/readonly' }) } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
    writeSystemPrompt: (id, text) => prompts.set(id, text),
    writeActionMeta: (id, meta) => stamped.set(id, meta),
  });
  return { engine, queue, spawned, sent, prompts, stamped };
}

function sessionStep(extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id: 's', type: 'action', title: 'Investigate CSCU-42', description: '', goal: 'g',
    action: 'meta.session', inputs: { prompt: '/investigate-cscu CSCU-42' }, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

function seed(queue: JobQueue, engine: WorkEngine, steps: ActionStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string, id = 's') =>
  queue.get(jobId)!.steps.find((s) => s.id === id) as ActionStep;

describe('WorkEngine meta.session', () => {
  it('starts an unbound session with the prompt as its first turn and parks behind it', async () => {
    const { engine, queue, spawned, sent, prompts, stamped } = makeEngine();
    const jobId = seed(queue, engine, [sessionStep()]);

    await engine.tick(jobId);

    const step = stepOf(queue, jobId);
    expect(step.state).toBe('waiting');
    expect(step.sessionId).toBeUndefined();
    const sid = step.manualSession!.id;
    expect(spawned).toEqual([{ id: sid, cwd: homedir(), env: undefined }]);
    expect(sent).toEqual([{ id: sid, content: '/investigate-cscu CSCU-42' }]);
    expect(prompts.get(sid)).toContain("this session IS the step's work");
    expect(engine.interactiveTarget(sid)).toBeUndefined();
    expect(stamped.get(sid)).toEqual({ action: 'meta.session', title: 'Investigate CSCU-42' });

    await engine.tick(jobId);
    expect(spawned).toHaveLength(1);
  });

  it('holds the next step until the user marks it done', async () => {
    const { engine, queue } = makeEngine();
    const next: ActionStep = { ...sessionStep({ id: 'n', action: 'meta.wait', inputs: { reason: 'r' } }) };
    const jobId = seed(queue, engine, [sessionStep(), next]);

    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'n').state).toBe('running');

    engine.resumeWait(jobId, 's');
    expect(stepOf(queue, jobId).state).toBe('resolved');
    expect(JSON.parse(stepOf(queue, jobId).output!)).toEqual({ resumed_by: 'user' });
  });

  it('opens in a provisioned readonly workspace', async () => {
    const { engine, queue, spawned } = makeEngine();
    const ws: WorkspaceRef = { kind: 'readonly', repoCwd: '/src/cloud', ref: 'origin/main' };
    const jobId = seed(queue, engine, [sessionStep({ workspace: ws })]);

    await engine.tick(jobId);

    expect(spawned[0]!.cwd).toBe('/wt/readonly');
    expect(stepOf(queue, jobId).manualSession!.cwd).toBe('/wt/readonly');
  });

  it('fails the step instead of spawning when the prompt is missing', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seed(queue, engine, [sessionStep({ inputs: {} })]);

    await engine.tick(jobId);

    expect(spawned).toEqual([]);
    expect(stepOf(queue, jobId).failure?.reason).toMatch(/prompt/);
  });

  it('stamps manual sessions that predate the stamp at boot', () => {
    const { engine, queue, stamped } = makeEngine();
    seed(queue, engine, [sessionStep({ state: 'waiting', manualSession: { id: 'old', cwd: '/x' } })]);

    engine.rehydrateSessionBindings();

    expect(stamped.get('old')).toEqual({ action: 'meta.session', title: 'Investigate CSCU-42' });
  });
});
