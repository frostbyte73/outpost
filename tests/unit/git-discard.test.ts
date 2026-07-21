import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDiscard } from '../../src/git/git-ops.js';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-discard-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
  return dir;
}

function status(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
}

describe('gitDiscard — everything', () => {
  it('restores staged + unstaged edits and removes untracked files', async () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, 'a.txt'), 'CHANGED\n');
    execFileSync('git', ['-C', dir, 'add', 'a.txt']);          // staged edit
    writeFileSync(join(dir, 'b.txt'), 'ALSO CHANGED\n');       // unstaged edit
    writeFileSync(join(dir, 'new.txt'), 'untracked\n');        // untracked
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.txt'), 'nested\n'); // untracked dir

    const r = await gitDiscard(dir);
    expect(r.ok).toBe(true);
    expect(status(dir)).toBe('');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);
    expect(existsSync(join(dir, 'sub'))).toBe(false);
  });
});

describe('gitDiscard — per-path', () => {
  it('discards only the named paths, leaving other changes intact', async () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, 'a.txt'), 'CHANGED\n');
    writeFileSync(join(dir, 'b.txt'), 'KEEP ME\n');

    const r = await gitDiscard(dir, ['a.txt']);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('KEEP ME\n');
    expect(status(dir)).toBe('M b.txt');
  });

  it('removes an untracked path', async () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, 'new.txt'), 'untracked\n');
    const r = await gitDiscard(dir, ['new.txt']);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);
  });

  it('removes a staged-new file (no HEAD version to restore)', async () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, 'added.txt'), 'staged new\n');
    execFileSync('git', ['-C', dir, 'add', 'added.txt']);
    const r = await gitDiscard(dir, ['added.txt']);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'added.txt'))).toBe(false);
    expect(status(dir)).toBe('');
  });

  it('undoes a staged rename, restoring the original path', async () => {
    const dir = makeGitRepo();
    renameSync(join(dir, 'a.txt'), join(dir, 'renamed.txt'));
    execFileSync('git', ['-C', dir, 'add', '-A']);
    const r = await gitDiscard(dir, ['renamed.txt', 'a.txt']);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(dir, 'renamed.txt'))).toBe(false);
    expect(status(dir)).toBe('');
  });

  it('rejects flag-smuggling and absolute paths', async () => {
    const dir = makeGitRepo();
    expect((await gitDiscard(dir, ['--force'])).ok).toBe(false);
    expect((await gitDiscard(dir, ['/etc/passwd'])).ok).toBe(false);
    expect((await gitDiscard(dir, [''])).ok).toBe(false);
  });

  it('is a no-op for clean paths', async () => {
    const dir = makeGitRepo();
    const r = await gitDiscard(dir, ['a.txt']);
    expect(r.ok).toBe(true);
    expect(status(dir)).toBe('');
  });
});
