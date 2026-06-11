import { test as base, type Page } from '@playwright/test';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type DaemonHandle, type StartDaemonOpts } from './daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..', '..', '..');

export const DEFAULT_FIXTURE = resolvePath(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'simple-text-response.jsonl');

// Tests can override the fixture (and pre-seeded projects) via test.use({ daemonOpts: ... }).
// Default uses the simple fixture and no seeded projects.
export const test = base.extend<{
  daemonOpts: StartDaemonOpts;
  daemon: DaemonHandle;
  outpostPage: Page;
}>({
  daemonOpts: [{ fixturePath: DEFAULT_FIXTURE }, { option: true }],
  daemon: async ({ daemonOpts }, use) => {
    const handle = await startDaemon(daemonOpts);
    await use(handle);
    await handle.stop();
  },
  outpostPage: async ({ daemon, page }, use) => {
    await page.goto(daemon.baseUrl);
    await use(page);
  },
});

export { expect } from '@playwright/test';

// Phase 2a flow helper: register a project via POST /api/projects, refresh the session
// list IN-PLACE (no reload, which would wipe optimistic state like permission mode set
// in settings before opening a session), then click the in-row "+ New session" button.
// Replaces the Phase 0/1 cwd-picker flow.
export async function openSessionAtCwd(
  outpostPage: Page,
  daemon: DaemonHandle,
  cwd: string,
): Promise<void> {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd } });
  // 200 added=true OR 200 added=false (idempotent). Either way the project is registered.
  if (!res.ok()) throw new Error(`POST /api/projects failed: ${res.status()}`);
  // Refresh in-place so newly-registered projects appear without losing state.
  await outpostPage.evaluate(async () => {
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    await globalThis.__outpostRefreshSessions?.();
  });
  await outpostPage.locator(`.project-new-session[data-cwd="${cwd}"]`).click();
}
