import { describe, it, expect } from 'vitest';
import { Allowlist } from '../../src/allowlist.js';
import config from '../../config/allowlist.json' with { type: 'json' };

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
