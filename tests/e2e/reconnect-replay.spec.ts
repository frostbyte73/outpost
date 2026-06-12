import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_CWD = '/tmp/outpost-e2e-reconnect-replay';
const FIXTURE = resolvePath(__dirname, 'fixtures', 'two-turn.jsonl');

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

// Use the two-turn fixture so the mock claude proc stays alive between sends, letting
// us drop and reconnect the session WS without the proc exiting.
test.use({ daemonOpts: { fixturePath: FIXTURE } });

test('reconnect with ?since=N replays missed messages', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // Send the first prompt and wait for the response. This populates the event log on
  // the server and advances lastSeenSeq on the client.
  await outpostPage.locator('#composer').click();
  await outpostPage.keyboard.type('first');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.getByText('hello back')).toBeVisible({ timeout: 10_000 });

  // Capture lastSeenSeq before the drop — should be > 0 (assistant message stamped one).
  const seqBeforeDrop = await outpostPage.evaluate(() => {
    return globalThis.__outpostGetState?.().lastSeenSeq ?? 0;
  });
  expect(seqBeforeDrop, 'lastSeenSeq advances after the first assistant response').toBeGreaterThan(0);

  // Force-close the session WS. The existing backoff timer will reconnect.
  await outpostPage.evaluate(() => globalThis.__outpostForceCloseSessionWs?.());

  // Wait for the new WS to reach OPEN.
  await outpostPage.waitForFunction(
    () => globalThis.__outpostSessionWsReadyState?.() === 1,
    null,
    { timeout: 5_000 },
  );

  // Server should have replayed the same events on reconnect because we send ?since=N
  // and the log still has them. lastSeenSeq stays >= the pre-drop value (the replay
  // re-delivered events with the same seqs, and the client's `>` guard prevents regression).
  const seqAfterReconnect = await outpostPage.evaluate(() => {
    return globalThis.__outpostGetState?.().lastSeenSeq ?? 0;
  });
  expect(seqAfterReconnect).toBeGreaterThanOrEqual(seqBeforeDrop);

  // Send a second prompt and confirm new messages still flow.
  await outpostPage.locator('#composer').click();
  await outpostPage.keyboard.type('second');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.getByText('second response')).toBeVisible({ timeout: 10_000 });

  // lastSeenSeq advanced past the post-reconnect value once the new response landed.
  const seqAfterSecond = await outpostPage.evaluate(() => {
    return globalThis.__outpostGetState?.().lastSeenSeq ?? 0;
  });
  expect(seqAfterSecond).toBeGreaterThan(seqAfterReconnect);

  // No replay_gap should have fired — the log easily held the seqs from the first turn.
  const gapCount = await outpostPage.evaluate(() => {
    return globalThis.__outpostGetState?.().replayGapCount ?? 0;
  });
  expect(gapCount).toBe(0);

  // The transcript still shows exactly one "hello back" — replay deduped via seenBlockSigs.
  await expect(outpostPage.locator('.transcript').getByText('hello back')).toHaveCount(1);
});
