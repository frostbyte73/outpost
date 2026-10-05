import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

// Pre-approvals are only ever written by the user, through the PWA. These drive the two doors
// the user actually uses — plan review and the running step — end to end, and check that a
// draft the daemon approved (or declined to) reads as such on the step.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8');
const SESSION_ID = '44444444-4444-4444-4444-444444444444';

function step(repoCwd: string, over: Record<string, unknown>) {
  const now = Date.now();
  return {
    id: 'pre-step-1', type: 'orchestrated', controller: 'code.orchestrate-pr',
    title: 'Bump ws', description: '', goal: 'Bump ws to 8.21',
    workspace: { kind: 'writable', repoCwd, branch: 'deps/bump-ws' }, baseBranch: 'main',
    dispatches: [], inbox: [], roundsSpent: 2, consecutiveSelfRounds: 0,
    createdAt: now, updatedAt: now, ...over,
  };
}

function seeded(jobOf: (repo: string) => Record<string, unknown>) {
  return test.extend<{ daemon: DaemonHandle }>({
    daemon: async ({}, use) => {
      const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-preapprovals-'));
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '--allow-empty', '-q', '-m', 'init']);
      const handle = await startDaemon({
        fixturePath: FIXTURE,
        initialProjects: [{ cwd: repo, sessions: [{ id: SESSION_ID, jsonl: SEED_JSONL }] }],
        initialJobs: [jobOf(repo)],
      });
      await use(handle);
      await handle.stop();
    },
  });
}

async function openJob(page: Page, jobId: string) {
  await page.locator('.o-sidebar-item[data-surface="tracked"]').click();
  await page.locator(`.lr-row[data-job-id="${jobId}"]`).click();
}

async function stepOf(page: Page, daemon: DaemonHandle, jobId: string) {
  const res = await page.request.get(`${daemon.baseUrl}/api/work/jobs/${jobId}`);
  return (await res.json()).job.steps[0];
}

const planReview = seeded((repo) => {
  const now = Date.now();
  return {
    id: 'pre-plan', source: 'manual', title: 'Bump deps', description: '', state: 'plan_pending_review',
    plan: { postedAt: now, iterationsRejected: [] },
    steps: [step(repo, { state: 'running', proposedPreapprovals: { spec: 'skip', push: true } })],
    createdAt: now, updatedAt: now,
  };
});

planReview('plan review shows the planner\'s proposal and approves what the user edited it to', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage, 'pre-plan');
  const control = outpostPage.locator('fieldset.o-preapprovals[data-name="pre-step-1"]');
  await expect(control).toBeVisible({ timeout: 10_000 });
  await expect(control.locator('[data-pre="push"]')).toBeChecked();
  await expect(control.locator('[data-pre="spec"]')).toHaveValue('skip');
  // Loosened past a job with no settings of its own, so the planner's push is flagged.
  await expect(control.locator('label[data-loosened="true"]', { has: outpostPage.locator('[data-pre="push"]') })).toBeVisible();

  await control.locator('[data-pre="openPr"]').check();
  await outpostPage.locator('[data-job-action="approve-plan"]').click();

  await expect.poll(async () => (await stepOf(outpostPage, daemon, 'pre-plan')).preapprovals)
    .toMatchObject({ spec: 'skip', push: true, openPr: true });
});

const running = seeded((repo) => {
  const now = Date.now();
  return {
    id: 'pre-run', source: 'manual', title: 'Bump deps', description: '', state: 'executing',
    preapprovals: { push: true },
    steps: [step(repo, {
      state: 'gate_pending_approval', sessionId: SESSION_ID, phase: 'implement',
      drafts: [
        {
          id: 'auto-1', action: 'code.orchestrate-pr', raisedBy: { kind: 'controller' }, summary: 'Push deps/bump-ws',
          calls: [{ id: 'c1', label: 'push', bash: 'git push -u origin deps/bump-ws' }],
          requestedAt: now - 1000, approvedAt: now - 900, approvedBy: 'preapproval',
        },
        {
          id: 'miss-1', action: 'code.orchestrate-pr', raisedBy: { kind: 'controller' }, summary: 'Open a PR for deps/bump-ws',
          calls: [{ id: 'c2', label: 'open PR', bash: 'gh pr create --base main --head deps/bump-ws --title t --body b' }],
          requestedAt: now, autoApproveMiss: 'open PR: needs the openPr pre-approval',
        },
      ],
    })],
    createdAt: now, updatedAt: now,
  };
});

running('a running step shows what ran pre-approved, why the rest stopped, and takes a new setting', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage, 'pre-run');
  const card = outpostPage.locator('.tl-step[data-step-id="pre-step-1"] .orc-card');
  await expect(card).toBeVisible({ timeout: 10_000 });

  const auto = card.locator('.wd-card--auto');
  await expect(auto).toContainText('pre-approved');
  await expect(auto).toContainText('git push -u origin deps/bump-ws');
  await expect(auto.locator('button')).toHaveCount(0);
  await expect(card.locator('.wd-miss')).toContainText('needs the openPr pre-approval');

  const settings = card.locator('.orc-preapprovals');
  await expect(settings.locator('.orc-preapprovals-label')).toHaveText('push');
  await settings.locator('summary').click();
  await settings.locator('[data-pre="openPr"]').check();
  await settings.locator('[data-orc-preapprovals="save"]').click();

  await expect.poll(async () => (await stepOf(outpostPage, daemon, 'pre-run')).preapprovals)
    .toMatchObject({ push: true, openPr: true });
});
