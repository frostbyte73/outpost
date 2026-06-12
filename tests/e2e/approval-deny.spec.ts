import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-only.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-approval-deny';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('Deny resolves the approval; mock claude emits deny tool_result instead of "done"', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await outpostPage.keyboard.type('do the thing');
  await outpostPage.keyboard.press('Enter');

  // Wait for the approval card.
  await expect(outpostPage.getByText(/incident_update/i).first()).toBeVisible({ timeout: 10_000 });

  // Click Reject — this now opens the inline note form rather than deciding immediately.
  await outpostPage.locator('button.reject').first().click();

  // The textarea appears in place of the Approve/Reject pair.
  const textarea = outpostPage.locator('textarea.approval-reject-reason').first();
  await expect(textarea).toBeVisible({ timeout: 2_000 });

  // Type a reason so the rejection appears in the feed.
  await textarea.fill('not the right tool for this');

  // Send the rejection with the typed note.
  await outpostPage.locator('button.reject-send').first().click();

  // The rejection should appear in the feed: "Rejected" tag + the user's note.
  await expect(outpostPage.locator('.tool-reject-tag').first()).toBeVisible({ timeout: 5_000 });
  await expect(outpostPage.getByText('not the right tool for this')).toBeVisible({ timeout: 5_000 });

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
