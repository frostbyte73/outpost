import { describe, it, expect } from 'vitest';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import { CLAUDE_TOOL_NAMES, canonicalToolName } from '../../src/runtime/tools.js';

const allowlist = (cfg: Partial<AllowlistConfig>) => new Allowlist({
  alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [], ...cfg,
});

describe('Claude tool names alias canonical ones without widening any rule', () => {
  it('maps no two Claude tools onto one canonical name, and is idempotent', () => {
    const canonical = CLAUDE_TOOL_NAMES.map(([, c]) => c);
    expect(new Set(canonical).size).toBe(canonical.length);
    for (const name of [...CLAUDE_TOOL_NAMES.map(([c]) => c), 'mcp__linear__get_issue', 'Foo']) {
      const once = canonicalToolName(name);
      expect(canonicalToolName(once), name).toBe(once);
    }
  });

  it('keeps a path rule on one write tool off its siblings', () => {
    const a = allowlist({ alwaysAllowPathPatterns: ['Write:^/tmp/'] });
    expect(a.allows('Write', { file_path: '/tmp/x' })).toBe(true);
    expect(a.allows('Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' })).toBe(false);
  });

  it('reads a whole-tool Bash grant as exactly the shell tool', () => {
    const a = allowlist({ alwaysAllow: ['Bash'] });
    expect(a.allows('Bash', { command: 'ls' })).toBe(true);
    expect(a.allows('Write', { file_path: '/etc/x' })).toBe(false);
  });

  it('grants nothing for a rule written in canonical spelling, as before the rename', () => {
    const a = allowlist({ alwaysAllow: ['file_read'], alwaysAllowPathPatterns: ['file_write:^/tmp/'] });
    expect(a.allows('Read', { file_path: '/tmp/x' })).toBe(false);
    expect(a.allows('Write', { file_path: '/tmp/x' })).toBe(false);
  });

  it('matches MCP regex rules through either spelling', () => {
    const a = allowlist({ alwaysAllowMcpPatterns: ['^mcp__linear__get_'] });
    expect(a.allows('mcp__linear__get_issue', {})).toBe(true);
    expect(a.allows('mcp:linear/get_issue', {})).toBe(true);
    expect(a.allows('mcp__linear__create_issue', {})).toBe(false);
  });

  it('revokes a whole-tool grant that the file listed twice', () => {
    const a = allowlist({ alwaysAllow: ['Bash', 'Bash'] });
    expect(a.removeRule('tool', 'Bash')).toBe(true);
    expect(a.allows('Bash', { command: 'ls' })).toBe(false);
  });

  it('persists the spelling the rule was written in', () => {
    expect(allowlist({ alwaysAllow: ['Bash'] }).toConfig().alwaysAllow).toEqual(['Bash']);
  });
});
