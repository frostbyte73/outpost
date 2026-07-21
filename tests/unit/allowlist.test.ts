import { describe, it, expect } from 'vitest';
import { Allowlist, Allowlist as AllowlistCtor } from '../../src/permissions/allowlist.js';
import config from '../../config/allowlist.default.json' with { type: 'json' };
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const a = new Allowlist(config);

describe('Allowlist', () => {
  it('always-allowed tools pass regardless of input', () => {
    expect(a.allows('Read', { file_path: '/etc/passwd' })).toBe(true);
    expect(a.allows('Grep', { pattern: 'x' })).toBe(true);
  });

  it('read-only bash commands pass', () => {
    expect(a.allows('Bash', { command: 'ls -la' })).toBe(true);
    expect(a.allows('Bash', { command: 'kubectl get pods -n default' })).toBe(true);
    expect(a.allows('Bash', { command: 'rg "foo" .' })).toBe(true);
  });

  it('write-ish bash commands do NOT pass', () => {
    expect(a.allows('Bash', { command: 'kubectl delete pod foo' })).toBe(false);
    expect(a.allows('Bash', { command: 'rm -rf /' })).toBe(false);
  });

  it('read-only MCP tools pass', () => {
    expect(a.allows('mcp__incident-io__incident_show', { id: 'INC-1' })).toBe(true);
    expect(a.allows('mcp__notion__notion-fetch', { id: 'page' })).toBe(true);
  });

  it('write MCP tools do NOT pass', () => {
    expect(a.allows('mcp__incident-io__incident_update', { id: 'INC-1' })).toBe(false);
    expect(a.allows('mcp__incident-io__follow_up_create', {})).toBe(false);
    expect(a.allows('mcp__claude_ai_Slack__slack_send_message', {})).toBe(false);
  });

  it('unknown tools default to NOT allowed', () => {
    expect(a.allows('UnknownTool', {})).toBe(false);
  });
});

describe('Allowlist — project scope', () => {
  it('returns false when project rule needed but no projectCwd given', () => {
    const a = new AllowlistCtor({ alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] });
    expect(a.allows('Bash', { command: 'kubectl delete pod x' })).toBe(false);
  });

  it('merges project rules from disk: tool name in project file allows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
    mkdirSync(dir, { recursive: true });
    const projCwd = '/tmp/projA';
    const sanitized = projCwd.replace(/\//g, '-');
    writeFileSync(join(dir, `${sanitized}.json`), JSON.stringify({
      alwaysAllow: ['DangerousTool'],
      alwaysAllowBashPatterns: [],
      alwaysAllowMcpPatterns: [],
    }));
    const a = new AllowlistCtor(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    expect(a.allows('DangerousTool', {}, projCwd)).toBe(true);
    expect(a.allows('DangerousTool', {})).toBe(false); // no project cwd → no merge
  });

  it('merges project bash pattern', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
    const projCwd = '/tmp/projB';
    writeFileSync(join(dir, `${projCwd.replace(/\//g, '-')}.json`), JSON.stringify({
      alwaysAllow: [],
      alwaysAllowBashPatterns: ['^kubectl delete pod '],
      alwaysAllowMcpPatterns: [],
    }));
    const a = new AllowlistCtor(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    expect(a.allows('Bash', { command: 'kubectl delete pod x' }, projCwd)).toBe(true);
  });

  it('global rule wins even if project file absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
    const a = new AllowlistCtor(
      { alwaysAllow: ['Read'], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    expect(a.allows('Read', {}, '/tmp/no-such-project')).toBe(true);
  });

  it('addRule with project scope writes to <dir>/<sanitized>.json atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
    const projCwd = '/tmp/projC';
    const a = new AllowlistCtor(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    const added = a.addRule('tool', 'NewProjectTool', { project: projCwd });
    expect(added).toBe(true);
    // In-memory check.
    expect(a.allows('NewProjectTool', {}, projCwd)).toBe(true);
    // Re-construct from the persisted file; should still allow.
    const fresh = new AllowlistCtor(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    expect(fresh.allows('NewProjectTool', {}, projCwd)).toBe(true);
  });

  it('addRule with global scope does NOT touch project files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
    const a = new AllowlistCtor(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    const added = a.addRule('tool', 'GlobalOnlyTool', 'global');
    expect(added).toBe(true);
    expect(a.allows('GlobalOnlyTool', {})).toBe(true);
    expect(a.allows('GlobalOnlyTool', {}, '/tmp/x')).toBe(true);
  });

  it('project allowlist files are created with 0o600 mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
    const projCwd = '/tmp/projD';
    const a = new AllowlistCtor(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    a.addRule('tool', 'X', { project: projCwd });
    const filePath = join(dir, `${projCwd.replace(/\//g, '-')}.json`);
    const stat = statSync(filePath);
    // Mask out filetype bits, keep permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
    // Directory should also be 0o700.
    const dirStat = statSync(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});
