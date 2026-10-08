import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookServer, type HookServerOpts } from '../../src/permissions/hook-server.js';
import { freePort } from '../e2e/harness/port.js';

const SECRET = 'current-run-secret';

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
  // `as`, not an annotation: onStopFailureHook only exists once the API-error stall handling lands.
  const opts = {
    port, daemonAuthSecret: SECRET,
    onPreToolHook: async () => { handled.push('pretool'); return '{}'; },
    onPostToolFailureHook: async () => '{}',
    onPostToolHook: async () => {},
    onStopHook: record('stop'), onStopFailureHook: record('stop-failure'), onStatusLineHook: record('statusline'),
    onWorkPlanReady: record('plan'), onWorkStepResolved: record('resolved'), onWorkStepFailed: record('failed'),
    onActionProposal: record('proposal'), onWorkJournal: record('journal'),
    onMcp: async () => ({ status: 200, headers: {}, body: '{}' }),
  } as HookServerOpts;
  server = new HookServer(opts);
  await server.listen();
  return port;
}

// A session orphaned by a daemon restart keeps the previous run's secret. Claude Code reads a
// non-2xx PreToolUse answer as a non-blocking error and runs the tool anyway, so that route must
// answer with a deny, not a 401.
describe('HookServer — callers without the current secret', () => {
  it.each([['a stale secret', 'previous-run-secret'], ['no secret', undefined]])(
    'denies the PreToolUse gate for %s, with a 200 Claude Code acts on',
    async (_label, secret) => {
      const port = await start();
      const res = await post(port, '/hook/pretool', secret);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(handled).toEqual([]);
    },
  );

  it('still answers every other route 401, without running its handler', async () => {
    const port = await start();
    for (const route of ['/hook/stop', '/hook/statusline', '/work/step-resolved']) {
      expect((await post(port, route, 'previous-run-secret')).status).toBe(401);
    }
    expect(handled).toEqual([]);
  });

  it('runs the gate as usual for the current secret', async () => {
    const port = await start();
    expect((await post(port, '/hook/pretool', SECRET)).status).toBe(200);
    expect(handled).toEqual(['pretool']);
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
