import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine, WaitSessionError } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord, WorkspaceRef } from '../../src/work/work-types.js';

const actionRegistry = {
  getAction(name: string) {
    return { frontmatter: { outpost: { runner: name === 'meta.session' ? 'builtin' : 'claude' } } };
  },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-wait-session-'));
  const queue = new JobQueue(dir);
  const spawned: string[] = [];
  const provisioned: { key: string; ws: WorkspaceRef }[] = [];
  const prompts = new Map<string, string>();
  const sessionManager = {
    spawnDetached(sessionId: string) { spawned.push(sessionId); },
    sendTurn() {}, isWorking() { return false; }, sendOrResume() {},
  } as never;
  const worktreeManager = {
    get: () => undefined,
    provision: async (key: string, ws: WorkspaceRef) => {
      provisioned.push({ key, ws });
      return { path: '/wt/readonly' };
    },
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
    writeSystemPrompt: (id, text) => prompts.set(id, text),
  });
  return { engine, queue, spawned, provisioned, prompts };
}

// A parked meta.session whose session isn't open yet — what a step looks like before its first open.
function sessionStep(extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id: 's', type: 'action', title: 'Promote prod?', description: '', goal: 'g',
    action: 'meta.session', inputs: { prompt: 'p', reason: 'prod deploy' }, state: 'waiting',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

function seed(queue: JobQueue, engine: WorkEngine, step: ActionStep): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step] }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string) => queue.get(jobId)!.steps[0] as ActionStep;

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
  try { await p; return undefined; } catch (e) { return e instanceof WaitSessionError ? e.status : -1; }
}

describe('WorkEngine.openWaitSession', () => {
  it('creates an unbound session with context on first open and spawns nothing', async () => {
    const { engine, queue, spawned, prompts } = makeEngine();
    const jobId = seed(queue, engine, sessionStep());

    const opened = await engine.openWaitSession(jobId, 's', '/repo');

    expect(opened.cwd).toBe('/repo');
    expect(stepOf(queue, jobId).manualSession).toEqual({ id: opened.sessionId, cwd: '/repo' });
    expect(prompts.get(opened.sessionId)).toContain('prod deploy');
    expect(spawned).toEqual([]);
    expect(engine.interactiveTarget(opened.sessionId)).toBeUndefined();
  });

  it('returns the same session on reopen, including concurrent opens and after Done', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, sessionStep());

    const [a, b] = await Promise.all([
      engine.openWaitSession(jobId, 's', '/repo'),
      engine.openWaitSession(jobId, 's', '/repo'),
    ]);
    expect(b).toEqual(a);

    engine.resumeSession(jobId, 's');
    expect(stepOf(queue, jobId).state).toBe('resolved');
    expect(await engine.openWaitSession(jobId, 's')).toEqual(a);
  });

  it('provisions a readonly workspace and opens in it', async () => {
    const { engine, queue, provisioned } = makeEngine();
    const ws: WorkspaceRef = { kind: 'readonly', repoCwd: '/src/cloud-config', ref: 'origin/main' };
    const jobId = seed(queue, engine, sessionStep({ workspace: ws }));

    const opened = await engine.openWaitSession(jobId, 's');

    expect(provisioned).toEqual([{ key: 's', ws }]);
    expect(opened.cwd).toBe('/wt/readonly');
  });

  it('refuses a first open that is not a parked meta.session or has no cwd', async () => {
    const { engine, queue } = makeEngine();
    expect(await statusOf(engine.openWaitSession(seed(queue, engine, sessionStep({ state: 'running' })), 's', '/repo'))).toBe(409);
    expect(await statusOf(engine.openWaitSession(seed(queue, engine, sessionStep({ action: 'read.investigate' })), 's', '/repo'))).toBe(409);
    expect(await statusOf(engine.openWaitSession(seed(queue, engine, sessionStep()), 's'))).toBe(400);
    expect(await statusOf(engine.openWaitSession('nope', 's', '/repo'))).toBe(404);
  });

  it('refuses a writable workspace on a meta.session at the plan boundary and in the editor', () => {
    const { engine, queue } = makeEngine();
    const writable: WorkspaceRef = { kind: 'writable', repoCwd: '/repo', branch: 'x' };
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    expect(() => engine.onPlanReady(job.id, 'initial', [{
      type: 'action', title: 'check', description: '', goal: 'g', action: 'meta.session', workspace: writable,
    } as never])).toThrow(/meta\.session/);

    const jobId = seed(queue, engine, sessionStep());
    expect(() => engine.editStepManually(jobId, 's', { workspace: writable })).toThrow(/meta\.session/);
  });
});
