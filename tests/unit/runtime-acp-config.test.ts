import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAcpAgents } from '../../src/runtime/acp/config.js';

describe('loadAcpAgents', () => {
  it('skips an agent whose id is a built-in runtime', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'acp-')), 'acp-agents.json');
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
