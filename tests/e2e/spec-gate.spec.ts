import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

const JOB_ID = 'spec-job-1';
const STEP_ID = 'spec-step-1';
const SPEC_MARKDOWN = '## Widget spec\n\nAdd a **cool** widget to the homepage.\n';

// Builds a JobRecord (src/work/work-types.ts) with a single open-pr step parked
// in `spec_pending_review` — the state the code.spec round submits into via
// submit_spec, awaiting the user's Accept/Propose-changes gate.
function seedJob(repoCwd: string, branch: string) {
  const now = Date.now();
  return {
    id: JOB_ID,
    source: 'manual',
    title: 'Add a homepage widget',
    description: '',
    state: 'executing',
    steps: [
      {
        id: STEP_ID,
        type: 'open-pr',
        title: 'Implement homepage widget',
        description: '',
        workspace: { kind: 'writable', repoCwd, branch },
        goal: 'Add a widget to the homepage',
        approach: 'Add a new component and wire it into the homepage layout.',
        state: 'spec_pending_review',
        spec: SPEC_MARKDOWN,
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

const seededTest = test.extend<{ seedRepo: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-specgate-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialJobs: [seedJob(seedRepo, 'outpost/spec-step-1')],
    });
    await use(handle);
    await handle.stop();
  },
});

async function openJob(outpostPage: import('@playwright/test').Page): Promise<void> {
  await outpostPage.locator('.o-sidebar-item[data-surface="tracked"]').click();
  await outpostPage.locator(`.lr-row[data-job-id="${JOB_ID}"]`).click();
  await expect(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`)).toBeVisible({ timeout: 10_000 });
}

async function fetchStep(outpostPage: import('@playwright/test').Page, daemon: DaemonHandle): Promise<any> {
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/work/jobs/${JOB_ID}`);
  const data = await res.json();
  return data.job.steps.find((s: any) => s.id === STEP_ID);
}

seededTest('renders the spec markdown, open by default while the gate is pending', async ({ outpostPage }) => {
  await openJob(outpostPage);
  const step = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`);

  const specDetails = step.locator('details.tl-findings', { hasText: 'Spec' });
  await expect(specDetails).toBeVisible();
  await expect(specDetails).toHaveJSProperty('open', true);
  await expect(specDetails.locator('.step-findings')).toContainText('Widget spec');
  await expect(specDetails.locator('.step-findings')).toContainText('Add a');
  await expect(specDetails.locator('.step-findings strong')).toHaveText('cool');
});

seededTest('clicking Accept spec approves the spec gate', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const step = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`);

  await step.locator('[data-step-action="accept-spec"]').click();

  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).state, { timeout: 5_000 }).toBe('planning');
  // The gate controls disappear once the step has moved on.
  await expect(step.locator('[data-step-action="accept-spec"]')).toHaveCount(0);
});

seededTest('Propose changes reveals a composer and rejects the spec gate with feedback', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const step = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`);

  const composer = step.locator('[data-composer="spec-feedback"]');
  await expect(composer).toBeHidden();
  await step.locator('[data-step-action="toggle-spec-feedback"]').click();
  await expect(composer).toBeVisible();

  await composer.locator('textarea').fill('Please make the widget collapsible.');
  await composer.locator('[data-step-action="submit-spec-feedback"]').click();

  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).state, { timeout: 5_000 }).toBe('speccing');
  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).specFeedback, { timeout: 5_000 })
    .toEqual(['Please make the widget collapsible.']);
  // The gate controls disappear once the step has moved on.
  await expect(step.locator('[data-step-action="accept-spec"]')).toHaveCount(0);
});
