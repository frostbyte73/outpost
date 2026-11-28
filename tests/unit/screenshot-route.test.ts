import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerScreenshotRoutes } from '../../src/routes/screenshots.js';
import { freePort } from '../e2e/harness/port.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// Raw request: fetch would normalise `../` out of the path before the server ever saw it.
function get(port: number, path: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('GET /api/screenshots/:name', () => {
  it('serves only a regular file whose name is exactly the tool\'s shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shots-'));
    const dir = join(root, 'screenshots');
    const outside = join(root, 'secret.png');
    writeFileSync(outside, 'secret');
    mkdirSync(dir);
    writeFileSync(join(dir, '1795000000000-abcdef12.png'), PNG);
    symlinkSync(outside, join(dir, '1795000000001-abcdef12.png'));

    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerScreenshotRoutes(server, { screenshotsDir: dir });
    await server.listen();

    const ok = await get(port, '/api/screenshots/1795000000000-abcdef12.png');
    expect(ok.status).toBe(200);
    expect(ok.body.equals(PNG)).toBe(true);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-security-policy']).toBe("default-src 'none'");

    for (const path of [
      '/api/screenshots/1795000000001-abcdef12.png',
      '/api/screenshots/..%2Fsecret.png',
      '/api/screenshots/1795000000002-abcdef12.png',
    ]) {
      expect((await get(port, path)).status, path).toBe(404);
    }
  });
});
