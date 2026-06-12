import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../../src/worktree-manager.js';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'init']);
  return dir;
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wt-mgr-'));
}

function projectsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wt-projects-'));
}

describe('WorktreeManager — state + persistence', () => {
  it('starts with an empty index when no file exists', () => {
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    expect(m.get('sess-1')).toBeUndefined();
  });

  it('persists records across instances', () => {
    const root = newRoot();
    const m1 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m1._testSeedRecord({
      sessionId: 'sess-a',
      projectCwd: '/tmp/repoA',
      worktreePath: join(root, 'sess-a'),
      branch: 'outpost/sessa',
      baseBranch: 'main',
      createdAt: 1234567890,
    });
    const m2 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = m2.get('sess-a');
    expect(rec).toBeDefined();
    expect(rec!.projectCwd).toBe('/tmp/repoA');
    expect(rec!.branch).toBe('outpost/sessa');
  });

  it('persists tombstones (archived sessions) and reports them via get', () => {
    const root = newRoot();
    const m1 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m1._testSeedRecord({
      sessionId: 'sess-x',
      projectCwd: '/tmp/repoX',
      worktreePath: '',
      branch: '',
      baseBranch: 'main',
      createdAt: 100,
      archivedAt: 200,
    });
    const m2 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = m2.get('sess-x');
    expect(rec).toBeDefined();
    expect(rec!.archivedAt).toBe(200);
  });

  it('index file uses 0o600 mode and 0o700 dir mode', () => {
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m._testSeedRecord({
      sessionId: 'sess-perm',
      projectCwd: '/tmp/repoP',
      worktreePath: join(root, 'sess-perm'),
      branch: 'outpost/sessperm',
      baseBranch: 'main',
      createdAt: 1,
    });
    const indexPath = join(root, 'index.json');
    expect(existsSync(indexPath)).toBe(true);
    expect(statSync(indexPath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('list returns all records (including archived tombstones)', () => {
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m._testSeedRecord({ sessionId: 'a', projectCwd: '/a', worktreePath: '/wt/a', branch: 'outpost/a', baseBranch: 'main', createdAt: 1 });
    m._testSeedRecord({ sessionId: 'b', projectCwd: '/b', worktreePath: '', branch: '', baseBranch: 'main', createdAt: 2, archivedAt: 3 });
    const all = m.list();
    expect(all.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
  });
});

describe('WorktreeManager — git operations', () => {
  it('create() invokes git worktree add and records the result', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-c1', projectCwd: repo, baseBranch: 'main' });
    expect(rec.worktreePath).toContain(root);
    expect(rec.branch).toMatch(/^outpost\//);
    expect(rec.baseBranch).toBe('main');
    expect(existsSync(rec.worktreePath)).toBe(true);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString();
    expect(branches).toContain(rec.branch);
  });

  it('create() throws when projectCwd is not a git repo', async () => {
    const root = newRoot();
    const notRepo = mkdtempSync(join(tmpdir(), 'wt-notrepo-'));
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(
      m.create({ sessionId: 'sess-bad', projectCwd: notRepo, baseBranch: 'main' }),
    ).rejects.toThrow();
  });

  it('remove() deletes the worktree, branch, and index entry', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-r1', projectCwd: repo, baseBranch: 'main' });
    expect(existsSync(rec.worktreePath)).toBe(true);
    await m.remove('sess-r1');
    expect(existsSync(rec.worktreePath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString();
    expect(branches).not.toContain(rec.branch);
    expect(m.get('sess-r1')).toBeUndefined();
  });

  it('archive() removes worktree+branch but keeps a tombstone in the index', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-arc', projectCwd: repo, baseBranch: 'main' });
    await m.archive('sess-arc');
    expect(existsSync(rec.worktreePath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString();
    expect(branches).not.toContain(rec.branch);
    const tombstone = m.get('sess-arc');
    expect(tombstone).toBeDefined();
    expect(tombstone!.archivedAt).toBeGreaterThan(0);
    // Tombstones retain their original worktreePath/branch as forensic labels — the dir
    // and branch on disk are gone, and the JSONL has been relocated under the parent
    // project (see the relocation test below), so these fields are no longer load-bearing.
    expect(tombstone!.worktreePath).toBe(rec.worktreePath);
    expect(tombstone!.branch).toBe(rec.branch);
  });

  it('archive() relocates the session JSONL + sidecars into the parent project dir', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const projects = projectsRoot();
    const m = new WorktreeManager({ root, projectsRoot: projects });
    const rec = await m.create({ sessionId: 'sess-relo', projectCwd: repo, baseBranch: 'main' });

    // Simulate claude having written a JSONL + title + subagents dir under the worktree's
    // sanitized project dir, the way `claude --session-id sess-relo` would once it ran.
    const fromDir = join(projects, rec.worktreePath.replace(/\//g, '-'));
    const toDir = join(projects, repo.replace(/\//g, '-'));
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    mkdirSync(join(fromDir, 'sess-relo'), { recursive: true });
    writeFileSync(join(fromDir, 'sess-relo.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(fromDir, 'sess-relo.title'), 'a title');
    writeFileSync(join(fromDir, 'sess-relo', 'marker'), 'subagent goes here');

    await m.archive('sess-relo');

    // All three artifacts landed in the parent project's sanitized dir.
    expect(existsSync(join(toDir, 'sess-relo.jsonl'))).toBe(true);
    expect(existsSync(join(toDir, 'sess-relo.title'))).toBe(true);
    expect(existsSync(join(toDir, 'sess-relo', 'marker'))).toBe(true);
    // …and the now-empty source dir got cleaned up.
    expect(existsSync(fromDir)).toBe(false);
  });

  it('remove()/archive() are idempotent', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await m.create({ sessionId: 'sessid', projectCwd: repo, baseBranch: 'main' });
    await m.remove('sessid');
    await m.remove('sessid'); // no throw
    expect(m.get('sessid')).toBeUndefined();
  });

  it('create() copies allowlisted gitignored files (CLAUDE.md, .claude/, docs/, .env*)', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Pin a gitignore so the repo's ignore rules are deterministic across machines.
    writeFileSync(join(repo, '.gitignore'), [
      'CLAUDE.md',
      'CLAUDE.local.md',
      '.claude/',
      'docs/private/',
      '.env',
      '.env.local',
      'node_modules/',
      'secret.txt',
    ].join('\n') + '\n');
    execFileSync('git', ['-C', repo, 'add', '.gitignore']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'gitignore']);

    // Allowlisted ignored content.
    writeFileSync(join(repo, 'CLAUDE.md'), '# local claude\n');
    writeFileSync(join(repo, 'CLAUDE.local.md'), '# local local\n');
    mkdirSync(join(repo, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'commands', 'foo.md'), 'foo\n');
    mkdirSync(join(repo, 'docs', 'private'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'private', 'notes.md'), 'notes\n');
    writeFileSync(join(repo, '.env'), 'SECRET=x\n');
    writeFileSync(join(repo, '.env.local'), 'SECRET=y\n');

    // NOT allowlisted — should be skipped.
    mkdirSync(join(repo, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'foo', 'index.js'), '// skip me\n');
    writeFileSync(join(repo, 'secret.txt'), 'do not copy\n');

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-copy', projectCwd: repo, baseBranch: 'main' });

    expect(readFileSync(join(rec.worktreePath, 'CLAUDE.md'), 'utf8')).toBe('# local claude\n');
    expect(readFileSync(join(rec.worktreePath, 'CLAUDE.local.md'), 'utf8')).toBe('# local local\n');
    expect(readFileSync(join(rec.worktreePath, '.claude', 'commands', 'foo.md'), 'utf8')).toBe('foo\n');
    expect(readFileSync(join(rec.worktreePath, 'docs', 'private', 'notes.md'), 'utf8')).toBe('notes\n');
    expect(readFileSync(join(rec.worktreePath, '.env'), 'utf8')).toBe('SECRET=x\n');
    expect(readFileSync(join(rec.worktreePath, '.env.local'), 'utf8')).toBe('SECRET=y\n');

    expect(existsSync(join(rec.worktreePath, 'node_modules'))).toBe(false);
    expect(existsSync(join(rec.worktreePath, 'secret.txt'))).toBe(false);
  });

  it('create() rejects malformed sessionId (path traversal / argv injection)', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(
      m.create({ sessionId: '../escape', projectCwd: repo, baseBranch: 'main' }),
    ).rejects.toThrow(/invalid sessionId/);
    await expect(
      m.create({ sessionId: '-flag-shaped', projectCwd: repo, baseBranch: 'main' }),
    ).rejects.toThrow(/invalid sessionId/);
  });

  it('create() rejects malformed baseBranch (argv injection)', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(
      m.create({ sessionId: 'okid', projectCwd: repo, baseBranch: '-flag-shape' }),
    ).rejects.toThrow(/invalid baseBranch/);
    await expect(
      m.create({ sessionId: 'okid2', projectCwd: repo, baseBranch: 'has spaces' }),
    ).rejects.toThrow(/invalid baseBranch/);
  });
});
