import { readFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, DEFAULT_FIXTURE } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8');

test.use({
  daemonOpts: {
    fixturePath: DEFAULT_FIXTURE,
    initialProjects: [{
      cwd: '/tmp/seeded-project',
      sessions: [{ id: '11111111-1111-1111-1111-111111111111', jsonl: SEED_JSONL }],
    }],
  },
});

// SessionStore filters out projects whose cwd doesn't exist on disk — create it.
test.beforeAll(() => {
  mkdirSync('/tmp/seeded-project', { recursive: true });
});

test('seeded project + session shows up in /api/sessions', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.projects).toHaveLength(1);
  expect(body.projects[0].cwd).toBe('/tmp/seeded-project');
  expect(body.projects[0].sessions[0].id).toBe('11111111-1111-1111-1111-111111111111');
  expect(body.projects[0].sessions[0].title).toMatch(/flaky test/i);
});

test('seeded session is visible in the PWA session list', async ({ outpostPage }) => {
  await expect(outpostPage.getByText(/flaky test/i)).toBeVisible({ timeout: 10_000 });
});
