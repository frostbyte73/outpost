import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-allow.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-approval-allow';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('approval card appears, Approve triggers the tool result and final text', async ({ daemon, outpostPage }) => {
  // Open new session in our test cwd.
  await outpostPage.locator('#new-session').click();
  await outpostPage.locator('#cwd-picker-custom-input').fill(TEST_CWD);
  await outpostPage.locator('#cwd-picker-custom-form button[type=submit]').click();

  // Send a prompt to trigger Claude to emit the tool_use.
  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await outpostPage.keyboard.type('do the thing');
  await outpostPage.keyboard.press('Enter');

  // Wait for the approval card. Tool name surfaces as "incident_update" in the label.
  await expect(outpostPage.getByText(/incident_update/i).first()).toBeVisible({ timeout: 10_000 });

  // Confirm the daemon has a pending approval before we click.
  const before = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  const beforeBody = await before.json();
  expect(beforeBody.pending).toHaveLength(1);

  // Click Approve.
  await outpostPage.locator('button.approve').first().click();

  // Final assistant text appears after the tool_result flows through.
  await expect(outpostPage.getByText(/^done$/).first()).toBeVisible({ timeout: 10_000 });

  // Pending queue empties.
  await expect.poll(async () => {
    const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
    return (await res.json()).pending.length;
  }, { timeout: 5_000 }).toBe(0);
});
