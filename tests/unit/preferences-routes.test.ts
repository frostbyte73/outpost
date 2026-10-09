import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerPreferencesRoutes } from '../../src/routes/preferences.js';
import { PreferencesStore } from '../../src/storage/preferences-store.js';
import { freePort } from '../e2e/harness/port.js';

function patch(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/preferences', method: 'PATCH', headers: { 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function start() {
  const store = new PreferencesStore(join(mkdtempSync(join(tmpdir(), 'prefs-routes-')), 'preferences.json'));
  const port = await freePort();
  server = new Server({ httpPort: port, heartbeatMs: 0 });
  registerPreferencesRoutes(server, { preferencesStore: store, notify: () => {} });
  await server.listen();
  return { port, store };
}

describe('preapprovalDefaults', () => {
  it('stores a valid value', async () => {
    const { port, store } = await start();
    expect(await patch(port, { preapprovalDefaults: { syncBase: true } })).toBe(200);
    expect(store.getPreapprovalDefaults()).toEqual({ syncBase: true });
  });

  it('refuses a malformed value without storing any of the patch', async () => {
    const { port, store } = await start();
    expect(await patch(port, { theme: 'ink', preapprovalDefaults: { merge: 'yes' } })).toBe(400);
    expect(store.get()).toEqual({});
  });

  it('reads a malformed value already on disk as gated', async () => {
    const { store } = await start();
    store.merge({ preapprovalDefaults: { push: 'yes' } });
    expect(store.getPreapprovalDefaults()).toBeUndefined();
  });
});

describe('prReviewers', () => {
  it('stores logins and team slugs', async () => {
    const { port, store } = await start();
    expect(await patch(port, { prReviewers: ['livekit/core-services', 'alice'] })).toBe(200);
    expect(store.getPrReviewers()).toEqual(['livekit/core-services', 'alice']);
  });

  it('refuses an entry gh would read as a flag', async () => {
    const { port, store } = await start();
    expect(await patch(port, { prReviewers: ['--repo=evil/x'] })).toBe(400);
    expect(store.getPrReviewers()).toEqual([]);
  });
});
