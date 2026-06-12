import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_CWD = '/tmp/outpost-e2e-replay-gap';
const FIXTURE = resolvePath(__dirname, 'fixtures', 'two-turn.jsonl');

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

// Cap the event log at 1 event so the second push evicts the first — by the time we
// reconnect with a stale since=1, the server's earliestSeq will be > 1 and the
// replay_gap path fires.
test.use({ daemonOpts: { fixturePath: FIXTURE, eventLogMaxEvents: 1 } });

test('stale ?since= triggers replay_gap and catchUpFromDisk recovers', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // Two sends: total events pushed are init (seq=1), assistant#1 (seq=2), assistant#2
  // (seq=3). With cap=1, after the third push earliestSeq=3 and seqs 1+2 are gone.
  // Reconnecting with ?since=1 then satisfies the gap condition (1 < 3-1=2) and the
  // server emits replay_gap.
  await outpostPage.locator('#composer').click();
  await outpostPage.keyboard.type('one');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.getByText('hello back')).toBeVisible({ timeout: 10_000 });
  await outpostPage.locator('#composer').click();
  await outpostPage.keyboard.type('two');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.getByText('second response')).toBeVisible({ timeout: 10_000 });

  // Rewind lastSeenSeq to 1 so the reconnect's ?since=1 is stale, then force-close.
  await outpostPage.evaluate(() => {
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    globalThis.__outpostSetLastSeenSeq?.(1);
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    globalThis.__outpostForceCloseSessionWs?.();
  });

  // Wait for reconnect.
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostSessionWsReadyState?.() === 1,
    null,
    { timeout: 5_000 },
  );

  // Confirm replay_gap was received and counted.
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => (globalThis.__outpostGetState?.().replayGapCount ?? 0) >= 1,
    null,
    { timeout: 5_000 },
  );

  // The transcript still shows the original "hello back" — catchUpFromDisk refetched
  // it from /api/sessions/:id/messages and re-rendered it.
  await expect(outpostPage.locator('.transcript').getByText('hello back')).toHaveCount(1);
});
