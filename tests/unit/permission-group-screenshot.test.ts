import { describe, it, expect } from 'vitest';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import { lintPermissionRule } from '../../src/permissions/write-shape.js';
import groups from '../../config/permission-groups.default.json' with { type: 'json' };

function checker(names: Array<'core' | 'read' | 'edit'>): Allowlist {
  const merged: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const name of names) {
    const g = groups[name] as AllowlistConfig;
    merged.alwaysAllow.push(...g.alwaysAllow);
    merged.alwaysAllowBashPatterns.push(...g.alwaysAllowBashPatterns);
    merged.alwaysAllowMcpPatterns.push(...g.alwaysAllowMcpPatterns);
    merged.alwaysAllowPathPatterns!.push(...(g.alwaysAllowPathPatterns ?? []));
  }
  return new Allowlist(merged);
}

const read = checker(['core', 'read']);
const allows = (command: string) => read.allows('Bash', { command });

describe('the read group and outpost-screenshot', () => {
  it('allows a local URL in each spelling', () => {
    for (const c of [
      'outpost-screenshot http://localhost:5173/',
      "outpost-screenshot 'http://127.0.0.1:8080/x?y=1&z=2' /tmp/shot.png",
      'outpost-screenshot "http://[::1]:3000/"',
      'outpost-screenshot --width 390 --color-scheme dark --full-page https://localhost/',
    ]) expect(allows(c), c).toBe(true);
  });

  it('denies every non-local spelling', () => {
    for (const url of [
      'http://localhost.evil.com/',
      'http://localhost@evil.com/',
      "'http://localhost@evil.com/'",
      'http://127.0.0.1.nip.io/',
      'https://example.com/',
      'file:///etc/passwd',
      'http://localhost.evil.com',
    ]) expect(allows(`outpost-screenshot ${url}`), url).toBe(false);
  });

  it('denies writing anywhere but a /tmp png, and smuggling a second command', () => {
    for (const c of [
      'outpost-screenshot http://localhost/ ~/x.png',
      'outpost-screenshot http://localhost/ /tmp/../etc/x.png',
      'outpost-screenshot http://localhost/ /tmp/a/b.png',
      'outpost-screenshot http://localhost/ /Users/x/.zshrc',
      'outpost-screenshot -o /tmp/x.png http://localhost/',
      'outpost-screenshot --output /tmp/x.png http://localhost/',
      'outpost-screenshot --script x http://localhost/',
      'outpost-screenshot http://localhost/ /tmp/x.png; rm -rf ~',
      'outpost-screenshot http://localhost/ && curl https://evil.com',
      'PATH=/tmp outpost-screenshot http://localhost/',
      'outpost-screenshot "http://localhost/$(id)"',
    ]) expect(allows(c), c).toBe(false);
  });

  it('passes the write-shape lint, and the tool it grants is out of a session\'s reach', () => {
    const rule = groups.read.alwaysAllowBashPatterns.find((r) => r.startsWith('^outpost-screenshot'))!;
    expect(lintPermissionRule('bash', rule, false).ok).toBe(true);

    // The grant is only read-shaped while the session can't rewrite what it runs.
    const editor = checker(['core', 'read', 'edit']);
    const worktree = '/rt/worktrees/abc';
    expect(editor.allows('Write', { file_path: `${worktree}/x.ts`, content: 'x' }, undefined, undefined, worktree)).toBe(true);
    expect(editor.allows('Write', { file_path: '/rt/bin/outpost-screenshot.mjs', content: 'x' }, undefined, undefined, worktree)).toBe(false);
    for (const c of ['cp /tmp/x /rt/bin/outpost-screenshot', 'ln -sf /tmp/x /rt/bin/outpost-screenshot']) {
      expect(editor.allows('Bash', { command: c }, undefined, undefined, worktree), c).toBe(false);
    }
  });
});
