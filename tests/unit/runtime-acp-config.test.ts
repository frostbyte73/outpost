import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addAcpAgent, loadAcpAgents, removeAcpAgent } from '../../src/runtime/acp/config.js';

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'acp-')), 'acp-agents.json');

describe('loadAcpAgents', () => {
  it('skips an agent whose id is a built-in runtime', () => {
    const path = tmpPath();
    const agent = (id: string) => ({ id, command: 'agent', args: ['acp'] });
    writeFileSync(path, JSON.stringify({ agents: [agent('gemini'), agent('cursor'), agent('codex')] }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(loadAcpAgents(path).map((a) => a.id)).toEqual(['gemini']);
    } finally {
      err.mockRestore();
    }
  });
});

describe('addAcpAgent / removeAcpAgent', () => {
  it('appends a valid agent and removes it again', () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ agents: [] }));
    const added = addAcpAgent(path, { id: 'goose', label: 'Goose', command: 'goose', args: ['acp'] });
    expect(added).toMatchObject({ id: 'goose', command: 'goose', args: ['acp'] });
    expect(loadAcpAgents(path).map((a) => a.id)).toEqual(['goose']);
    expect(removeAcpAgent(path, 'goose')).toBe(true);
    expect(removeAcpAgent(path, 'goose')).toBe(false);
    expect(loadAcpAgents(path)).toEqual([]);
  });

  it('refuses what loading would skip, leaving the file alone', () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'goose', command: 'goose' }] }));
    const before = readFileSync(path, 'utf8');
    expect(() => addAcpAgent(path, { id: 'goose', command: 'goose' })).toThrow(/duplicate/);
    expect(() => addAcpAgent(path, { id: 'codex', command: 'x' })).toThrow(/built-in/);
    expect(() => addAcpAgent(path, { id: 'ok', command: '' })).toThrow(/command/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('will not rewrite a file it cannot read, which would drop whatever the user was fixing', () => {
    const path = tmpPath();
    writeFileSync(path, '{ "agents": [');
    expect(() => addAcpAgent(path, { id: 'goose', command: 'goose' })).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ "agents": [');
  });
});
