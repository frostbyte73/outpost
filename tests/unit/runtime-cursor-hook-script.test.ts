import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CURSOR_ALLOW, CURSOR_HOOK_COMMAND, CURSOR_HOOK_SCRIPT, cursorDeny, hooksJson } from '../../src/runtime/cursor/hooks.js';

const PAYLOAD = JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'git push' }, tool_use_id: 'c1' });

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

function runHook(env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', CURSOR_HOOK_COMMAND], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(PAYLOAD);
  });
}

const reply = (status: number, body: string): RequestListener => (req, res) => {
  req.resume();
  req.on('end', () => { res.statusCode = status; res.end(body); });
};

// Cursor's failClosed blocks on any non-zero exit, so every non-answer path must exit 1 and only a daemon answer reaches stdout.
describe('CURSOR_HOOK_COMMAND', () => {
  it('carries no single quote that would end its sh -c wrapper early', () => {
    expect(CURSOR_HOOK_SCRIPT).not.toContain("'");
  });

  // Cursor's JSONC loader strips `//…` and `/*…*/` even inside strings, which leaves hooks.json unloadable and every call ungated.
  it('survives the comment-stripping Cursor applies to hooks.json', () => {
    const text = hooksJson(120);
    const stripped = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).toBe(text);
  });

  it('prints the allow and exits 0, sending the secret and the session', async () => {
    let headers: Record<string, unknown> = {};
    const port = await serve((req, res) => {
      headers = req.headers;
      reply(200, CURSOR_ALLOW)(req, res);
    });
    const r = await runHook({ DAEMON_AUTH: 'sekret', OUTPOST_HOOK_PORT: String(port), OUTPOST_CURSOR_SESSION: 's1' });
    expect(r).toEqual({ code: 0, stdout: `${CURSOR_ALLOW}\n` });
    expect(headers).toMatchObject({ 'x-daemon-auth': 'sekret', 'x-outpost-session': 's1' });
  });

  it('prints a deny and exits 0', async () => {
    const port = await serve(reply(200, cursorDeny('not in the allowlist')));
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port) });
    expect(r).toEqual({ code: 0, stdout: `${cursorDeny('not in the allowlist')}\n` });
  });

  it('exits 1 when the daemon endpoint is down', async () => {
    expect((await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(await closedPort()) })).code).toBe(1);
  });

  it.each([500, 401, 204])('exits 1 on HTTP %i', async (status) => {
    const port = await serve(reply(status, CURSOR_ALLOW));
    expect((await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port) })).code).toBe(1);
  });

  it.each(['ok', '', `${CURSOR_ALLOW} `, '{"permission":"ask"}'])('exits 1 on a 200 with body %j', async (body) => {
    const port = await serve(reply(200, body));
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port) });
    expect(r).toEqual({ code: 1, stdout: '' });
  });

  it('exits 1 when the daemon never answers before the curl timeout', async () => {
    const port = await serve(() => {});
    const r = await runHook({ DAEMON_AUTH: 's', OUTPOST_HOOK_PORT: String(port), OUTPOST_HOOK_CURL_TIMEOUT_S: '1' });
    expect(r.code).toBe(1);
  }, 10_000);

  it.each([
    ['DAEMON_AUTH', { OUTPOST_HOOK_PORT: '1' }],
    ['OUTPOST_HOOK_PORT', { DAEMON_AUTH: 's' }],
  ])('exits 1 without %s', async (_missing, env) => {
    expect((await runHook(env)).code).toBe(1);
  });
});
