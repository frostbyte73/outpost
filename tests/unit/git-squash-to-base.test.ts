import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSquashMergeToBase } from '../../src/git/git-ops.js';
import { makeParentAndWorktree } from './helpers/squash-repo.js';

describe('gitSquashMergeToBase', () => {
  it('lands a single squashed commit on base when clean', async () => {
    const { parent, wt, g } = makeParentAndWorktree();
    const r = await gitSquashMergeToBase({ parentCwd: parent, worktreePath: wt, worktreeBranch: 'feat/x', baseBranch: 'main', message: 'land it' });
    expect(r.ok).toBe(true);
    expect(g('log', '--oneline', '-1').trim()).toContain('land it');
    expect(g('status', '--porcelain').trim()).toBe('');
  });

  it('returns reason:conflict and leaves the parent checkout clean', async () => {
    const { parent, wt, g } = makeParentAndWorktree({ mainEdit: 'MAIN DIVERGED\n' });
    const r = await gitSquashMergeToBase({ parentCwd: parent, worktreePath: wt, worktreeBranch: 'feat/x', baseBranch: 'main', message: 'land it' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('conflict');
    if (r.reason === 'conflict') expect(r.files).toContain('f.txt');
    // Parent must be restored to a clean base — no lingering conflict markers/index.
    expect(g('status', '--porcelain').trim()).toBe('');
    expect(g('log', '--oneline', '-1').trim()).toContain('main moved');
  });

  it('refuses when the worktree has an untracked file (would be dropped from the squash)', async () => {
    const { parent, wt, g } = makeParentAndWorktree();
    writeFileSync(join(wt, 'new-file.ts'), 'export const x = 1;\n');
    const r = await gitSquashMergeToBase({ parentCwd: parent, worktreePath: wt, worktreeBranch: 'feat/x', baseBranch: 'main', message: 'land it' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('error');
    if (r.reason === 'error') expect(r.message).toContain('new-file.ts');
    // Nothing landed on base; parent untouched.
    expect(g('log', '--oneline', '-1').trim()).toContain('seed');
  });

  it('rejects an invalid branch name', async () => {
    const { parent, wt } = makeParentAndWorktree();
    const r = await gitSquashMergeToBase({ parentCwd: parent, worktreePath: wt, worktreeBranch: '--force', baseBranch: 'main', message: 'x' });
    expect(r.ok).toBe(false);
  });
});
