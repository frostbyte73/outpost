import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { chromium } from '@playwright/test';
import { RefusedError, capture, isLocalUrl, writePngAtomic } from '../../src/permissions/screenshot/capture.mjs';
import { installScreenshotTool } from '../../src/permissions/screenshot/install.js';

const tmpDirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'shot-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

describe('the installed outpost-screenshot', () => {
  // mkdtemp under macOS's tmpdir is a symlinked path; the entrypoint guard must still run main() there.
  it('runs through its wrapper and refuses a non-local URL with exit 3', async () => {
    const bin = installScreenshotTool(tmp(), process.cwd());
    const code = await new Promise<number | null>((resolve) => {
      execFile(join(bin, 'outpost-screenshot'), ['http://localhost@example.com/'], (err) => resolve(err ? (err.code as number) : 0));
    });
    expect(code).toBe(3);
  });
});

describe('isLocalUrl', () => {
  it('accepts exactly the loopback hosts, after URL normalisation', () => {
    for (const u of ['http://localhost:1/', 'http://LOCALHOST/', 'https://127.0.0.1/', 'http://[::1]:9/', 'http://0x7f.1/']) {
      expect(isLocalUrl(u), u).toBe(true);
    }
    for (const u of [
      'http://localhost.evil.com/', 'http://localhost@evil.com/', 'http://user:pw@localhost/',
      'http://localhost./', 'http://127.0.0.1.nip.io/', 'http://[::ffff:7f00:1]/', 'ftp://localhost/',
      'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url', 'ws://localhost/',
    ]) expect(isLocalUrl(u), u).toBe(false);
    expect(isLocalUrl('ws://localhost/', new Set(['ws:']))).toBe(true);
  });
});

describe('writePngAtomic', () => {
  it('replaces a planted symlink instead of writing through it', () => {
    const dir = tmp();
    const sentinel = join(dir, 'sentinel');
    const out = join(dir, 'out.png');
    writeFileSync(sentinel, 'keep');
    symlinkSync(sentinel, out);
    writePngAtomic(out, Buffer.from('png'));
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(lstatSync(out).isSymbolicLink()).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('png');
  });
});

// Headless launches use chromium-headless-shell, which executablePath() doesn't report on.
const canLaunch = await chromium.launch().then((b) => b.close().then(() => true), () => false);
if (!canLaunch) console.warn('screenshot-capture: chromium not installed — the capture security cases are SKIPPED (npx playwright install chromium)');

describe.skipIf(!canLaunch)('capture', () => {
  let server: Server;
  let base: string;
  const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const routes: Record<string, () => void> = {
        '/ok': () => res.end(page('ok')),
        '/hop': () => { res.writeHead(302, { Location: '/ok' }); res.end(); },
        '/away': () => { res.writeHead(302, { Location: 'http://example.invalid/' }); res.end(); },
        '/sub': () => res.end(page('<img src="http://example.invalid/x.png">')),
        '/post': () => res.end(page("<script>fetch('/ok', { method: 'POST' })</script>")),
        '/subhop': () => res.end(page('<img src="/away">')),
        '/port': () => res.end(page("<script>fetch('http://127.0.0.1:1/')</script>")),
        '/ws': () => res.end(page("<script>new WebSocket('ws://127.0.0.1:1/')</script>")),
        '/drop': () => req.socket.destroy(),
        '/dropped': () => res.end(page('<img src="/drop">')),
        '/wsworker': () => res.end(page(`<script>new Worker(URL.createObjectURL(new Blob(["new WebSocket('ws://127.0.0.1:1/')"])))</script>`)),
      };
      (routes[req.url ?? ''] ?? (() => { res.statusCode = 404; res.end(); }))();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const shoot = (path: string) => {
    const out = join(tmp(), 'x.png');
    return { out, run: capture({ url: base + path, out, chromium, timeoutMs: 15_000 }) };
  };

  it('follows a local redirect through the route and writes the PNG', async () => {
    const { out, run } = shoot('/hop');
    await expect(run).resolves.toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it('refuses a redirect, a subresource, a POST, another local port or a WebSocket off the page origin', async () => {
    for (const path of ['/away', '/sub', '/post', '/subhop', '/port', '/ws']) {
      const { out, run } = shoot(path);
      await expect(run, path).rejects.toBeInstanceOf(RefusedError);
      expect(existsSync(out), path).toBe(false);
    }
  });

  it('fails fast, naming the request, when a same-origin fetch breaks', async () => {
    const { out, run } = shoot('/dropped');
    const started = Date.now();
    const err = await run.then(() => null, (e: Error) => e);
    expect(err).not.toBeInstanceOf(RefusedError);
    expect(err?.message).toMatch(/request failed: GET .*\/drop/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(out)).toBe(false);
  });

  // Pins the documented trade in permissions.md: if this starts failing, Playwright routes worker sockets and the trade can go.
  it("a dedicated Worker's WebSocket is not intercepted (known trade)", async () => {
    const { out, run } = shoot('/wsworker');
    await expect(run).resolves.toBe(out);
  });
});
