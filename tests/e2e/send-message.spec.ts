import { mkdirSync } from 'node:fs';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const TEST_CWD = '/tmp/outpost-e2e-send-msg';

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('typing a message and pressing Enter produces an assistant response', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  // Wait for the composer to appear (session view skeleton).
  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Type into the contenteditable composer and press Enter (desktop chromium sends on Enter).
  await composer.click();
  await outpostPage.keyboard.type('hi');
  await outpostPage.keyboard.press('Enter');

  // The default fixture (simple-text-response.jsonl) emits "hello back" after seeing user input.
  await expect(outpostPage.getByText('hello back')).toBeVisible({ timeout: 10_000 });
});
