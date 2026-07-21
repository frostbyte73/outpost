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

seededTest('user can leave an inline comment on the branch diff and submit a bundled review', async ({ outpostPage }) => {
  // Redesigned shell: no per-project accordion — navigate to the Sessions
  // surface, then open the seeded session from its card.
  await outpostPage.locator('.o-sidebar-item[data-surface="sessions"]').click();
  await outpostPage.locator(`.sess-card[data-session-id="${SEED_SESSION_ID}"]`).click();
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // Desktop hides the toolbar's `.sv-git-btn` (mobile-only — see session-view.css)
  // and folds "open diff" into the header's ⋯ menu instead, alongside Archive.
  await outpostPage.locator('.sv-header-menu-btn').click();
  await expect(outpostPage.locator('.sv-header-menu-item[data-action="open-diff"]')).toBeVisible();
  await outpostPage.locator('.sv-header-menu-item[data-action="open-diff"]').click();
  await expect(outpostPage.locator('.dr-overlay')).toBeVisible();

  // The one changed file shows up in the file list and the diff body.
  await expect(outpostPage.locator('#dr-files-list .dr-file-row')).toHaveCount(1);
  await expect(outpostPage.locator('#dr-files-list .dr-file-name')).toHaveText('a.txt');

  // Click the `+TWO` added line and leave a comment.
  await outpostPage.locator('#dr-viewport .dr-row.dr-add', { hasText: 'TWO' }).first().click();
  const ta = outpostPage.locator('#dr-viewport .dr-comment-form textarea');
  await expect(ta).toBeVisible();
  await ta.fill('Should this be lowercase?');
  await outpostPage.locator('#dr-viewport .dr-comment-form button[type="submit"]').click();

  // A chip should now exist; the primary CTA folds to "Submit review · N".
  await expect(outpostPage.locator('#dr-viewport .dr-comment-card')).toHaveCount(1);
  await expect(outpostPage.locator('#dr-primary-btn')).toHaveText('Submit review · 1');

  // Submit.
  await outpostPage.locator('#dr-primary-btn').click();
  await expect(outpostPage.locator('.dr-overlay')).toBeHidden();

  // The bundled user message lands in the transcript as a structured Review tile
  // (not a plain text bubble — that was the pre-fix bug: diff-overlay's message
  // never matched message-html.js's marker check).
  const tile = outpostPage.locator('.sv-transcript-inner .diff-review-msg');
  await expect(tile).toHaveCount(1);
  await expect(tile.locator('.dr-cite-file')).toHaveText('a.txt');
  await expect(tile.locator('.dr-cite-line')).toHaveText('L2');
  await expect(tile.locator('.dr-note')).toHaveText('Should this be lowercase?');
});
