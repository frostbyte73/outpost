import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerSessionSeenRoute } from '../../src/routes/sessions.js';
import { SessionSeenStore } from '../../src/storage/session-seen-store.js';
import { freePort } from '../e2e/harness/port.js';

function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('POST /api/sessions/:id/seen', () => {
  it('marks the session seen and tells every client', async () => {
    let now = 1000;
    const seenStore = new SessionSeenStore(join(mkdtempSync(join(tmpdir(), 'seen-route-')), 'seen.json'), () => now);
    const notified: object[] = [];
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerSessionSeenRoute(server, { seenStore, notify: (m) => notified.push(m) });
    await server.listen();

    now = 4000;
    const res = await post(port, '/api/sessions/abc-1/seen');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ seenAt: 4000 });
    expect(seenStore.seenAt('abc-1')).toBe(4000);
    expect(notified).toEqual([{ type: 'session_activity', sessionId: 'abc-1', seenAt: 4000 }]);
  });
});
