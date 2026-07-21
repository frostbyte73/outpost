import { mkdirSync } from 'node:fs';
import { test, expect, DEFAULT_FIXTURE } from './harness/browser.js';

// Built with a live timestamp rather than read from fixtures/seeded-session.jsonl's
// hardcoded one — SessionStore auto-archives sessions after 7 days of inactivity
// (AUTO_ARCHIVE_WINDOW_MS in session-store.ts), and the Sessions surface's list only
// shows non-archived sessions, so a stale hardcoded date eventually ages out of view.
const now = new Date();
const SEED_JSONL = [
  JSON.stringify({ type: 'summary', summary: 'Investigate flaky test' }),
  JSON.stringify({ type: 'user', timestamp: now.toISOString(), message: { role: 'user', content: 'check the flaky test' }, cwd: '/tmp/seeded-project' }),
  JSON.stringify({ type: 'assistant', timestamp: new Date(now.getTime() + 1000).toISOString(), message: { id: 'msg_seed', role: 'assistant', content: [{ type: 'text', text: 'Looking into it' }], model: 'claude-opus-4-7', usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
].join('\n') + '\n';

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
  // Default landing surface is Cockpit (P1) — the raw session list lives on the
  // Sessions surface now, so navigate there before asserting visibility.
  await outpostPage.locator('.o-sidebar-item[data-surface="sessions"]').click();
  await expect(outpostPage.getByText(/flaky test/i)).toBeVisible({ timeout: 10_000 });
});
