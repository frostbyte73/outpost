import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitMergingFromBase } from '../../src/git/git-ops.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
}

function commit(cwd: string, body: string, msg: string): void {
  writeFileSync(join(cwd, 'f.txt'), body);
  git(cwd, 'add', 'f.txt');
  git(cwd, 'commit', '-qm', msg);
}

// origin/main and the feature branch both edit f.txt, so the merge stops with MERGE_HEAD set.
function conflictedClone(): string {
  const root = mkdtempSync(join(tmpdir(), 'merging-from-base-'));
  const origin = join(root, 'origin');
  git(root, 'init', '-q', '-b', 'main', origin);
  commit(origin, 'base\n', 'base');
  const clone = join(root, 'clone');
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-qb', 'feature');
  commit(clone, 'feature\n', 'feature');
  commit(origin, 'main moved\n', 'main moved');
  git(clone, 'fetch', '-q', 'origin');
  return clone;
}

describe('gitMergingFromBase', () => {
  it('is true mid-merge of origin/<base>', async () => {
    const clone = conflictedClone();
    expect(() => git(clone, 'merge', '-q', 'origin/main')).toThrow();
    expect(await gitMergingFromBase(clone, 'main')).toBe(true);
  });

  it('is false with no merge in progress, or a merge of something else', async () => {
    const clone = conflictedClone();
    expect(await gitMergingFromBase(clone, 'main')).toBe(false);
    git(clone, 'checkout', '-qb', 'other', 'origin/main');
    git(clone, 'checkout', '-q', 'feature');
    expect(() => git(clone, 'merge', '-q', 'other')).toThrow();
    expect(await gitMergingFromBase(clone, 'release')).toBe(false);
  });
});
