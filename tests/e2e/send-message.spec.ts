import { mkdirSync } from 'node:fs';
import { test, expect } from './harness/browser.js';

const TEST_CWD = '/tmp/outpost-e2e-send-msg';

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('typing a message and pressing Enter produces an assistant response', async ({ outpostPage }) => {
  // Open the new-session sheet.
  await outpostPage.locator('#new-session').click();

  // No recents in the fresh test daemon; type a custom cwd and submit.
  await outpostPage.locator('#cwd-picker-custom-input').fill(TEST_CWD);
  await outpostPage.locator('#cwd-picker-custom-form button[type=submit]').click();

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
