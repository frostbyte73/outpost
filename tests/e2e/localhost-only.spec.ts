import { test, expect } from '@playwright/test';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

test('daemon boots on plain HTTP when Tailscale is unavailable', async ({ page }) => {
  const daemon = await startDaemon({ fixturePath: FIXTURE, localhostOnly: true });
  try {
    expect(daemon.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const info = await page.request.get(`${daemon.baseUrl}/api/info`);
    expect(info.status()).toBe(200);
    const body = await info.json();
    expect(body.version).toBeDefined();

    await page.goto(daemon.baseUrl);
    await expect(page).toHaveTitle(/Outpost/i);
    await expect(page.locator('button').first()).toBeVisible({ timeout: 5000 });
  } finally {
    await daemon.stop();
  }
});
