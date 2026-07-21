import { readFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, DEFAULT_FIXTURE } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8');
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const TEST_CWD = '/tmp/outpost-e2e-delete';

test.use({
  daemonOpts: {
    fixturePath: DEFAULT_FIXTURE,
    initialProjects: [{
      cwd: TEST_CWD,
      sessions: [{ id: SESSION_ID, jsonl: SEED_JSONL }],
    }],
  },
});

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('DELETE /api/sessions/<id> removes the session from /api/sessions', async ({ daemon, outpostPage }) => {
  // Under suite load the daemon races its own session-index scan: it announces
  // "listening" before the seeded JSONL has been picked up, so an immediate GET
  // can return an empty list. Short sleep lets the index settle before we probe.
  await new Promise((r) => setTimeout(r, 250));

  const before = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  const beforeProjects = (await before.json()).projects;
  expect(beforeProjects.some((p: { sessions: { id: string }[] }) => p.sessions.some(s => s.id === SESSION_ID))).toBe(true);

  const del = await outpostPage.request.delete(`${daemon.baseUrl}/api/sessions/${SESSION_ID}`);
  expect(del.status()).toBe(204);

  const after = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  const afterProjects = (await after.json()).projects;
  expect(afterProjects.some((p: { sessions: { id: string }[] }) => p.sessions.some(s => s.id === SESSION_ID))).toBe(false);
});
