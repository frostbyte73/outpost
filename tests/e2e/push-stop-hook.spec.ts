import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';
import { selfSignedCert } from './harness/tls.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LONG = resolvePath(__dirname, 'fixtures', 'long-turn-with-stop.jsonl');
const SHORT = resolvePath(__dirname, 'fixtures', 'short-turn-with-stop.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-push-stop';

const VAPID_KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};

const FAKE_PUSH_CERT_DIR = mkdtempSync(join(tmpdir(), 'fakepush-stop-'));
const FAKE_PUSH_TLS = selfSignedCert(FAKE_PUSH_CERT_DIR, '127.0.0.1');

async function startFakePush() {
  const arrivals: Array<{ url?: string }> = [];
  const server: HttpsServer = createHttpsServer(
    { cert: readFileSync(FAKE_PUSH_TLS.certPath), key: readFileSync(FAKE_PUSH_TLS.keyPath) },
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { arrivals.push({ url: req.url }); res.statusCode = 201; res.end(); });
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `https://127.0.0.1:${port}/push/stop-device`,
    arrivals,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test.beforeAll(() => { mkdirSync(TEST_CWD, { recursive: true }); });

test.describe('Stop hook fires push when turn >= threshold', () => {
  test.use({
    daemonOpts: {
      fixturePath: LONG,
      extraEnv: { OUTPOST_STOP_THRESHOLD_MS: '10', OUTPOST_PUSH_CA_PATH: FAKE_PUSH_TLS.certPath },
    },
  });

  test('arrival lands at fake endpoint', async ({ daemon, outpostPage }) => {
    const fake = await startFakePush();
    try {
      await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
        data: { subscription: { endpoint: fake.endpoint, keys: VAPID_KEYS } },
      });
      await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
      const composer = outpostPage.locator('#composer');
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await composer.click();
      await outpostPage.keyboard.type('go');
      await outpostPage.keyboard.press('Enter');
      await expect.poll(() => fake.arrivals.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    } finally {
      await fake.stop();
    }
  });
});

test.describe('Stop hook does NOT fire push when turn < threshold', () => {
  test.use({
    daemonOpts: {
      fixturePath: SHORT,
      extraEnv: { OUTPOST_STOP_THRESHOLD_MS: '60000', OUTPOST_PUSH_CA_PATH: FAKE_PUSH_TLS.certPath },
    },
  });

  test('no arrival at fake endpoint', async ({ daemon, outpostPage }) => {
    const fake = await startFakePush();
    try {
      await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
        data: { subscription: { endpoint: fake.endpoint, keys: VAPID_KEYS } },
      });
      await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
      const composer = outpostPage.locator('#composer');
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await composer.click();
      await outpostPage.keyboard.type('short');
      await outpostPage.keyboard.press('Enter');
      await expect(outpostPage.getByText(/^done\.$/).first()).toBeVisible({ timeout: 10_000 });
      // Give the Stop hook a chance to fire (mock claude POSTs to /hook/stop after the
      // marker — the daemon then evaluates threshold). 500ms is plenty.
      await new Promise((r) => setTimeout(r, 500));
      expect(fake.arrivals).toHaveLength(0);
    } finally {
      await fake.stop();
    }
  });
});
