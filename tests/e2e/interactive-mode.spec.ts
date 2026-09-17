import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8');

const JOB_ID = 'wheel-job-1';
const STEP_ID = 'wheel-step-1';
const SESSION_ID = '44444444-4444-4444-4444-444444444444';

// A live orchestrated step on autopilot: `running` with a session attached, so
// orchestratedHandler.decide leaves it alone (it only spawns when there's no session) and the
// step card renders the compact tail plus the take-the-wheel control.
function seedJob(repoCwd: string, branch: string) {
  const now = Date.now();
  return {
    id: JOB_ID,
    source: 'manual',
    title: 'Ship the homepage widget',
    description: '',
    state: 'executing',
    steps: [
      {
        id: STEP_ID,
        type: 'orchestrated',
        controller: 'code.orchestrate-pr',
        title: 'Implement homepage widget',
        description: '',
        workspace: { kind: 'writable', repoCwd, branch },
        goal: 'Add a widget to the homepage',
        inputs: { approach: 'Add a component and wire it into the layout.' },
        phase: 'implementing',
        state: 'running',
        sessionId: SESSION_ID,
        dispatches: [],
        inbox: [],
        roundsSpent: 2,
        consecutiveSelfRounds: 0,
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
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-wheel-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [{ cwd: seedRepo, sessions: [{ id: SESSION_ID, jsonl: SEED_JSONL }] }],
      initialJobs: [seedJob(seedRepo, 'outpost/wheel-step-1')],
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

seededTest('take the wheel on a live step, converse, and hand it back', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const step = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`);

  // Autopilot: the compact tail, no composer.
  await expect(step.locator('.step-wheel')).toHaveText(/Take the wheel/);
  await expect(step.locator('.sv-composer')).toHaveCount(0);

  await step.locator('.step-wheel').click();

  // The flag reached the daemon, against whichever session the step actually holds. It is
  // NOT the seeded id: reconcileInterruptedSteps reads a `running` step carrying a session
  // from before this daemon booted as interrupted, clears it, and the step cold-spawns a
  // fresh one — so the wheel targets that.
  await expect.poll(async () => {
    const res = await outpostPage.request.get(`${daemon.baseUrl}/api/work/jobs/${JOB_ID}`);
    const data = await res.json();
    const live = data.job.live.interactiveSessionIds ?? [];
    const current = data.job.steps.find((s: { id: string }) => s.id === STEP_ID)?.sessionId;
    return current && live.includes(current) ? 'driven' : `not-driven(${live.length})`;
  }, { timeout: 10_000 }).toBe('driven');

  // ...and the real session view replaced the tail.
  await expect(step.locator('.step-wheel')).toHaveText(/Hand back/);
  const feed = step.locator('.step-inline-session-mount--driven');
  await expect(feed).toBeVisible();
  await expect(feed.locator('.sv-composer')).toBeVisible({ timeout: 10_000 });

  // A message the user types goes into the transcript of THIS mount.
  await feed.locator('.sv-composer').click();
  await outpostPage.keyboard.type('use the other approach');
  await feed.locator('.sv-send').click();
  await expect(feed.locator('.sv-transcript-inner')).toContainText('use the other approach');

  // Hand back: composer gone, compact tail returns.
  await step.locator('.step-wheel').click();
  await expect(step.locator('.step-wheel')).toHaveText(/Take the wheel/);
  await expect(step.locator('.sv-composer')).toHaveCount(0);
});
