import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
// Fresh timestamps: the fixture's own dates are older than the 7-day auto-archive window.
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8')
  .replaceAll('2026-06-10T', `${new Date().toISOString().slice(0, 10)}T`);

const JOB_ID = 'ckb-job-1';
const STEP_ID = 'ckb-step-1';
const STEP_SESSION = '44444444-4444-4444-4444-444444444444';
const MANUAL_SESSION = '55555555-5555-5555-5555-555555555555';

function seedJob(repoCwd: string) {
  const now = Date.now();
  return {
    id: JOB_ID, source: 'manual', title: 'Stop mergeable flapping', description: '', state: 'executing',
    steps: [{
      id: STEP_ID, type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix the watcher', description: '',
      workspace: { kind: 'writable', repoCwd, branch: 'outpost/ckb-step-1' }, goal: 'g', inputs: {},
      phase: 'spec', state: 'gate_pending_approval',
      gate: { draft: '## Problem\n\nUNKNOWN flaps.\n', question: 'Approve the spec?', requestedAt: now },
      artifacts: { spec: '## Problem\n\nUNKNOWN flaps.\n' },
      sessionId: STEP_SESSION, dispatches: [], inbox: [], roundsSpent: 1, consecutiveSelfRounds: 0,
      createdAt: now, updatedAt: now,
    }],
    createdAt: now, updatedAt: now,
  };
}

const seededTest = test.extend<{ seedRepo: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-ckb-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [{ cwd: seedRepo, sessions: [{ id: MANUAL_SESSION, jsonl: SEED_JSONL }] }],
      initialJobs: [seedJob(seedRepo)],
    });
    await use(handle);
    await handle.stop();
  },
});

async function openCockpit(page: import('@playwright/test').Page) {
  await page.locator('.o-sidebar-item[data-surface="cockpit"]').click();
  await expect(page.locator('.ckb-view')).toBeVisible();
}

seededTest('approving a spec from the cockpit collapses the row', async ({ outpostPage, daemon }) => {
  await openCockpit(outpostPage);
  const row = outpostPage.locator(`.ckb-item[data-row-key="job:${JOB_ID}"]`);
  await expect(row).toHaveAttribute('data-tone', 'you');
  await expect(row.locator('.ckb-status')).toContainText('Spec ready');

  await row.locator('.ckb-act button').click();
  const body = row.locator('.ckb-body');
  await expect(body).toBeVisible();
  await expect(body.locator('.tl-gate-body')).toContainText('UNKNOWN flaps');
  const maxHeight = await body.locator('.tl-gate-body').evaluate((el) => getComputedStyle(el).maxHeight);
  expect(maxHeight).not.toBe('none');

  await body.locator('[data-orc-action="approve-gate"]').click();
  await expect(body).toBeHidden({ timeout: 10_000 });

  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/work/jobs/${JOB_ID}`);
  expect((await res.json()).job.lastEngagedAt).toBeGreaterThan(0);
});

seededTest('the caret opens a job’s history and a session’s composer in place', async ({ outpostPage }) => {
  await openCockpit(outpostPage);
  const job = outpostPage.locator(`.ckb-item[data-row-key="job:${JOB_ID}"]`);
  await job.locator('.ckb-caret').click();
  await expect(job.locator('.ckb-body .ckb-tl')).toContainText('Fix the watcher');
  await expect(job.locator('.ckb-body .orc-trail-chip')).toContainText('Spec');

  const session = outpostPage.locator(`.ckb-item[data-row-key="session:${MANUAL_SESSION}"]`);
  await session.locator('.ckb-caret').click();
  await expect(session.locator('.ckb-body .ckb-session .sv-composer')).toBeVisible();
  await expect(outpostPage.locator('.o-sidebar-item[data-surface="cockpit"]')).toHaveClass(/is-active/);
});

seededTest('j/k/space/e drive the board without the mouse', async ({ outpostPage }) => {
  await openCockpit(outpostPage);
  await outpostPage.locator('.ckb-top').click();
  await outpostPage.keyboard.press('j');
  const first = outpostPage.locator('.ckb-item.is-selected');
  await expect(first).toHaveCount(1);
  await expect(first).toHaveAttribute('data-row-key', `job:${JOB_ID}`);
  await outpostPage.keyboard.press('Space');
  await expect(first.locator('.ckb-body')).toBeVisible();
  await outpostPage.keyboard.press('Escape');
  await expect(first.locator('.ckb-body')).toBeHidden();

  await outpostPage.keyboard.press('j');
  const session = outpostPage.locator(`.ckb-item[data-row-key="session:${MANUAL_SESSION}"]`);
  await expect(session).toHaveClass(/is-selected/);
  await outpostPage.keyboard.press('e');
  await expect(session).toHaveCount(0, { timeout: 10_000 });
});

seededTest('typing in a composer never triggers board keys', async ({ outpostPage }) => {
  await openCockpit(outpostPage);
  const session = outpostPage.locator(`.ckb-item[data-row-key="session:${MANUAL_SESSION}"]`);
  await session.locator('.ckb-caret').click();
  const composer = session.locator('.ckb-body .ckb-session .sv-composer');
  await composer.click();
  await outpostPage.keyboard.type('jkae');
  await expect(composer).toHaveText('jkae');
  await expect(session.locator('.ckb-body')).toBeVisible();
});
