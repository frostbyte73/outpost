import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_CWD = '/tmp/outpost-e2e-multi-device';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const FIXTURE = resolvePath(__dirname, 'fixtures', 'two-turn.jsonl');
// Inline JSONL with cwd set to TEST_CWD so SessionStore associates it with the right project.
const SEED_JSONL = [
  JSON.stringify({ type: 'summary', summary: 'Multi-device test session' }),
  JSON.stringify({ type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: 'hi' }, cwd: TEST_CWD }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T10:00:01Z', message: { id: 'msg_seed', role: 'assistant', content: [{ type: 'text', text: 'seeded' }], model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
].join('\n') + '\n';

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

// Seed a session on disk so device B can find it in the session list. The mock claude's
// two-turn fixture lets the same proc handle one message from each device.
test.use({
  daemonOpts: {
    fixturePath: FIXTURE,
    initialProjects: [{
      cwd: TEST_CWD,
      sessions: [{ id: SESSION_ID, jsonl: SEED_JSONL }],
    }],
  },
});

async function openSeededSession(page: import('@playwright/test').Page): Promise<void> {
  // Project section may load collapsed; expand if needed, then click the seeded row.
  const projectSection = page.locator(`.project-section[data-cwd="${TEST_CWD}"]`);
  await expect(projectSection).toBeVisible({ timeout: 10_000 });
  const isOpen = await projectSection.evaluate((el) => el.classList.contains('project-section-open'));
  if (!isOpen) {
    await projectSection.locator('.project-section-header').click();
  }
  const row = page.locator(`.session-row[data-id="${SESSION_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.locator('#composer')).toBeVisible({ timeout: 10_000 });
}

test('two devices on the same session see each other\'s activity', async ({ daemon, outpostPage, browser }) => {
  // Device A attaches first.
  await openSeededSession(outpostPage);

  // Device B: a second browser context against the same daemon.
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const pageB = await ctxB.newPage();
  try {
    await pageB.goto(daemon.baseUrl);
    await openSeededSession(pageB);

    // Send from device A → "hello back" on both devices.
    await outpostPage.locator('#composer').click();
    await outpostPage.keyboard.type('from-a');
    await outpostPage.keyboard.press('Enter');
    await expect(outpostPage.getByText('hello back')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByText('hello back')).toBeVisible({ timeout: 10_000 });

    // Send from device B → "second response" on both devices.
    await pageB.locator('#composer').click();
    await pageB.keyboard.type('from-b');
    await pageB.keyboard.press('Enter');
    await expect(pageB.getByText('second response')).toBeVisible({ timeout: 10_000 });
    await expect(outpostPage.getByText('second response')).toBeVisible({ timeout: 10_000 });

    // lastSeenSeq advanced on both devices through the fanout.
    const [seqA, seqB] = await Promise.all([
      outpostPage.evaluate(() => globalThis.__outpostGetState?.().lastSeenSeq ?? 0),
      pageB.evaluate(() => globalThis.__outpostGetState?.().lastSeenSeq ?? 0),
    ]);
    expect(seqA).toBeGreaterThan(0);
    expect(seqB).toBe(seqA);
  } finally {
    await ctxB.close();
  }
});
