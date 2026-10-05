import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCommitsSince, gitFinalizeSquashToBranch, gitPrDraftContext } from '../../src/git/git-ops.js';
import { prDraftInput } from '../../src/git/pr-draft.js';

// The squash-and-open-PR path used to publish the last round's commit message as the PR. A draft
// has to see every round: each commit since base, plus the uncommitted one about to be made.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-draft-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'Round 1: add two\n\nFirst body.');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('commit', '-q', '-am', 'Round 2: add three');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
  return { dir, base };
}

describe('PR draft context', () => {
  it('counts the rounds already committed since base', async () => {
    const { dir, base } = repo();
    expect(await gitCommitsSince(dir, base)).toBe(2);
    expect(await gitCommitsSince(dir, '-oops')).toBeNull();
  });

  it('holds every commit oldest first, the uncommitted round, and new files', async () => {
    const { dir, base } = repo();
    const ctx = (await gitPrDraftContext(dir, base))!;
    expect(ctx.commits).toEqual(['Round 1: add two\n\nFirst body.', 'Round 2: add three']);
    expect(ctx.dirty).toBe(true);
    expect(ctx.diff).toContain('+four');
    expect(ctx.untracked).toEqual(['new.txt']);
    expect(ctx.diffTruncated).toBe(false);
  });

  it('caps the diff and says so', async () => {
    const { dir, base } = repo();
    const ctx = (await gitPrDraftContext(dir, base, 20))!;
    expect(ctx.diff).toHaveLength(20);
    expect(ctx.diffTruncated).toBe(true);
  });

  it('gives the drafter the ticket, every plan step and every round', async () => {
    const { dir, base } = repo();
    const ctx = (await gitPrDraftContext(dir, base))!;
    const job = {
      title: 'Count to four', description: 'The file stops at one.', externalRef: { url: 'u', issueIdentifier: 'ENG-1' },
      steps: [{ title: 'Add two', goal: 'Append two', cancelled: false }, { title: 'Dropped', goal: 'x', cancelled: true }],
    } as never;
    const input = prDraftInput(job, ctx);
    expect(input).toContain('ENG-1: Count to four');
    expect(input).toContain('1. Add two — Append two');
    expect(input).not.toContain('Dropped');
    expect(input).toContain('Round 1: add two');
    expect(input).toContain('Round 2: add three');
    expect(input).toContain('# Uncommitted work');
    expect(input).toContain('new.txt');
  });
});

describe('squash with the drafted PR text', () => {
  it('commits the PR title and description as the squash message, not the last round\'s', async () => {
    const { dir, base } = repo();
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'Round 3']);
    const res = await gitFinalizeSquashToBranch({
      worktreePath: dir, baseBranch: 'main', baseRef: base, newBranch: 'feat/x',
      message: 'Round 3', pr: { title: 'Count to four', body: 'All three rounds.' },
    });
    // No origin in this scratch repo, so it stops at the push — after the squash commit.
    expect(res.ok).toBe(false);
    expect(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B'], { encoding: 'utf8' }).trim()).toBe('Count to four\n\nAll three rounds.');
    expect(execFileSync('git', ['-C', dir, 'rev-list', '--count', `${base}..HEAD`], { encoding: 'utf8' }).trim()).toBe('1');
  });
});
