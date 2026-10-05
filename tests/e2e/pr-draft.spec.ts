import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

// Squash & open PR publishes the commit box's text as the PR, and that text is the last round's.
// Once a branch holds several rounds, the overlay drafts the PR's own title and description from
// the whole branch. The draft and the finalize are intercepted here: no model runs, no PR opens.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SESSION = '33333333-4444-5555-6666-777777777777';
const BRANCH = 'outpost/33333333';

function seededWithRounds(rounds: number) {
  return test.extend<{ daemon: DaemonHandle }>({
    daemon: async ({}, use) => {
      const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-prdraft-'));
      const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', ...a]);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      writeFileSync(join(repo, 'a.txt'), 'zero\n');
      git('add', 'a.txt'); git('commit', '-q', '-m', 'init');
      const wt = join(repo, '.wt');
      git('worktree', 'add', '-q', '-b', BRANCH, wt, 'main');
      for (let i = 1; i <= rounds; i++) {
        writeFileSync(join(wt, 'a.txt'), `zero\n${'x\n'.repeat(i)}`);
        execFileSync('git', ['-C', wt, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-am', `Round ${i}`]);
      }
      const jsonl = JSON.stringify({ type: 'summary', sessionId: SESSION, cwd: wt, timestamp: new Date(0).toISOString(), summary: 'rounds' }) + '\n';
      const handle = await startDaemon({
        fixturePath: FIXTURE,
        initialProjects: [{ cwd: wt, sessions: [{ id: SESSION, jsonl }] }],
        initialWorktrees: [{ sessionId: SESSION, projectCwd: repo, worktreePath: wt, branch: BRANCH, baseBranch: 'main' }],
      });
      await use(handle);
      await handle.stop();
    },
  });
}

async function openDiff(page: Page) {
  await page.locator('.o-sidebar-item[data-surface="sessions"]').click();
  await page.locator(`.sess-card[data-session-id="${SESSION}"]`).click();
  await expect(page.locator('.sv-composer')).toBeVisible({ timeout: 10_000 });
  await page.locator('.sv-header-menu-btn').click();
  await page.locator('.sv-header-menu-item[data-action="open-diff"]').click();
  await expect(page.locator('.dr-overlay')).toBeVisible();
  await expect(page.locator('#dr-primary-btn')).toHaveText('Squash, push & open PR');
}

seededWithRounds(1)('a single round keeps the commit message as the PR text', async ({ outpostPage }) => {
  let drafted = false;
  await outpostPage.route('**/git/pr-draft', (r) => { drafted = true; return r.fulfill({ json: { title: 'x', body: 'y' } }); });
  await openDiff(outpostPage);
  await expect(outpostPage.locator('.dr-pr-draft')).toHaveCount(0);
  expect(drafted).toBe(false);
});

seededWithRounds(2)('several rounds get their own drafted PR title and description', async ({ outpostPage }) => {
  await outpostPage.route('**/git/pr-draft', (r) => r.fulfill({ json: { title: 'Count past zero', body: 'Both rounds, described.' } }));
  let finalize: Record<string, unknown> | null = null;
  await outpostPage.route('**/git/finalize', (r) => {
    finalize = r.request().postDataJSON();
    return r.fulfill({ status: 409, json: { ok: false, stderr: 'stubbed', stdout: '' } });
  });
  await openDiff(outpostPage);

  await expect(outpostPage.locator('.dr-pr-draft .dr-pr-title')).toHaveValue('Count past zero');
  await expect(outpostPage.locator('.dr-pr-draft .dr-pr-body')).toHaveValue('Both rounds, described.');
  await expect(outpostPage.locator('.dr-pr-draft .dr-pr-status')).toHaveText('◐ drafted from 2 rounds');

  await outpostPage.locator('#dr-commit-textarea').fill('Round 2 tidy-up');
  await outpostPage.locator('.dr-pr-draft .dr-pr-title').fill('Count past zero, twice');
  await outpostPage.locator('#dr-primary-btn').click();
  await expect.poll(() => finalize).not.toBeNull();
  expect(finalize).toMatchObject({ kind: 'squash-to-branch', prTitle: 'Count past zero, twice', prBody: 'Both rounds, described.' });
});
