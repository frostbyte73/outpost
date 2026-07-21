import { test, expect } from './harness/browser.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FAKE_ENDPOINT_A = 'https://fake-push-service.example.test/abc';
const FAKE_ENDPOINT_B = 'https://fake-push-service.example.test/def';

test('subscribe POST persists to push-subscriptions.json with 0600', async ({ daemon, outpostPage }) => {
  const subsPath = join(daemon.runtimeDir, 'push-subscriptions.json');
  expect(existsSync(subsPath)).toBeFalsy();

  const r = await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: {
      subscription: {
        endpoint: FAKE_ENDPOINT_A,
        keys: {
          p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      },
      userAgent: 'playwright-test',
    },
  });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.count).toBe(1);
  expect(existsSync(subsPath)).toBeTruthy();
  const j = JSON.parse(readFileSync(subsPath, 'utf8'));
  expect(j.records).toHaveLength(1);
  expect(j.records[0].endpoint).toBe(FAKE_ENDPOINT_A);
});

test('subscribe is idempotent on same endpoint (count stays 1)', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { subscription: { endpoint: FAKE_ENDPOINT_A, keys: { p256dh: 'pk1', auth: 'auth1' } } },
  });
  const r = await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { subscription: { endpoint: FAKE_ENDPOINT_A, keys: { p256dh: 'pk1', auth: 'auth1' } } },
  });
  expect((await r.json()).count).toBe(1);
});

test('DELETE removes the subscription', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { subscription: { endpoint: FAKE_ENDPOINT_A, keys: { p256dh: 'pk', auth: 'auth' } } },
  });
  await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { subscription: { endpoint: FAKE_ENDPOINT_B, keys: { p256dh: 'pk', auth: 'auth' } } },
  });
  const r = await outpostPage.request.delete(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { endpoint: FAKE_ENDPOINT_A },
  });
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).count).toBe(1);
});

test('rejects malformed subscription payloads', async ({ daemon, outpostPage }) => {
  const r1 = await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { subscription: { endpoint: 'not-a-url', keys: { p256dh: 'p', auth: 'a' } } },
  });
  expect(r1.status()).toBe(400);

  const r2 = await outpostPage.request.post(`${daemon.baseUrl}/api/push/subscribe`, {
    data: { subscription: { endpoint: 'https://x', keys: {} } },
  });
  expect(r2.status()).toBe(400);
});
