import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'long-running.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-interrupt';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('clicking Stop interrupts the claude subprocess and surfaces proc_exit', async ({ outpostPage }) => {
  await outpostPage.locator('#new-session').click();
  await outpostPage.locator('#cwd-picker-custom-input').fill(TEST_CWD);
  await outpostPage.locator('#cwd-picker-custom-form button[type=submit]').click();

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await outpostPage.keyboard.type('go');
  await outpostPage.keyboard.press('Enter');

  // First assistant chunk renders.
  await expect(outpostPage.getByText('working on it')).toBeVisible({ timeout: 10_000 });

  // While the mock is paused waiting for input, the daemon-side claude is still alive
  // and the send button doubles as Stop. Click it.
  await outpostPage.locator('#send').click();

  // Daemon sends daemon_proc_exit; the PWA shows "Session subprocess exited".
  await expect(outpostPage.getByText(/subprocess exited/i)).toBeVisible({ timeout: 10_000 });

  // The second assistant chunk "done!" must NOT appear (process was killed before).
  await expect(outpostPage.getByText(/^done!$/)).toHaveCount(0);
});
