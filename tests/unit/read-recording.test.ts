import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readInputKey, recordableRead, rekeyRead } from '../../src/permissions/read-recording.js';

const PULL: string[] = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8')).pull.alwaysAllowBashPatterns;

describe('recordableRead', () => {
  it('records pull-group bash, external MCP reads and web reads only', () => {
    expect(recordableRead('Bash', { command: 'gh pr view 12 --json state' }, PULL)).toBe(true);
    expect(recordableRead('Bash', { command: 'cat src/x.ts' }, PULL)).toBe(false);
    expect(recordableRead('Bash', { command: 'gh pr view 1; rm -rf x' }, PULL)).toBe(false);
    expect(recordableRead('mcp__claude_ai_Linear__get_issue', { id: 'X' }, PULL)).toBe(true);
    expect(recordableRead('mcp__claude_ai_Linear__save_comment', { body: 'x' }, PULL)).toBe(false);
    expect(recordableRead('mcp__outpost__submit_step_output', {}, PULL)).toBe(false);
    expect(recordableRead('WebFetch', { url: 'https://x' }, PULL)).toBe(true);
    expect(recordableRead('Read', { file_path: '/x' }, PULL)).toBe(false);
  });
});

describe('readInputKey', () => {
  it('is stable across key order and outer whitespace', () => {
    expect(readInputKey('Bash', { command: ' gh pr view 1 ' })).toBe(readInputKey('Bash', { command: 'gh pr view 1' }));
    expect(readInputKey('mcp__x__get', { a: 1, b: 2 })).toBe(readInputKey('mcp__x__get', { b: 2, a: 1 }));
  });

  it('ignores the free-text fields a model rewrites on every call', () => {
    expect(readInputKey('Bash', { command: 'gh pr view 12', description: 'Check PR' }))
      .toBe(readInputKey('Bash', { command: 'gh pr view 12', description: 'Look up the PR', timeout: 5000 }));
    expect(readInputKey('WebFetch', { url: 'https://x', prompt: 'summarize' }))
      .toBe(readInputKey('WebFetch', { url: 'https://x', prompt: 'what is the version' }));
    expect(readInputKey('WebFetch', { url: 'https://x' })).not.toBe(readInputKey('WebFetch', { url: 'https://y' }));
  });

  it('rekeys a read recorded under the old whole-input key', () => {
    const legacy = { tool: 'Bash', inputKey: `Bash:${JSON.stringify({ command: 'gh pr view 1', description: 'old' })}`, responseRef: 'r' };
    expect(rekeyRead(legacy).inputKey).toBe(readInputKey('Bash', { command: 'gh pr view 1', description: 'new' }));
  });
});
