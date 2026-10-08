import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncRepoCopy } from '../../src/actions/repo-copy.js';

function repoWith(body: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'repo-copy-'));
  const dir = join(root, 'code', 'implement');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, body);
  return { root, path };
}

describe('syncRepoCopy', () => {
  it('writes when the repo copy matches the expected body', () => {
    const { root, path } = repoWith('before');
    expect(syncRepoCopy(root, 'code.implement', 'before', 'after')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('after');
  });

  it('leaves a diverged repo copy alone', () => {
    const { root, path } = repoWith('repo-only');
    expect(syncRepoCopy(root, 'code.implement', 'before', 'after')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('repo-only');
  });

  it('skips an action the repo does not carry', () => {
    const { root } = repoWith('before');
    expect(syncRepoCopy(root, 'code.plan', 'before', 'after')).toBe(false);
  });
});
