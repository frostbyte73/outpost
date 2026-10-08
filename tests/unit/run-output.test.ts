import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSince, renderOutputs, snapshotWorktree } from '../../src/eval/run-output.js';

describe('renderOutputs', () => {
  it('renders a draft with /tmp paths masked and file bodies inline', () => {
    const text = renderOutputs([{
      tool: 'submit_write_draft',
      args: { summary: 's', calls: [{ label: 'reply', bash: 'gh api --input /tmp/x.json', files: { '/tmp/x.json': '{"body":"hi"}' } }] },
    }]);
    expect(text).toContain('gh api --input <tmp>');
    expect(text).toContain('hi');
  });

  it('renders a worktree diff verbatim', () => {
    expect(renderOutputs([{ tool: 'worktree-diff', args: { diff: '+a\n-b' } }])).toContain('+a\n-b');
  });

  it('renders a progress submit by its fields', () => {
    const text = renderOutputs([{ tool: 'submit_step_progress', args: { next: { kind: 'resolve', output: 'done' }, artifacts: { spec: '# Spec' } } }]);
    expect(text).toContain('next.kind:\nresolve');
    expect(text).toContain('# Spec');
  });

  it('says so when nothing was submitted', () => {
    expect(renderOutputs([])).toBe('(no output)');
  });
});

describe('worktree snapshots', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'wtsnap-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i');
    return { dir, git };
  }

  it('captures uncommitted and untracked work without touching the real index', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'new.txt'), 'fresh\n');
    const before = git('status', '--porcelain');
    const snap = await snapshotWorktree(dir);
    expect(git('status', '--porcelain')).toBe(before);
    expect(git('show', `${snap.commit}:a.txt`)).toBe('two\n');
    expect(git('show', `${snap.commit}:new.txt`)).toBe('fresh\n');
    expect(git('rev-parse', `${snap.commit}^`).trim()).toBe(git('rev-parse', 'HEAD').trim());
    expect(snap.gitDir).toMatch(/\.git$/);
  });

  it('diffs only what changed since the snapshot, untracked files included', async () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const snap = await snapshotWorktree(dir);
    writeFileSync(join(dir, 'a.txt'), 'three\n');
    writeFileSync(join(dir, 'later.txt'), 'late\n');
    const diff = await diffSince(dir, snap.commit);
    expect(diff).toContain('-two');
    expect(diff).toContain('+three');
    expect(diff).toContain('+late');
    expect(diff).not.toContain('-one');
  });
});
