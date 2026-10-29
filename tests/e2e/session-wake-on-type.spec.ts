import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8')
  .replaceAll('2026-06-10T', `${new Date().toISOString().slice(0, 10)}T`);
const SESSION = '66666666-6666-6666-6666-666666666666';

const seededTest = test.extend<{ daemon: DaemonHandle }>({
  daemon: async ({}, use) => {
    const cwd = mkdtempSync(join(tmpdir(), 'outpost-e2e-wake-'));
    execFileSync('git', ['init', '-q', '-b', 'main', cwd]);
    const handle = await startDaemon({ fixturePath: FIXTURE, initialProjects: [{ cwd, sessions: [{ id: SESSION, jsonl: SEED_JSONL.replaceAll('/tmp/seeded-project', cwd) }] }] });
    await use(handle);
    await handle.stop();
  },
});

async function runState(page: import('@playwright/test').Page, daemon: DaemonHandle): Promise<string | undefined> {
  const res = await page.request.get(`${daemon.baseUrl}/api/sessions`);
  const { projects } = await res.json() as { projects: { sessions: { id: string; runState?: string }[] }[] };
  return projects.flatMap((p) => p.sessions).find((s) => s.id === SESSION)?.runState;
}

seededTest('opening a session shows history without spawning; typing wakes it', async ({ outpostPage, daemon }) => {
  await outpostPage.evaluate((id) => {
    // @ts-expect-error — test hook from app.js
    globalThis.__outpostOpenSession?.({ id });
  }, SESSION);
  const composer = outpostPage.locator('.sv-composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await outpostPage.waitForTimeout(500);
  expect(await runState(outpostPage, daemon)).toBe('idle');

  await composer.click();
  await outpostPage.keyboard.type('h');
  await expect.poll(() => runState(outpostPage, daemon), { timeout: 5_000 }).not.toBe('idle');

  await outpostPage.keyboard.type('i');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.getByRole('log').getByText('hello back')).toBeVisible({ timeout: 10_000 });
});
