import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-allow.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-push-deeplink';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => { mkdirSync(TEST_CWD, { recursive: true }); });

test('cold-start ?session=&approval= opens session and locates approval card', async ({ daemon, outpostPage }) => {
  // Spin up a session + approval the normal way first.
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.click();
  await outpostPage.keyboard.type('go');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.getByText(/incident_update/i).first()).toBeVisible({ timeout: 10_000 });

  // Grab the approval id from the daemon.
  const r = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  const data = await r.json();
  const pending = data.pending[0];
  expect(pending).toBeTruthy();

  // Cold-launch via the deep link.
  await outpostPage.goto(`${daemon.baseUrl}/?session=${encodeURIComponent(pending.sessionId)}&approval=${encodeURIComponent(pending.approvalId)}`);

  // Session view active.
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // Card with the data-approval-id is in the DOM and visible.
  const card = outpostPage.locator(`.approval-card[data-approval-id="${pending.approvalId}"]`);
  await expect(card).toBeVisible({ timeout: 5_000 });

  // URL query string was stripped after consumption.
  expect(new URL(outpostPage.url()).search).toBe('');
});
