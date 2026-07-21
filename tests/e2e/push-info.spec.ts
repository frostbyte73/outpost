import { test, expect } from './harness/browser.js';

test('GET /api/info includes a non-empty vapidPublicKey', async ({ daemon, outpostPage }) => {
  const r = await outpostPage.request.get(`${daemon.baseUrl}/api/info`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(typeof body.vapidPublicKey).toBe('string');
  // VAPID public key is base64url of an uncompressed P-256 point (65 bytes) ≈ 87 chars.
  expect(body.vapidPublicKey.length).toBeGreaterThan(40);
  expect(body.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]+$/);
});
