import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './harness/browser.js';

const TEST_CWD = '/tmp/outpost-e2e-project-registry';

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('POST /api/projects with a valid absolute path adds it; file landed under runtimeDir with 0o600 perms', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, {
    data: { cwd: TEST_CWD },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.added).toBe(true);
  expect(body.cwd).toBe(TEST_CWD);

  const file = join(daemon.runtimeDir, 'projects.json');
  expect(existsSync(file)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const contents = JSON.parse(readFileSync(file, 'utf8'));
  expect(contents.projects.map((p: { cwd: string }) => p.cwd)).toContain(TEST_CWD);
});

test('POST is idempotent — adding the same cwd twice returns added=false second time', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  expect((await res.json()).added).toBe(false);
});

test('the registered project shows up in /api/sessions with source="registry"', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  const sessions = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  const body = await sessions.json();
  const match = body.projects.find((p: { cwd: string }) => p.cwd === TEST_CWD);
  expect(match).toBeDefined();
  expect(match.source).toBe('registry');
  expect(match.sessions).toEqual([]);
  expect(typeof match.isGitRepo).toBe('boolean');
});

test('DELETE removes the project; subsequent /api/sessions does not include it', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  const del = await outpostPage.request.delete(`${daemon.baseUrl}/api/projects`, {
    data: { cwd: TEST_CWD },
  });
  expect(del.status()).toBe(200);
  expect((await del.json()).removed).toBe(true);
  const sessions = await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json();
  expect(sessions.projects.find((p: { cwd: string }) => p.cwd === TEST_CWD)).toBeUndefined();
});

test('POST rejects relative paths', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, {
    data: { cwd: 'relative/path' },
  });
  expect(res.status()).toBe(400);
});

test('POST rejects nonexistent paths', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, {
    data: { cwd: '/this/does/not/exist/anywhere' },
  });
  expect(res.status()).toBe(400);
});

test('POST rejects paths that point to files (not directories)', async ({ daemon, outpostPage }) => {
  const filePath = join(TEST_CWD, 'a-file.txt');
  writeFileSync(filePath, '');
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, {
    data: { cwd: filePath },
  });
  expect(res.status()).toBe(400);
});
