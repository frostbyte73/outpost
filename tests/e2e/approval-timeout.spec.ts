import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-only.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-approval-timeout';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
  process.env.OUTPOST_APPROVAL_TIMEOUT_MS = '2000';
});

test.afterAll(() => {
  delete process.env.OUTPOST_APPROVAL_TIMEOUT_MS;
});

test('an unattended approval times out and resolves as deny', async ({ daemon, outpostPage }) => {
  await outpostPage.locator('#new-session').click();
  await outpostPage.locator('#cwd-picker-custom-input').fill(TEST_CWD);
  await outpostPage.locator('#cwd-picker-custom-form button[type=submit]').click();

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await outpostPage.keyboard.type('do the thing');
  await outpostPage.keyboard.press('Enter');

  // Wait for the approval card.
  await expect(outpostPage.getByText(/incident_update/i).first()).toBeVisible({ timeout: 10_000 });

  // Don't click anything. Wait past the 2s timeout.
  await outpostPage.waitForTimeout(2500);

  // Pending queue empties from the server-side timeout.
  await expect.poll(async () => {
    const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
    return (await res.json()).pending.length;
  }, { timeout: 5_000 }).toBe(0);
});
