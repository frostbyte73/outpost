import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

let testRepo: string;

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeEach(() => {
  testRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-arc-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', testRepo]);
  execFileSync('git', ['-C', testRepo, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', testRepo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', testRepo, 'commit', '--allow-empty', '-q', '-m', 'init']);
});

// Helper: pull the freshly-created worktree's record from the daemon's index.json
// after a successful spawn. We don't get the sessionId back via the WS open; instead
// we wait for the index to grow then read out the most-recently-created record.
async function waitForWorktreeRecord(daemon: { runtimeDir: string }, timeoutMs = 5000): Promise<{
  sessionId: string; worktreePath: string; branch: string;
}> {
  const indexPath = join(daemon.runtimeDir, 'worktrees', 'index.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(indexPath)) {
      const { readFileSync } = await import('node:fs');
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf8'));
        const live = (data.records as Array<{ sessionId: string; worktreePath: string; branch: string; archivedAt?: number; createdAt: number }>)
          .filter((r) => !r.archivedAt && r.worktreePath)
          .sort((a, b) => b.createdAt - a.createdAt);
        if (live.length > 0) return live[0]!;
      } catch { /* in-flight write — retry */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no live worktree record found');
}

test('POST /api/sessions/:id/archive removes worktree + branch, leaves index tombstone', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, testRepo, { spawnMode: 'worktree', baseBranch: 'main' });
  const rec = await waitForWorktreeRecord(daemon);
  expect(existsSync(rec.worktreePath)).toBe(true);

  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/sessions/${rec.sessionId}/archive`);
  expect(res.status()).toBe(204);

  // Worktree dir gone.
  await expect.poll(() => existsSync(rec.worktreePath), { timeout: 3_000 }).toBe(false);
  // Branch gone.
  const branches = execFileSync('git', ['-C', testRepo, 'branch', '--list', rec.branch]).toString();
  expect(branches).not.toContain(rec.branch);
  // Tombstone retained in index.
  const { readFileSync } = await import('node:fs');
  const idx = JSON.parse(readFileSync(join(daemon.runtimeDir, 'worktrees', 'index.json'), 'utf8'));
  const tombstone = (idx.records as Array<{ sessionId: string; archivedAt?: number; worktreePath: string }>)
    .find((r) => r.sessionId === rec.sessionId);
  expect(tombstone).toBeDefined();
  expect(tombstone!.archivedAt).toBeGreaterThan(0);
  // Tombstone retains the original worktreePath as a label — the dir is gone but
  // SessionStore uses the path to fold the still-on-disk JSONL under the parent.
  expect(tombstone!.worktreePath).toBe(rec.worktreePath);
});

test('DELETE /api/sessions/:id removes both worktree and branch', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, testRepo, { spawnMode: 'worktree', baseBranch: 'main' });
  const rec = await waitForWorktreeRecord(daemon);

  const res = await outpostPage.request.delete(`${daemon.baseUrl}/api/sessions/${rec.sessionId}`);
  expect(res.status()).toBe(204);

  await expect.poll(() => existsSync(rec.worktreePath), { timeout: 3_000 }).toBe(false);
  const branches = execFileSync('git', ['-C', testRepo, 'branch', '--list', rec.branch]).toString();
  expect(branches).not.toContain(rec.branch);
  // Index entry GONE (not just tombstone).
  const { readFileSync } = await import('node:fs');
  const idx = JSON.parse(readFileSync(join(daemon.runtimeDir, 'worktrees', 'index.json'), 'utf8'));
  const found = (idx.records as Array<{ sessionId: string }>).find((r) => r.sessionId === rec.sessionId);
  expect(found).toBeUndefined();
});
