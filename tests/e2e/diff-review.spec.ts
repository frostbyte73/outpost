import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

const SEED_SESSION_ID = '22222222-3333-4444-5555-666666666666';
const SEED_BRANCH = 'outpost/22222222';

function seedJsonl(id: string, cwd: string): string {
  return JSON.stringify({
    type: 'summary',
    sessionId: id,
    cwd,
    timestamp: new Date(0).toISOString(),
    summary: 'seeded diff-review session',
  }) + '\n';
}

const seededTest = test.extend<{ seedRepo: string; wtPath: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-diffreview-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    execFileSync('git', ['-C', repo, 'add', 'a.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    await use(repo);
  },
  // Stash the worktree path so the test body can reach it from the fixture chain.
  wtPath: async ({ seedRepo }, use) => {
    await use(join(seedRepo, '.outpost-e2e-diffwt'));
  },
  daemon: async ({ seedRepo, wtPath }, use) => {
    // Build a worktree on a fresh branch, then commit a real change on it so the
    // branch-vs-main diff has something to render.
    execFileSync('git', ['-C', seedRepo, 'worktree', 'add', '-b', SEED_BRANCH, wtPath, 'main']);
    writeFileSync(join(wtPath, 'a.txt'), 'one\nTWO\nthree\n');
    execFileSync('git', ['-C', wtPath, 'add', 'a.txt']);
    execFileSync('git', ['-C', wtPath, '-c', 'user.email=test@example', '-c', 'user.name=Test',
      'commit', '-q', '-m', 'change']);

    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [
        { cwd: wtPath, sessions: [{ id: SEED_SESSION_ID, jsonl: seedJsonl(SEED_SESSION_ID, wtPath) }] },
      ],
      initialWorktrees: [
        { sessionId: SEED_SESSION_ID, projectCwd: seedRepo, worktreePath: wtPath, branch: SEED_BRANCH, baseBranch: 'main' },
      ],
    });
    await use(handle);
    await handle.stop();
  },
});

async function ensureSectionOpen(page: import('@playwright/test').Page, cwd: string): Promise<void> {
  const section = page.locator(`.project-section[data-cwd="${cwd}"]`);
  await expect(section).toHaveCount(1, { timeout: 5_000 });
  const open = await section.evaluate((el) => el.classList.contains('project-section-open'));
  if (!open) await section.locator('.project-section-header').click();
  await expect(section).toHaveClass(/project-section-open/);
}

seededTest('user can leave inline comments on the branch diff and submit a bundled review', async ({ outpostPage, seedRepo }) => {
  await ensureSectionOpen(outpostPage, seedRepo);

  // Open the seeded session.
  await outpostPage.locator(`.session-row[data-id="${SEED_SESSION_ID}"]`).click();
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // The header button appears for sessions with an active worktree.
  await expect(outpostPage.locator('#open-diff-review')).toBeVisible();
  await outpostPage.locator('#open-diff-review').click();
  await expect(outpostPage.locator('#diff-overlay')).toBeVisible();

  // The one changed file shows up in the file list and the diff body.
  await expect(outpostPage.locator('#diff-file-list .diff-file-link')).toHaveCount(1);
  await expect(outpostPage.locator('#diff-file-list .diff-file-path')).toHaveText('a.txt');

  // Click the `+ TWO` added line and leave a comment.
  await outpostPage.locator('#diff-content .diff-row.diff-add', { hasText: 'TWO' }).first().click();
  const ta = outpostPage.locator('#diff-content .diff-comment-form textarea');
  await expect(ta).toBeVisible();
  await ta.fill('Should this be lowercase?');
  await outpostPage.locator('#diff-content .diff-comment-form button[type="submit"]').click();

  // A chip should now exist; submit button should be enabled with the right count.
  await expect(outpostPage.locator('#diff-content .diff-comment-card')).toHaveCount(1);
  await expect(outpostPage.locator('#diff-send')).toBeEnabled();
  await expect(outpostPage.locator('#diff-send')).toHaveText('Submit');

  // Submit.
  await outpostPage.locator('#diff-send').click();
  await expect(outpostPage.locator('#diff-overlay')).toBeHidden();

  // The bundled user message should land in the transcript.
  await expect(outpostPage.locator('#transcript')).toContainText('Should this be lowercase?');
  await expect(outpostPage.locator('#transcript')).toContainText('a.txt:2');
});
