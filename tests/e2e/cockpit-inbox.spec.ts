import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const HOOK_ACCESS = join(mkdtempSync(join(tmpdir(), 'outpost-e2e-hook-')), 'hook-access.json');
const FIXTURE = resolvePath(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'simple-text-response.jsonl');

test.use({ daemonOpts: { fixturePath: FIXTURE, extraEnv: { OUTPOST_TEST_HOOK_ACCESS_FILE: HOOK_ACCESS } } });
test.beforeEach(() => rmSync(HOOK_ACCESS, { force: true }));

// The proposal route lives on the hook server (loopback + per-launch secret), which only the
// spawned edit session knows how to reach — the mock claude writes that out for the test.
async function hookAccess(): Promise<{ baseUrl: string; secret: string }> {
  await expect.poll(() => existsSync(HOOK_ACCESS)).toBe(true);
  const { port, secret } = JSON.parse(readFileSync(HOOK_ACCESS, 'utf8'));
  return { baseUrl: `http://127.0.0.1:${port}`, secret };
}

test('an action proposal appears under Other without a reload', async ({ daemon, outpostPage }) => {
  await outpostPage.locator('.o-sidebar-item[data-surface="cockpit"]').click();
  await expect(outpostPage.locator('.ckb-empty')).toBeVisible();

  const start = await outpostPage.request.post(
    `${daemon.baseUrl}/api/actions/code.implement/edit`,
    { data: { feedback: 'tighten the self-review step' } },
  );
  expect(start.ok()).toBe(true);
  const { sessionId } = await start.json();

  const hook = await hookAccess();
  const posted = await outpostPage.request.post(`${hook.baseUrl}/work/action-proposal`, {
    headers: { 'x-daemon-auth': hook.secret, 'content-type': 'application/json' },
    data: {
      sessionId,
      actionName: 'code.implement',
      summary: 'Tighten the self-review step',
      skillMdAfter: '# code.implement\n\nRevised body.\n',
    },
  });
  expect(posted.ok()).toBe(true);

  // No reload anywhere above — the proposal has to arrive over the WS broadcast.
  const row = outpostPage.locator('[data-section="other"] .ckb-chip').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('code.implement');
  await expect(outpostPage.locator('.ckb-empty')).toBeHidden();

  await row.click();
  await expect(outpostPage.locator('.lib-wip-pill')).toHaveText('review');

  // A revision is a change: the card shows the diff, never the whole proposed SKILL.md
  // the way it used to.
  const diff = outpostPage.locator('.lib-edit-card .lib-diff');
  await expect(diff.locator('summary')).toContainText('Proposed change');
  await diff.locator('summary').click();
  await expect(diff.locator('.lib-diff-line.add').filter({ hasText: 'Revised body.' })).toBeVisible();
  await expect(diff.locator('.lib-diff-line.del').first()).toBeVisible();
});

test('a new action proposal renders the file, not an all-plus diff', async ({ daemon, outpostPage }) => {
  const start = await outpostPage.request.post(`${daemon.baseUrl}/api/actions/new`, {
    data: { feedback: 'run the nightly export', category: 'read' },
  });
  expect(start.ok()).toBe(true);
  const { sessionId } = await start.json();

  const hook = await hookAccess();
  const posted = await outpostPage.request.post(`${hook.baseUrl}/work/action-proposal`, {
    headers: { 'x-daemon-auth': hook.secret, 'content-type': 'application/json' },
    data: {
      sessionId,
      actionName: 'read.nightly-export',
      summary: 'Fetch the nightly export',
      skillMdAfter: '---\nname: read.nightly-export\n---\n\nFetch it.\n',
    },
  });
  expect(posted.ok()).toBe(true);

  await outpostPage.locator('.o-sidebar-item[data-surface="cockpit"]').click();
  await outpostPage.locator('[data-section="other"] .ckb-chip').first().click();

  const block = outpostPage.locator('.lib-edit-card .lib-diff');
  await expect(block.locator('summary')).toContainText('New SKILL.md');
  await block.locator('summary').click();
  await expect(block.locator('.lib-diff-body')).toContainText('Fetch it.');
  await expect(block.locator('.lib-diff-line')).toHaveCount(0);
});
