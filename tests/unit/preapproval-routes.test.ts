import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerJobsRoutes } from '../../src/routes/jobs.js';
import { WorkEngine } from '../../src/work/engine.js';
import { InteractiveStore } from '../../src/session/interactive-store.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';
import { freePort } from '../e2e/harness/port.js';

// The HTTP routes are the only writers of a real pre-approval, so they are also where a
// malformed one has to stop.

function send(port: number, method: string, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'preapproval-routes-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {}, close: async () => {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }), get: () => undefined } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }), gatedFor: () => undefined, listActions: () => [] } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  const step: OrchestratedStep = {
    id: 's1', type: 'orchestrated', title: 't', description: 'd', controller: 'code.orchestrate-pr', goal: 'g',
    workspace: { kind: 'writable', repoCwd: dir, branch: 'deps/x' }, dispatches: [], inbox: [],
    roundsSpent: 0, consecutiveSelfRounds: 0, state: 'running', createdAt: 1000, updatedAt: 1000,
  };
  const job: JobRecord = { id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'plan_pending_review', steps: [step], createdAt: 1000, updatedAt: 1000 };
  queue.upsert(job);
  const port = await freePort();
  server = new Server({ httpPort: port, heartbeatMs: 0 });
  registerJobsRoutes(server, {
    jobQueue: queue, engine, prWatcher: {} as never, prFilePatches: {} as never, scheduler: {} as never,
    sessionStore: {} as never, worktreeManager: {} as never, jobsDir: join(dir, 'jobs'), interactive: new InteractiveStore(),
  });
  await server.listen();
  return { port, queue };
}

const stepOf = (queue: JobQueue) => queue.get('job-1')!.steps[0] as OrchestratedStep;

describe('job creation', () => {
  it('stores the user\'s pre-approvals and plan-review choice', async () => {
    const { port, queue } = await start();
    const res = await send(port, 'POST', '/api/work/jobs', { title: 'bump', preapprovals: { push: true }, planReview: 'auto' });
    expect(res.status).toBe(200);
    const id = JSON.parse(res.body).job.id;
    expect(queue.get(id)).toMatchObject({ preapprovals: { push: true }, planReview: 'auto' });
  });

  it('refuses a malformed value', async () => {
    const { port } = await start();
    expect((await send(port, 'POST', '/api/work/jobs', { title: 'bump', preapprovals: { push: 'yes' } })).status).toBe(400);
    expect((await send(port, 'POST', '/api/work/jobs', { title: 'bump', planReview: 'never' })).status).toBe(400);
  });
});

describe('plan approval', () => {
  it('writes the submitted per-step values', async () => {
    const { port, queue } = await start();
    const res = await send(port, 'POST', '/api/work/jobs/job-1/approve', { gate: 'plan', stepPreapprovals: { s1: { openPr: true } } });
    expect(res.status).toBe(200);
    expect(stepOf(queue).preapprovals).toEqual({ openPr: true });
  });

  it('refuses a malformed per-step value without approving the plan', async () => {
    const { port, queue } = await start();
    const res = await send(port, 'POST', '/api/work/jobs/job-1/approve', { gate: 'plan', stepPreapprovals: { s1: { merge: 1 } } });
    expect(res.status).toBe(400);
    expect(queue.get('job-1')!.state).toBe('plan_pending_review');
  });
});

describe('the running-step editor', () => {
  it('sets a step\'s pre-approvals', async () => {
    const { port, queue } = await start();
    const res = await send(port, 'PUT', '/api/work/jobs/job-1/steps/s1/preapprovals', { preapprovals: { merge: true } });
    expect(res.status).toBe(200);
    expect(stepOf(queue).preapprovals).toEqual({ merge: true });
  });

  it('refuses a malformed value', async () => {
    const { port } = await start();
    expect((await send(port, 'PUT', '/api/work/jobs/job-1/steps/s1/preapprovals', { preapprovals: { spec: 'yolo' } })).status).toBe(400);
  });
});
