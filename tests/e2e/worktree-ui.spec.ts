import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

let testRepo: string;
let nonRepo: string;

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeEach(() => {
  testRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-uirepo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', testRepo]);
  execFileSync('git', ['-C', testRepo, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', testRepo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', testRepo, 'commit', '--allow-empty', '-q', '-m', 'init']);
  execFileSync('git', ['-C', testRepo, 'branch', 'feature-x']);
  nonRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-uinotrepo-'));
});

async function ensureSectionOpen(page: import('@playwright/test').Page, cwd: string): Promise<void> {
  const section = page.locator(`.project-section[data-cwd="${cwd}"]`);
  await expect(section).toHaveCount(1, { timeout: 5_000 });
  const open = await section.evaluate((el) => el.classList.contains('project-section-open'));
  if (!open) await section.locator('.project-section-header').click();
  await expect(section).toHaveClass(/project-section-open/);
}

async function waitForWorktreeRecord(daemon: { runtimeDir: string }, timeoutMs = 5000): Promise<{
  sessionId: string; worktreePath: string; branch: string;
}> {
  const indexPath = join(daemon.runtimeDir, 'worktrees', 'index.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf8'));
        const live = (data.records as Array<{ sessionId: string; worktreePath: string; branch: string; archivedAt?: number; createdAt: number }>)
          .filter((r) => !r.archivedAt && r.worktreePath)
          .sort((a, b) => b.createdAt - a.createdAt);
        if (live.length > 0) return live[0]!;
      } catch { /* in-flight write — retry */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no live worktree record found');
}

test('branch picker populates with repo branches and a "+ New session" click spawns a worktree on the selected branch', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: testRepo } });
  await outpostPage.evaluate(async () => {
    // @ts-expect-error
    await globalThis.__outpostRefreshSessions?.();
  });
  // Expand the project section (registry projects are not auto-expanded unless they're
  // the most-recent one — clicking the header is the deterministic way).
  await ensureSectionOpen(outpostPage, testRepo);

  const picker = outpostPage.locator(`.project-section[data-cwd="${testRepo}"] .project-branch-select`);
  await expect(picker).toBeVisible();
  // Picker populates async via /api/projects/:sanitized/branches.
  await expect.poll(async () => picker.locator('option').count(), { timeout: 5_000 }).toBeGreaterThan(1);
  // 'main' should be the default selection.
  await expect(picker).toHaveValue('main');
  // Switch to feature-x.
  await picker.selectOption('feature-x');

  // Click "+ New session" — git-repo default = worktree on the picker-selected branch.
  await outpostPage.locator(`.project-new-session[data-cwd="${testRepo}"]`).click();

  const rec = await waitForWorktreeRecord(daemon);
  expect(rec.worktreePath).toContain('worktrees/');
  // Worktree's git HEAD should be on the picker-selected base.
  const headBranch = execFileSync('git', ['-C', testRepo, 'worktree', 'list', '--porcelain'])
    .toString();
  expect(headBranch).toContain(rec.branch);
  // Branch was created off feature-x — the worktree's parent rev should equal feature-x's rev.
  const featureRev = execFileSync('git', ['-C', testRepo, 'rev-parse', 'feature-x']).toString().trim();
  const wtRev = execFileSync('git', ['-C', rec.worktreePath, 'rev-parse', 'HEAD']).toString().trim();
  expect(wtRev).toBe(featureRev);
});

