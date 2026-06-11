import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-edit.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-accept-edits';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('accept-edits ON: Edit tool flows through without manual approval', async ({ daemon, outpostPage }) => {
  // Switch to accept-edits mode via the segmented control BEFORE opening a session,
  // so the client-side auto-approve mirror is armed when the fixture's first Edit tool_use lands.
  await outpostPage.locator('.settings-btn').click();
  await outpostPage.locator('#permission-modes button[data-mode="accept-edits"]').click();
  await expect(outpostPage.locator('#permission-modes button[data-mode="accept-edits"]')).toHaveAttribute('aria-pressed', 'true');
  await outpostPage.locator('#sheet-close').click();

  // Open a new session.
  await outpostPage.locator('#new-session').click();
  await outpostPage.locator('#cwd-picker-custom-input').fill(TEST_CWD);
  await outpostPage.locator('#cwd-picker-custom-form button[type=submit]').click();

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await outpostPage.keyboard.type('rename foo to bar in a.txt');
  await outpostPage.keyboard.press('Enter');

  // Final text appears (means Edit was auto-allowed and fixture continued past tool_result).
  await expect(outpostPage.getByText('edit applied')).toBeVisible({ timeout: 10_000 });

  // No leftover pending approvals.
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect((await res.json()).pending).toHaveLength(0);
});
