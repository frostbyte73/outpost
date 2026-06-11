import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-only.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-approval-deny';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('Deny resolves the approval; mock claude emits deny tool_result instead of "done"', async ({ daemon, outpostPage }) => {
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

  // Click Reject.
  await outpostPage.locator('button.reject').first().click();

  // Pending queue empties.
  await expect.poll(async () => {
    const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
    return (await res.json()).pending.length;
  }, { timeout: 5_000 }).toBe(0);

  // The "done" assistant text from the fixture must NOT appear (mock claude suppressed
  // it after the deny and emitted a synthetic deny tool_result instead).
  await outpostPage.waitForTimeout(500);
  await expect(outpostPage.getByText(/^done$/)).toHaveCount(0);
});
