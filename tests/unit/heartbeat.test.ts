import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { selfSignedCert } from '../e2e/harness/tls.js';
import { freePort } from '../e2e/harness/port.js';

// Trust the test CA explicitly rather than disabling TLS verification — the latter is
// a foot-gun even in test code.
async function withServer<T>(heartbeatMs: number, fn: (url: string, ca: Buffer) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'));
  const { certPath, keyPath } = selfSignedCert(dir, '127.0.0.1');
  const port = await freePort();
  const server = new Server({
    httpPort: null,
    https: { certPath, keyPath, bindAddress: '127.0.0.1', httpsPort: port },
    heartbeatMs,
  });
  await server.listen();
  const ca = readFileSync(certPath);
  try {
    return await fn(`wss://127.0.0.1:${port}`, ca);
  } finally {
    await server.close();
  }
}

describe('Server ws heartbeat', () => {
  it('keeps a healthy client connected past several heartbeat intervals', async () => {
    await withServer(60, async (url, ca) => {
      const ws = new WebSocket(`${url}/anything`, { ca });
      await new Promise<void>((r) => ws.on('open', r));
      // Wait long enough for 4-5 pings; the ws client auto-pongs by default.
      await new Promise((r) => setTimeout(r, 300));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  it('terminates a client that does not pong', async () => {
    await withServer(60, async (url, ca) => {
      const ws = new WebSocket(`${url}/anything`, { ca });
      await new Promise<void>((r) => ws.on('open', r));
      // Silence the auto-pong by removing the default 'ping' listener on the underlying
      // receiver before any ping arrives. `ws` defaults to replying to pings; this
      // suppresses that reply so the server marks the connection dead and terminates it.
      const receiver = (ws as unknown as { _receiver?: { removeAllListeners: (e: string) => void } })._receiver;
      receiver?.removeAllListeners('ping');
      const closed = new Promise<void>((r) => ws.on('close', r));
      // Reap happens on the second tick (≈120ms). Allow margin for CI jitter.
      await Promise.race([
        closed,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('not reaped')), 800)),
      ]);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  });
});