test('non-git project shows no branch picker and "+ New session" falls back to shared cwd', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: nonRepo } });
  await outpostPage.evaluate(async () => {
    // @ts-expect-error
    await globalThis.__outpostRefreshSessions?.();
  });
  await ensureSectionOpen(outpostPage, nonRepo);

  const picker = outpostPage.locator(`.project-section[data-cwd="${nonRepo}"] .project-branch-picker`);
  await expect(picker).toHaveCount(0);

  // Click "+ New session" — non-git → shared cwd, no worktree.
  await outpostPage.locator(`.project-new-session[data-cwd="${nonRepo}"]`).click();
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // No worktree record should have been created. Either no index, or no live record.
  await outpostPage.waitForTimeout(500);
  const indexPath = join(daemon.runtimeDir, 'worktrees', 'index.json');
  if (existsSync(indexPath)) {
    const data = JSON.parse(readFileSync(indexPath, 'utf8'));
    const live = (data.records as Array<{ archivedAt?: number; worktreePath: string }>)
      .filter((r) => !r.archivedAt && r.worktreePath);
    expect(live).toHaveLength(0);
  }
});

// Build a minimal valid JSONL so the session shows up in the project list. SessionStore
// extracts the cwd from the first valid JSONL line (firstCwdInJsonl), so the line MUST
// include a `cwd` field — otherwise the project never registers.
function seedJsonl(id: string, cwd: string): string {
  return JSON.stringify({
    type: 'summary',
    sessionId: id,
    cwd,
    timestamp: new Date(Date.now()).toISOString(),
    summary: 'seeded worktree session',
  }) + '\n';
}

// Compute the sanitized claude-projects dir for a given cwd — must mirror the daemon.
function sanitizeCwd(cwd: string): string { return cwd.replace(/\//g, '-'); }

// Extended test variant for the archive flow: needs both a JSONL seeded under the
// worktree's sanitized cwd AND a worktree record in index.json, both written before
// daemon boot. Overriding the `daemon` fixture directly (not `daemonOpts`) sidesteps
// the option-vs-fixture mismatch in the base harness.
import { startDaemon, type DaemonHandle } from './harness/daemon.js';
const seededTest = test.extend<{ seedRepo: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-uirepo-seed-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const wtBranch = 'outpost/11111111';
    const wtPath = join(seedRepo, '.outpost-e2e-wt');
    execFileSync('git', ['-C', seedRepo, 'worktree', 'add', '-b', wtBranch, wtPath, 'main']);
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [
        { cwd: wtPath, sessions: [{ id: SEED_SESSION_ID, jsonl: seedJsonl(SEED_SESSION_ID, wtPath) }] },
      ],
      initialWorktrees: [
        { sessionId: SEED_SESSION_ID, projectCwd: seedRepo, worktreePath: wtPath, branch: wtBranch, baseBranch: 'main' },
      ],
    });
    await use(handle);
    await handle.stop();
  },
});

const SEED_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SEED_BRANCH = 'outpost/11111111';

seededTest('overflow menu → Archive removes the worktree and the row shows archived state', async ({ seedRepo, outpostPage }) => {
  const wtPath = join(seedRepo, '.outpost-e2e-wt');

  // The seeded project auto-expands as the only/most-recent one. Locate by repo cwd.
  await ensureSectionOpen(outpostPage, seedRepo);

  const row = outpostPage.locator(`.session-row[data-id="${SEED_SESSION_ID}"]`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row.locator('.worktree-badge')).toContainText('⌥');
  await expect(row.locator('.worktree-badge')).toContainText(SEED_BRANCH);

  // Click ⋯ → Archive worktree → confirm.
  await row.locator('.session-overflow').click();
  const menu = outpostPage.locator('.session-overflow-menu');
  await expect(menu).toBeVisible();
  await menu.locator('button[data-action="archive"]').click();
  await outpostPage.locator('.confirm-sheet .confirm-danger').click();

  // Verify worktree dir + branch are gone.
  await expect.poll(() => existsSync(wtPath), { timeout: 5_000 }).toBe(false);
  const branches = execFileSync('git', ['-C', seedRepo, 'branch', '--list', SEED_BRANCH]).toString();
  expect(branches).not.toContain(SEED_BRANCH);

  // After the PWA refreshes the session list, the row should be marked archived.
  const archivedBadge = row.locator('.worktree-badge-archived');
  await expect(archivedBadge).toBeVisible({ timeout: 5_000 });
  await expect(row).toHaveClass(/session-row-archived/);
});
