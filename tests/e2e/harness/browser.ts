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

// Register a project via POST /api/projects, refresh the session list IN-PLACE (no
// reload, which would wipe optimistic state like permission mode set in settings before
// opening a session), then open a fresh session via the same __outpostOpenSession
// test-hook the palette's "New session" flow drives — with spawn=worktree query params
// when the caller supplies spawnMode='worktree' + baseBranch. The old in-row "+ New
// session" button this used to click was removed by the P4 redesign (session creation
// now goes through the command palette, which isn't a stable target for these
// API-level fixture tests), so both branches go through the test-hook directly.
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
  await outpostPage.evaluate(({ cwd, spawnMode, baseBranch }) => {
    // @ts-expect-error
    globalThis.__outpostOpenSession?.({
      id: crypto.randomUUID(),
      cwd,
      ...(spawnMode === 'worktree' ? { spawn: 'worktree', base: baseBranch ?? 'main' } : {}),
    });
  }, { cwd, spawnMode: opts.spawnMode, baseBranch: opts.baseBranch });
}
