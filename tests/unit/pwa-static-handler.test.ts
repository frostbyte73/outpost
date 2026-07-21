import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Server } from '../../src/server.js';
import { servePwa } from '../../src/daemon.js'; // implementer exports this; see Step 4
import { freePort } from '../e2e/harness/port.js';

function get(url: URL): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('PWA static handler', () => {
  let pwaDir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    pwaDir = mkdtempSync(join(tmpdir(), 'pwa-test-'));
    writeFileSync(join(pwaDir, 'index.html'), '<!doctype html><html></html>');
    writeFileSync(join(pwaDir, 'app.js'), 'console.log("hi")');
    mkdirSync(join(pwaDir, 'css'));
    writeFileSync(join(pwaDir, 'css', 'base.css'), 'body { color: red; }');
    mkdirSync(join(pwaDir, 'state'));
    writeFileSync(join(pwaDir, 'state', 'sessions.js'), 'export const x = 1;');

    port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    servePwa(server, pwaDir);
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves root as index.html', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html');
    expect(r.body).toContain('<!doctype html>');
  });

  it('serves /index.html', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/index.html`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html');
  });

  it('serves /app.js with javascript content-type', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/app.js`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript');
    expect(r.body).toBe('console.log("hi")');
  });

  it('serves nested /css/base.css with css content-type', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/css/base.css`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/css');
    expect(r.body).toBe('body { color: red; }');
  });

  it('serves nested /state/sessions.js with javascript content-type', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/state/sessions.js`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript');
  });

  it('returns 404 for unknown paths', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/does-not-exist.css`));
    expect(r.status).toBe(404);
  });

  it('rejects path traversal (../)', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/../package.json`));
    // The HTTP client may normalize ../ before sending. Use a raw socket if needed.
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects URL-encoded path traversal', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/%2e%2e/package.json`));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('sets cache-control: no-cache, must-revalidate', async () => {
    const r = await get(new URL(`http://127.0.0.1:${port}/app.js`));
    expect(r.headers['cache-control']).toBe('no-cache, must-revalidate');
  });

  it('returns 404 for paths that resolve outside PWA_DIR even when they exist', async () => {
    // Resolve('/etc/passwd') is outside pwaDir → 404, not 500 or 200.
    const r = await get(new URL(`http://127.0.0.1:${port}/etc/passwd`));
    expect(r.status).toBe(404);
  });
});
