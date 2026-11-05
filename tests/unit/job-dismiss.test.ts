import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerJobsRoutes } from '../../src/routes/jobs.js';
import { WorkEngine } from '../../src/work/engine.js';
import { InteractiveStore } from '../../src/session/interactive-store.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, JobState } from '../../src/work/work-types.js';
import { freePort } from '../e2e/harness/port.js';

function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const actionRegistry = {
  getAction() { return undefined; },
  gatedFor() { return { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] }; },
  listActions() { return []; },
} as never;

function harness(state: JobState) {
  const dir = mkdtempSync(join(tmpdir(), 'dismiss-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    journalStore: { append: () => {}, recent: () => [] } as never,
    sessionManager: { spawnDetached() {}, sendTurn() {}, isWorking() { return false; }, sendOrResume() {}, close: async () => {} } as never,
    worktreeManager: { get: () => undefined, provision: async () => ({ path: '/tmp' }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 4242,
  });
  const job: JobRecord = {
    id: 'job-1', source: 'manual', title: 't', description: 'd', state,
    steps: [], createdAt: 1000, updatedAt: 1000,
  };
  queue.upsert(job);
  return { queue, engine, jobsDir: join(dir, 'jobs') };
}

async function startServer(h: ReturnType<typeof harness>): Promise<number> {
  const port = await freePort();
  server = new Server({ httpPort: port, heartbeatMs: 0 });
  registerJobsRoutes(server, {
    jobQueue: h.queue, engine: h.engine,
    prWatcher: {} as never, prFilePatches: {} as never, scheduler: {} as never, sessionStore: {} as never,
    worktreeManager: {} as never, projectRegistry: {} as never, jobsDir: h.jobsDir,
    interactive: new InteractiveStore(),
  });
  await server.listen();
  return port;
}

describe('job dismissal', () => {
  it('dismiss stamps dismissedAt on a done job', async () => {
    const h = harness('done');
    const port = await startServer(h);
    const res = await post(port, '/api/work/jobs/job-1/dismiss');
    expect(res.status).toBe(200);
    expect(h.queue.get('job-1')!.dismissedAt).toBe(4242);
  });

  it('dismiss stamps a failed job', async () => {
    const h = harness('failed');
    const port = await startServer(h);
    expect((await post(port, '/api/work/jobs/job-1/dismiss')).status).toBe(200);
    expect(h.queue.get('job-1')!.dismissedAt).toBe(4242);
  });

  it('dismiss refuses a live job', async () => {
    const h = harness('executing');
    const port = await startServer(h);
    const res = await post(port, '/api/work/jobs/job-1/dismiss');
    expect(res.status).toBe(409);
    expect(h.queue.get('job-1')!.dismissedAt).toBeUndefined();
  });

  it('dismiss 404s an unknown job', async () => {
    const h = harness('done');
    const port = await startServer(h);
    expect((await post(port, '/api/work/jobs/nope/dismiss')).status).toBe(404);
  });

  it('a job created after the cutover is not dismissed by the next boot', () => {
    const h = harness('executing');
    const j = h.engine.createJob({ source: 'manual', title: 'new', description: 'd' });
    h.queue.mutate(j.id, (x) => ({ ...x, state: 'done' }));
    const reloaded = new JobQueue(dirname(h.jobsDir));
    expect(reloaded.get(j.id)!.state).toBe('done');
    expect(reloaded.get(j.id)!.dismissedAt).toBeUndefined();
  });

  it('leaving a terminal state clears dismissedAt', () => {
    const h = harness('failed');
    h.engine.dismissJob('job-1');
    h.queue.mutate('job-1', (j) => ({ ...j, state: 'executing' }));
    expect(h.queue.get('job-1')!.dismissedAt).toBeUndefined();
  });
});
