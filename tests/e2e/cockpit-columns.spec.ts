import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8')
  .replaceAll('2026-06-10T', `${new Date().toISOString().slice(0, 10)}T`);

const GATE_JOB = 'col-job-gate';
const DONE_JOB = 'col-job-done';
const DRAFT_JOB = 'col-job-draft';
const SESSION = '66666666-6666-6666-6666-666666666666';

function orc(repoCwd: string, id: string, over: Record<string, unknown>) {
  const now = Date.now();
  return {
    id, type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix the watcher', description: '',
    workspace: { kind: 'writable', repoCwd, branch: `outpost/${id}` }, goal: 'g', inputs: {},
    sessionId: `${id}-sess`, dispatches: [], inbox: [], roundsSpent: 1, consecutiveSelfRounds: 0,
    createdAt: now, updatedAt: now, ...over,
  };
}

function seedJobs(repoCwd: string) {
  const now = Date.now();
  const base = { source: 'manual', description: '', createdAt: now, updatedAt: now, dismissMigrated: true };
  return [
    { ...base, id: GATE_JOB, title: 'Stop mergeable flapping', state: 'executing', steps: [orc(repoCwd, 'col-s1', {
      phase: 'spec', state: 'gate_pending_approval',
      gate: { draft: `## Problem\n\n${'A long spec line that should wrap inside a narrow column rather than push it wider. '.repeat(6)}\n`, question: 'Approve the spec?', requestedAt: now },
      artifacts: { spec: '## Problem' },
    })] },
    { ...base, id: DRAFT_JOB, title: 'Bump deps', state: 'executing', steps: [orc(repoCwd, 'col-s2', {
      phase: 'implement', state: 'gate_pending_approval',
      drafts: [{ id: 'd1', action: 'code.orchestrate-pr', raisedBy: { kind: 'controller' }, summary: 'Open a PR',
        calls: [{ id: 'c1', label: 'open PR', bash: `gh pr create --base main --head deps/bump --title "${'t'.repeat(120)}" --body b` }],
        requestedAt: now }],
    })] },
    { ...base, id: DONE_JOB, title: 'Already shipped', state: 'done', steps: [] },
  ];
}

const seededTest = test.extend<{ seedRepo: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-cols-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [{ cwd: seedRepo, sessions: [{ id: SESSION, jsonl: SEED_JSONL }] }],
      initialJobs: seedJobs(seedRepo),
    });
    await use(handle);
    await handle.stop();
  },
});

async function openCockpit(page: Page) {
  await page.locator('.o-sidebar-item[data-surface="cockpit"]').click();
  await expect(page.locator('.ckb-view')).toBeVisible();
  await expect(page.locator(`.ckb-item[data-row-key="session:${SESSION}"]`)).toBeVisible();
}

