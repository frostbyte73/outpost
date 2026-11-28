import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

// Done on a meta.session carries the typed note into the step's output from every surface that offers it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8')
  .replaceAll('2026-06-10T', `${new Date().toISOString().slice(0, 10)}T`);

const JOB_ID = 'sdn-job-1';
const STEP_ID = 'sdn-step-1';
const MANUAL_SESSION = '66666666-6666-6666-6666-666666666666';
const NOTE = 'Audience is me; budget two weekends';

function seedJob(cwd: string) {
  const now = Date.now();
  return {
    id: JOB_ID, source: 'manual', title: 'Shape the game idea', description: '', state: 'executing',
    steps: [{
      id: STEP_ID, type: 'action', action: 'meta.session', title: 'Answer clarifications', description: '',
      goal: 'g', inputs: { prompt: 'Answer the brief questions' }, state: 'waiting',
      workspace: { kind: 'none' }, manualSession: { id: MANUAL_SESSION, cwd },
      createdAt: now, updatedAt: now,
    }],
    createdAt: now, updatedAt: now,
  };
}

const seededTest = test.extend<{ daemon: DaemonHandle }>({
  daemon: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-sdn-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '--allow-empty', '-q', '-m', 'init']);
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [{ cwd: repo, sessions: [{ id: MANUAL_SESSION, jsonl: SEED_JSONL }] }],
      initialJobs: [seedJob(repo)],
    });
    await use(handle);
    await handle.stop();
  },
});

async function doneWithNote(scope: Locator) {
  const composer = scope.locator(`[data-composer="session-done"][data-step-id="${STEP_ID}"]`);
  await composer.locator('textarea').fill(NOTE);
  await composer.locator('button', { hasText: 'Done' }).click();
}

async function expectResolvedWithNote(page: Page, daemon: DaemonHandle) {
  await expect.poll(async () => {
    const res = await page.request.get(`${daemon.baseUrl}/api/work/jobs/${JOB_ID}`);
    const step = (await res.json()).job.steps[0];
    return step.state === 'resolved' ? JSON.parse(step.output) : null;
  }, { timeout: 10_000 }).toEqual({ resumed_by: 'user', note: NOTE });
}

seededTest.describe('desktop', () => {
  seededTest('the step card sends the note with Done', async ({ outpostPage, daemon }) => {
    await outpostPage.locator('.o-sidebar-item[data-surface="tracked"]').click();
    await outpostPage.locator(`.lr-row[data-job-id="${JOB_ID}"]`).click();
    await doneWithNote(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`));
    await expectResolvedWithNote(outpostPage, daemon);
  });

  seededTest('the focus card sends the note with Done', async ({ outpostPage, daemon }) => {
    await outpostPage.locator('.o-sidebar-item[data-surface="tracked"]').click();
    await outpostPage.locator(`.lr-row[data-job-id="${JOB_ID}"]`).click();
    await doneWithNote(outpostPage.locator('.o-focus-card'));
    await expectResolvedWithNote(outpostPage, daemon);
  });

  seededTest('the cockpit board sends the note with Done', async ({ outpostPage, daemon }) => {
    await outpostPage.locator('.o-sidebar-item[data-surface="cockpit"]').click();
    const row = outpostPage.locator(`.ckb-item[data-row-key="job:${JOB_ID}"]`);
    await row.locator('.ckb-title').click();
    await outpostPage.keyboard.press('a');
    await doneWithNote(row.locator('.ckb-body'));
    await expectResolvedWithNote(outpostPage, daemon);
  });
});

seededTest.describe('mobile', () => {
  seededTest.use({ viewport: { width: 390, height: 844 } });

  async function openJob(page: Page) {
    await page.locator('.m-tab[data-tab="tracked"]').click();
    await page.locator(`.lr-row[data-job-id="${JOB_ID}"]`).click();
  }

  seededTest('the step card sends the note with Done', async ({ outpostPage, daemon }) => {
    await openJob(outpostPage);
    await doneWithNote(outpostPage.locator(`.m-tk-mount .tl-step[data-step-id="${STEP_ID}"]`));
    await expectResolvedWithNote(outpostPage, daemon);
  });

  seededTest('the focus card sends the note with Done', async ({ outpostPage, daemon }) => {
    await openJob(outpostPage);
    await doneWithNote(outpostPage.locator('.m-focus-mount'));
    await expectResolvedWithNote(outpostPage, daemon);
  });
});
