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
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';
import { freePort } from '../e2e/harness/port.js';

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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
    req.end(payload);
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const actionRegistry = {
  getAction() { return { frontmatter: { outpost: { runner: 'claude' } }, gated: {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  } }; },
  gatedFor() { return { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] }; },
  listActions() { return []; },
} as never;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'engage-routes-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    journalStore: { append: () => {}, recent: () => [] } as never,
    sessionManager: {
      spawnDetached() {}, send() {}, isWorking() { return false; },
      sendOrResume() {}, close: async () => {},
    } as never,
    worktreeManager: { get: () => undefined, provision: async () => ({ path: '/tmp' }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  const step: ActionStep = {
    id: 'g1', type: 'action', title: 'g1', description: 'd', goal: 'g',
    action: 'write.linear-issue', inputs: {}, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, sessionId: 'sess-1',
  };
  const job: JobRecord = {
    id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
    steps: [step], createdAt: 1000, updatedAt: 1000,
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
    worktreeManager: {} as never, jobsDir: h.jobsDir,
    interactive: new InteractiveStore(),
  });
  await server.listen();
  return port;
}

const CALL = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'Bug', teamId: 'T1' } } };

describe('job engagement', () => {
  it('a user decision on a draft stamps lastEngagedAt', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    expect(h.queue.get('job-1')!.lastEngagedAt).toBeUndefined();
    const port = await startServer(h);

    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/revise`, { feedback: 'shorter' });

    expect(res.status).toBe(200);
    expect(h.queue.get('job-1')!.lastEngagedAt).toBe(1000);
  });

  it('a refused request does not stamp', async () => {
    const h = harness();
    const port = await startServer(h);
    const res = await post(port, '/api/work/jobs/job-1/steps/g1/drafts/nope/revise', { feedback: 'x' });
    expect(res.status).toBe(404);
    expect(h.queue.get('job-1')!.lastEngagedAt).toBeUndefined();
  });

  it('a priority toggle is not engagement', async () => {
    const h = harness();
    const port = await startServer(h);
    const res = await post(port, '/api/work/jobs/job-1/priority', { highPriority: true });
    expect(res.status).toBe(200);
    expect(h.queue.get('job-1')!.lastEngagedAt).toBeUndefined();
  });
});
