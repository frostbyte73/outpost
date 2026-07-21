import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'long-running.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-interrupt';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('clicking Stop interrupts the claude subprocess and silently resumes the session', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

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

  // The user-initiated interrupt should NOT produce the "subprocess exited" error tile —
  // the PWA treats it as expected and silently resumes the session.
  await outpostPage.waitForTimeout(1_000);
  await expect(outpostPage.getByText(/subprocess exited/i)).toHaveCount(0);

  // The composer is still present (still in the session view, not bounced to the picker).
  await expect(composer).toBeVisible();

  // The second assistant chunk "done!" must NOT appear (process was killed before).
  await expect(outpostPage.getByText(/^done!$/)).toHaveCount(0);

  // Regression: after the interrupt the session is idle-but-resumable. Typing a
  // message must leave the send button live (armed, not muted) so the next send
  // can reconnect — previously it stayed wedged behind the disconnected mute
  // until the user reloaded the session.
  await composer.click();
  await outpostPage.keyboard.type('keep going');
  const send = outpostPage.locator('#send');
  await expect(send).toHaveClass(/\barmed\b/);
  await expect(send).not.toHaveClass(/sv-send-disconnected/);
});
