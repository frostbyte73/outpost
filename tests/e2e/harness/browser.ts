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
