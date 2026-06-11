import { mkdirSync } from 'node:fs';
import { test, expect } from './harness/browser.js';

const TEST_CWD = '/tmp/outpost-e2e-expandable-projects';

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('full happy path: add project via UI → expanded automatically → spawn session', async ({ outpostPage }) => {
  // 1. Click "+ Add project", enter the cwd, submit.
  await outpostPage.locator('#add-project').click();
  await outpostPage.locator('#add-project-input').fill(TEST_CWD);
  await outpostPage.locator('.add-project-submit').click();

  // 2. The new project row appears in the session list (registry-only, auto-expanded
  //    because the row's lastModified=addedAt makes it the most-recent project).
  await expect(outpostPage.locator(`.project-section[data-cwd="${TEST_CWD}"]`)).toBeVisible({ timeout: 5_000 });

  // 3. "+ New session" button is visible inside the expanded body (auto-expansion via
  //    setProjectExpanded() in the sheet's submit handler).
  const newSessionBtn = outpostPage.locator(`.project-new-session[data-cwd="${TEST_CWD}"]`);
  await expect(newSessionBtn).toBeVisible({ timeout: 5_000 });

  // 4. Click it → session opens. Composer should appear.
  await newSessionBtn.click();
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });
});

test('expand state persists across reload', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  await outpostPage.reload();
  // The most-recent project auto-expands on first paint, so the in-row New-session
  // button should already be visible without a click.
  await expect(outpostPage.locator(`.project-new-session[data-cwd="${TEST_CWD}"]`)).toBeVisible({ timeout: 5_000 });
  // Collapse explicitly, then reload — collapsed state must persist via localStorage.
  await outpostPage.locator(`.project-section[data-cwd="${TEST_CWD}"] .project-section-header`).click();
  await expect(outpostPage.locator(`.project-new-session[data-cwd="${TEST_CWD}"]`)).toBeHidden();
  await outpostPage.reload();
  await expect(outpostPage.locator(`.project-new-session[data-cwd="${TEST_CWD}"]`)).toBeHidden();
});

test('Remove from list overflow removes a registry-only project', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  await outpostPage.reload();
  await expect(outpostPage.locator(`.project-section[data-cwd="${TEST_CWD}"]`)).toBeVisible({ timeout: 5_000 });
  // Click overflow ⋯, then "Remove from list".
  await outpostPage.locator(`.project-overflow[data-cwd="${TEST_CWD}"]`).click();
  await outpostPage.locator('.project-overflow-item').click();
  // Row gone.
  await expect(outpostPage.locator(`.project-section[data-cwd="${TEST_CWD}"]`)).toHaveCount(0, { timeout: 5_000 });
  // Confirm via API.
  const sessions = await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json();
  expect(sessions.projects.find((p: { cwd: string }) => p.cwd === TEST_CWD)).toBeUndefined();
});
