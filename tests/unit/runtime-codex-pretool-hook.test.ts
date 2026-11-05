import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PRETOOL_HOOK_COMMAND, PRETOOL_HOOK_SCRIPT } from '../../src/runtime/codex/pretool-hook.js';

const PAYLOAD = JSON.stringify({ session_id: 't', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'c1' });

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())).then(() => { server = undefined; }));

function serve(handler: RequestListener): Promise<number> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, '127.0.0.1', () => r((server!.address() as AddressInfo).port)));
}

function closedPort(): Promise<number> {
  const s = createServer();
  return new Promise((r) => s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => r(port));
  }));
}

function runHook(env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', PRETOOL_HOOK_COMMAND], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(PAYLOAD);
  });
}

const reply = (status: number, body: string): RequestListener => (req, res) => {
  req.resume();
  req.on('end', () => { res.statusCode = status; res.end(body); });
};

// Codex runs the call on any hook exit but 0 or 2, so every non-allow path must land on exit 2.
describe('PRETOOL_HOOK_COMMAND', () => {
  it('carries no single quote that would end its sh -c wrapper early', () => {
    expect(PRETOOL_HOOK_SCRIPT).not.toContain("'");
  });

  it('exits 0 with nothing on stdout only for an explicit allow, sending the secret', async () => {
    let sentAuth: string | undefined;
    const port = await serve((req, res) => {
      sentAuth = req.headers['x-daemon-auth'] as string;
      reply(200, '{"decision":"allow"}')(req, res);
    });
    const r = await runHook({ DAEMON_AUTH: 'sekret', OUTPOST_HOOK_PORT: String(port) });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(sentAuth).toBe('sekret');
  });

  it('exits 2 with the daemon reason on a deny', async () => {
    const port = await serve(reply(200, 'deny:not in the allowlist'));
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port) });
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe('not in the allowlist');
  });

  it('exits 2 when the daemon endpoint is down', async () => {
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(await closedPort()) });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unreachable/);
  });

  it.each([500, 401, 204])('exits 2 on HTTP %i', async (status) => {
    const port = await serve(reply(status, '{"decision":"allow"}'));
    expect((await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port) })).code).toBe(2);
  });

  it.each(['ok', '', 'deny:', '{"decision":"allow"} '])('exits 2 on a 200 with body %j', async (body) => {
    const port = await serve(reply(200, body));
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port) });
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).not.toBe('');
  });

  it('exits 2 when the daemon never answers before the curl timeout', async () => {
    const port = await serve(() => {});
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port), OUTPOST_HOOK_CURL_TIMEOUT_S: '1' });
    expect(r.code).toBe(2);
  }, 10_000);

  it.each([
    ['DAEMON_AUTH', { OUTPOST_HOOK_PORT: '1' }],
    ['OUTPOST_HOOK_PORT', { DAEMON_AUTH: 's' }],
  ])('exits 2 without %s', async (_missing, env) => {
    expect((await runHook(env)).code).toBe(2);
  });
});