async function dragTo(page: Page, handle: Locator, to: { x: number; y: number }, { release = true } = {}) {
  const b = (await handle.boundingBox())!;
  const from = { x: b.x + Math.min(20, b.width / 2), y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (release) await page.mouse.up();
}

async function gapBelow(section: Locator) {
  const b = (await section.boundingBox())!;
  return { x: b.x + 120, y: b.y + b.height + 12 };
}

const sessionRow = (page: Page) => page.locator(`.ckb-item[data-row-key="session:${SESSION}"]`);
const storedLayout = (page: Page, daemon: DaemonHandle) =>
  page.request.get(`${daemon.baseUrl}/api/preferences`).then(async (r) => (await r.json()).cockpitLayout);

seededTest('drag a session into a new Pinned section, rename it, reload — it all persists', async ({ outpostPage: page, daemon }) => {
  await openCockpit(page);
  await dragTo(page, sessionRow(page).locator('.ckb-title'), await gapBelow(page.locator('[data-section="other"]')));
  const pinned = page.locator('.ckb-section[data-kind="pinned"]');
  await expect(pinned).toHaveCount(1);
  await expect(pinned.locator(`[data-row-key="session:${SESSION}"]`)).toBeVisible();
  await expect(page.locator('[data-section="sessions"] .ckb-item')).toHaveCount(0);

  await pinned.locator('.ckb-pin-title').click();
  await pinned.locator('.ckb-pin-rename').fill('Replay');
  await page.keyboard.press('Enter');
  await expect(pinned.locator('.ckb-pin-title')).toHaveText('Replay');
  await expect.poll(async () => JSON.stringify(await storedLayout(page, daemon))).toContain('Replay');

  await page.evaluate(() => localStorage.removeItem('outpost.cockpitLayout'));
  await page.reload();
  await openCockpit(page);
  await expect(page.locator('.ckb-section[data-kind="pinned"] .ckb-pin-title')).toHaveText('Replay');
  await expect(page.locator(`.ckb-section[data-kind="pinned"] [data-row-key="session:${SESSION}"]`)).toBeVisible();
});

seededTest('add a column, move a section in, move it back out — the emptied columns go', async ({ outpostPage: page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await openCockpit(page);
  const cols = page.locator('.ckb-board > .ckb-column');
  await expect(cols).toHaveCount(2);
  await page.locator('.ckb-add-col').click();
  await expect(cols).toHaveCount(3);

  const empty = (await cols.nth(2).locator('.ckb-col-empty').boundingBox())!;
  await dragTo(page, page.locator('[data-section="jobs"] .o-grip'), { x: empty.x + 50, y: empty.y + 10 });
  await expect(cols).toHaveCount(2);
  await expect(cols.nth(1).locator('[data-section="jobs"]')).toHaveCount(1);

  const other = (await page.locator('[data-section="other"]').boundingBox())!;
  await dragTo(page, page.locator('[data-section="jobs"] .o-grip'), { x: other.x + 50, y: other.y + 2 });
  await expect(cols).toHaveCount(1);
  await expect(page.locator('.ckb-column .ckb-section').first()).toHaveAttribute('data-section', 'jobs');
});

seededTest('resizing the gutter persists across a reload', async ({ outpostPage: page }) => {
  await openCockpit(page);
  const handle = page.locator('.ckb-column').first().locator('.ckb-resize');
  const b = (await handle.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 100, { steps: 8 });
  await page.mouse.up();
  const grow = () => page.locator('.ckb-column').first().evaluate((el) => Number((el as HTMLElement).style.flexGrow));
  const after = await grow();
  expect(after).toBeGreaterThan(0.55);
  await page.reload();
  await openCockpit(page);
  expect(await grow()).toBeCloseTo(after, 2);
});

seededTest('an expanded session keeps its typed text and body node when dragged into Pinned', async ({ outpostPage: page }) => {
  await openCockpit(page);
  await sessionRow(page).locator('.ckb-caret').click();
  const composer = sessionRow(page).locator('.ckb-body .sv-composer');
  await composer.click();
  await page.keyboard.type('half a thought');
  await sessionRow(page).locator('.ckb-body').evaluate((el) => { (el as HTMLElement).dataset.probe = 'same-node'; });

  await dragTo(page, sessionRow(page).locator('.ckb-title'), await gapBelow(page.locator('[data-section="other"]')));
  const moved = page.locator(`.ckb-section[data-kind="pinned"] [data-row-key="session:${SESSION}"]`);
  await expect(moved).toBeVisible();
  await expect(moved.locator('.ckb-body')).toHaveAttribute('data-probe', 'same-node');
  await expect(moved.locator('.ckb-body .sv-composer')).toHaveText('half a thought');
});

seededTest('Escape mid-drag leaves the layout and the expanded row alone', async ({ outpostPage: page }) => {
  await openCockpit(page);
  await sessionRow(page).locator('.ckb-caret').click();
  await expect(sessionRow(page).locator('.ckb-body')).toBeVisible();
  await dragTo(page, sessionRow(page).locator('.ckb-title'), await gapBelow(page.locator('[data-section="other"]')), { release: false });
  await expect(page.locator('.ckb-ghost')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.ckb-ghost')).toHaveCount(0);
  await expect(page.locator('.ckb-section[data-kind="pinned"]')).toHaveCount(0);
  await expect(sessionRow(page).locator('.ckb-body')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('outpost.cockpitLayout'))).toBeNull();
});

seededTest('a done job shows Dismiss and leaves the board after it', async ({ outpostPage: page, daemon }) => {
  await openCockpit(page);
  const row = page.locator(`.ckb-item[data-row-key="job:${DONE_JOB}"]`);
  await expect(row.locator('.ckb-status')).toHaveText('Done');
  await row.hover();
  await row.locator('.ckb-archive').click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  const res = await page.request.get(`${daemon.baseUrl}/api/work/jobs/${DONE_JOB}`);
  expect((await res.json()).job.dismissedAt).toBeGreaterThan(0);
});

seededTest('at a 360px column, expanded bodies never overflow sideways', async ({ outpostPage: page }) => {
  await page.evaluate(() => localStorage.setItem('outpost.cockpitLayout', JSON.stringify({
    columns: [{ width: 0.34, sections: ['jobs'] }, { width: 0.33, sections: ['other', 'sessions'] }, { width: 0.33, sections: [] }],
    pinned: {},
  })));
  await page.reload();
  await openCockpit(page);
  const colWidth = await page.locator('.ckb-column').first().evaluate((el) => el.getBoundingClientRect().width);
  expect(colWidth).toBeLessThan(400);

  await sessionRow(page).locator('.ckb-caret').click();
  for (const job of [GATE_JOB, DRAFT_JOB]) {
    await page.locator(`.ckb-item[data-row-key="job:${job}"] .ckb-title`).click();
    await page.keyboard.press('a');
  }
  for (const key of [`session:${SESSION}`, `job:${GATE_JOB}`, `job:${DRAFT_JOB}`]) {
    const body = page.locator(`.ckb-item[data-row-key="${key}"] .ckb-body`);
    await expect(body).toBeVisible();
    const overflow = await body.evaluate((el) => {
      const bad: string[] = [];
      for (const n of [el, ...el.querySelectorAll('*')] as HTMLElement[]) {
        const s = getComputedStyle(n);
        if (s.overflowX !== 'visible' || n.offsetParent === null) continue;
        if (n.getBoundingClientRect().right > el.getBoundingClientRect().right + 1) bad.push(n.className || n.tagName);
      }
      return { scroll: el.scrollWidth - el.clientWidth, bad: bad.slice(0, 5) };
    });
    expect(overflow, key).toEqual({ scroll: 0, bad: [] });
  }
});
