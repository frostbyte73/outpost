import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-allow.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-bypass-mode';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('bypass mode allows mcp__incident-io__incident_update without any approval card', async ({ daemon, outpostPage }) => {
  // Switch to bypass mode via the segmented control BEFORE opening a session (settings
  // is only accessible from the list view). Use the 2-tap confirm gesture.
  await outpostPage.locator('.settings-btn').click();
  await outpostPage.locator('#permission-modes button[data-mode="bypass"]').click();
  // First tap arms; aria-pressed stays false but button text becomes "Tap again to confirm".
  await expect(outpostPage.locator('#permission-modes button[data-mode="bypass"]')).toHaveText(/tap again to confirm/i);
  await outpostPage.locator('#permission-modes button[data-mode="bypass"]').click();
  await expect(outpostPage.locator('#permission-modes button[data-mode="bypass"]')).toHaveAttribute('aria-pressed', 'true');
  await outpostPage.locator('#sheet-close').click();

  // Open a session.
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Wait for the WS to connect before sending (mirrors plan-mode.spec.ts).
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    { timeout: 10_000 }
  );

  // Wait for bypass to be server-confirmed. Segmented-control buttons are only in DOM
  // while settings is open — in session view they're absent. Poll JS state directly.
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostGetState?.()?.approvalMode === 'bypass',
    undefined,
    { timeout: 10_000 },
  );

  // Trigger the tool call.
  await composer.click();
  await outpostPage.keyboard.type('go');
  await outpostPage.keyboard.press('Enter');

  // The fixture's "done" assistant line appears AFTER the tool result. Its presence
  // proves the bypass-allowed tool ran end-to-end with no human gate.
  await expect(outpostPage.getByText(/^done$/)).toBeVisible({ timeout: 10_000 });

  // Sanity: no approval card was ever rendered.
  await expect(outpostPage.locator('button.approve')).toHaveCount(0);

  // Pending queue is empty.
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect((await res.json()).pending).toHaveLength(0);
});
