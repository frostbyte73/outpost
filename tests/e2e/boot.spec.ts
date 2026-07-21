import { test, expect } from './harness/browser.js';

test('PWA loads and shows version from /api/info', async ({ daemon, outpostPage }) => {
  await expect(outpostPage).toHaveTitle(/Outpost/i);
  // Hit the API directly to confirm the daemon is fully wired (cert, ports, routes).
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/info`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.version).toBeDefined();
  expect(typeof body.approvalTimeoutMs).toBe('number');
});

test('session list area is present even with no projects', async ({ outpostPage }) => {
  // The "+ new session" / "+ Add project" button should be in the DOM, even with zero projects.
  const buttons = outpostPage.locator('button');
  await expect(buttons.first()).toBeVisible({ timeout: 5000 });
});
