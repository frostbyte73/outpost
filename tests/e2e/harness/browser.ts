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
// in settings before opening a session), then either click the in-row "+ New session"
// button (default = shared cwd) or programmatically open the session WS with worktree
// query params (Phase 2b — when caller supplies spawnMode='worktree' + baseBranch).
export async function openSessionAtCwd(
  outpostPage: Page,
  daemon: DaemonHandle,
  cwd: string,
  opts: { spawnMode?: 'shared' | 'worktree'; baseBranch?: string } = {},
): Promise<void> {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd } });
  if (!res.ok()) throw new Error(`POST /api/projects failed: ${res.status()}`);
  await outpostPage.evaluate(async () => {
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    await globalThis.__outpostRefreshSessions?.();
  });
  if (opts.spawnMode === 'worktree') {
    // Bypass the UI and open the session WS directly with the spawn=worktree query
    // params. The PWA work in T8 maps the default in-row click to this same path for
    // git repos — for the API-level e2e here we just synthesize the WS request.
    await outpostPage.evaluate(({ cwd, baseBranch }) => {
      // @ts-expect-error
      globalThis.__outpostOpenSession?.({
        id: crypto.randomUUID(),
        cwd,
        spawn: 'worktree',
        base: baseBranch ?? 'main',
      });
    }, { cwd, baseBranch: opts.baseBranch });
  } else {
    await outpostPage.locator(`.project-new-session[data-cwd="${cwd}"]`).click();
  }
}
