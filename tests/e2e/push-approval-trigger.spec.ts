import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';
import { selfSignedCert } from './harness/tls.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-allow.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-push-approval';

// web-push hardcodes https:// for the subscription endpoint, so the fake push service has
// to speak TLS. Rather than disabling certificate verification, we hand the daemon the
// path to the test CA via OUTPOST_PUSH_CA_PATH so it trusts ONLY this cert. The cert is
// generated before the daemon spawns (in beforeAll) so the env var can carry the path.
const FAKE_PUSH_CERT_DIR = mkdtempSync(join(tmpdir(), 'fakepush-'));
const FAKE_PUSH_TLS = selfSignedCert(FAKE_PUSH_CERT_DIR, '127.0.0.1');

test.use({
  daemonOpts: {
    fixturePath: FIXTURE,
    extraEnv: { OUTPOST_PUSH_CA_PATH: FAKE_PUSH_TLS.certPath },
  },
});

test.beforeAll(() => { mkdirSync(TEST_CWD, { recursive: true }); });

test('daemon POSTs to subscription endpoint when an approval is enqueued', async ({ daemon, outpostPage }) => {
  const arrivedAt: Array<{ url?: string; method?: string; bytes: number }> = [];
  const fakePush = createHttpsServer(
    { cert: readFileSync(FAKE_PUSH_TLS.certPath), key: readFileSync(FAKE_PUSH_TLS.keyPath) },
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        arrivedAt.push({ url: req.url, method: req.method, bytes: body.length });
        res.statusCode = 201;
        res.end();
      });
    },
  );
  await new Promise<void>((r) => fakePush.listen(0, '127.0.0.1', () => r()));
  const port = (fakePush.address() as { port: number }).port;
  const endpoint = `https://127.0.0.1:${port}/push/test-device`;

  try {
    // RFC 8291 §5 test vectors — valid base64url, right length for web-push to accept.
    const subRes = await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
      data: {
        subscription: {
          endpoint,
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        },
      },
    });
    expect(subRes.ok()).toBeTruthy();

    await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
    const composer = outpostPage.locator('#composer');
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();
    await outpostPage.keyboard.type('go');
    await outpostPage.keyboard.press('Enter');

    await expect(outpostPage.getByText(/incident_update/i).first()).toBeVisible({ timeout: 10_000 });

    await expect.poll(() => arrivedAt.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    expect(arrivedAt[0]!.method).toBe('POST');
    expect(arrivedAt[0]!.url).toBe('/push/test-device');
  } finally {
    await new Promise<void>((r) => fakePush.close(() => r()));
  }
});
