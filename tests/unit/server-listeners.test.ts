import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Server } from '../../src/server.js';
import { selfSignedCert } from '../e2e/harness/tls.js';
import { freePort } from '../e2e/harness/port.js';

function get(url: URL, ca?: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      host: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: 'GET',
      ...(ca ? { ca } : {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Server two-listener support', () => {
  it('serves routes on HTTP-only when https is omitted', async () => {
    const httpPort = await freePort();
    const server = new Server({ httpPort, heartbeatMs: 0 });
    server.route('GET', '/ping', (_req, res) => { res.statusCode = 200; res.end('pong'); });
    await server.listen();
    try {
      const r = await get(new URL(`http://127.0.0.1:${httpPort}/ping`));
      expect(r.status).toBe(200);
      expect(r.body).toBe('pong');
    } finally {
      await server.close();
    }
  });

  it('serves the same route on BOTH listeners when both are configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-'));
    const { certPath, keyPath } = selfSignedCert(dir, '127.0.0.1');
    const ca = readFileSync(certPath);
    const httpPort = await freePort();
    const httpsPort = await freePort();
    const server = new Server({
      httpPort,
      https: { certPath, keyPath, bindAddress: '127.0.0.1', httpsPort },
      heartbeatMs: 0,
    });
    server.route('GET', '/ping', (_req, res) => { res.statusCode = 200; res.end('pong'); });
    await server.listen();
    try {
      const a = await get(new URL(`http://127.0.0.1:${httpPort}/ping`));
      const b = await get(new URL(`https://127.0.0.1:${httpsPort}/ping`), ca);
      expect(a.status).toBe(200);
      expect(a.body).toBe('pong');
      expect(b.status).toBe(200);
      expect(b.body).toBe('pong');
    } finally {
      await server.close();
    }
  });

  it('serves HTTPS-only when httpPort is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-'));
    const { certPath, keyPath } = selfSignedCert(dir, '127.0.0.1');
    const ca = readFileSync(certPath);
    const httpsPort = await freePort();
    const server = new Server({
      httpPort: null,
      https: { certPath, keyPath, bindAddress: '127.0.0.1', httpsPort },
      heartbeatMs: 0,
    });
    server.route('GET', '/ping', (_req, res) => { res.statusCode = 200; res.end('pong'); });
    await server.listen();
    try {
      const r = await get(new URL(`https://127.0.0.1:${httpsPort}/ping`), ca);
      expect(r.status).toBe(200);
      expect(r.body).toBe('pong');
    } finally {
      await server.close();
    }
  });

  it('throws when constructed with neither listener', () => {
    expect(() => new Server({ httpPort: null, heartbeatMs: 0 })).toThrow(/at least one listener/);
  });
});
