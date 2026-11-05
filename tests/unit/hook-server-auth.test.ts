import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookServer, type HookServerOpts } from '../../src/permissions/hook-server.js';
import { freePort } from '../e2e/harness/port.js';

const SECRET = 'current-run-secret';
const EVAL_SECRET = 'eval-only-secret';

function post(port: number, path: string, secret: string | undefined): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret === undefined ? {} : { 'x-daemon-auth': secret }) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end('{"session_id":"s","tool_name":"Bash","tool_input":{"command":"git push"}}');
  });
}

let server: HookServer | undefined;
let handled: string[] = [];
afterEach(async () => { await server?.close(); server = undefined; handled = []; });

async function start(): Promise<number> {
  const port = await freePort();
  const record = (route: string) => async () => { handled.push(route); };
  const opts: HookServerOpts = {
    port, daemonAuthSecret: SECRET,
    onWorkPlanReady: record('plan'), onWorkStepResolved: record('resolved'), onWorkStepFailed: record('failed'),
    onActionProposal: record('proposal'), onWorkJournal: record('journal'),
    onMcp: async () => { handled.push('mcp'); return { status: 200, headers: {}, body: '{}' }; },
    onEvalMcp: async (path: string) => { handled.push(path); return { status: 200, headers: {}, body: '{}' }; },
    evalSecret: EVAL_SECRET,
  };
  server = new HookServer(opts);
  await server.listen();
  return port;
}

describe('HookServer — callers without the current secret', () => {
  it.each([['a stale secret', 'previous-run-secret'], ['no secret', undefined]])(
    'answers every route 401 for %s, without running its handler',
    async (_label, secret) => {
      const port = await start();
      for (const route of ['/mcp', '/work/step-resolved', '/work/journal']) {
        expect((await post(port, route, secret)).status).toBe(401);
      }
      expect(handled).toEqual([]);
    },
  );

  it('runs the handler for the current secret', async () => {
    const port = await start();
    expect((await post(port, '/mcp', SECRET)).status).toBe(200);
    expect(handled).toEqual(['mcp']);
  });
});

// The other half: a restart closes the daemon's sessions instead of orphaning them. Pinned on the
// source, like hook-body-guard's callback checks — driving it means booting the whole daemon.
describe('daemon shutdown', () => {
  const daemon = readFileSync(fileURLToPath(new URL('../../src/daemon.ts', import.meta.url)), 'utf8');

  it('closes every session on SIGTERM and SIGINT before exiting', () => {
    expect(daemon).toContain("process.once('SIGTERM', shutdown)");
    expect(daemon).toContain("process.once('SIGINT', shutdown)");
    expect(daemon).toMatch(/manager\.closeAll\('shutdown'\)/);
  });
});

describe('HookServer — eval replay MCP routes', () => {
  it('routes an authenticated eval and replay path to onEvalMcp', async () => {
    const port = await start();
    expect((await post(port, '/mcp/eval/sid', SECRET)).status).toBe(200);
    expect((await post(port, '/mcp/replay/sid/linear', SECRET)).status).toBe(200);
    expect(handled).toEqual(['/mcp/eval/sid', '/mcp/replay/sid/linear']);
  });

  it('accepts the eval secret on the eval MCP routes only', async () => {
    const port = await start();
    expect((await post(port, '/mcp/eval/sid', EVAL_SECRET)).status).toBe(200);
    for (const route of ['/mcp', '/work/plan-ready', '/work/create-job', '/work/action-proposal']) {
      expect((await post(port, route, EVAL_SECRET)).status).toBe(401);
    }
    expect(handled).toEqual(['/mcp/eval/sid']);
  });

  it('refuses them without the secret', async () => {
    const port = await start();
    expect((await post(port, '/mcp/eval/sid', 'wrong')).status).toBe(401);
    expect(handled).toEqual([]);
  });
});
