import { describe, it, expect } from 'vitest';
import { toolItem } from '../../src/runtime/acp/events.js';
import type { AcpToolCall } from '../../src/runtime/acp/permission.js';
import type { AcpAgentConfig } from '../../src/runtime/acp/config.js';

const cfg: AcpAgentConfig = {
  id: 'cursor', command: 'agent', args: ['acp'], env: {}, shellCommandField: 'command',
};
const call = (c: Omit<AcpToolCall, 'toolCallId'>): AcpToolCall => ({ toolCallId: 't1', status: 'in_progress', ...c });

// Cursor's frames: a display title, no rawInput. The transcript's renderers match Claude-shaped names exactly.
describe('toolItem display names', () => {
  it('shows a titled shell call as a Bash call on its command', () => {
    const item = toolItem(call({ title: '`echo hi`', kind: 'execute' }), cfg);
    expect(item).toMatchObject({ rawName: 'Bash', tool: 'shell', input: { command: 'echo hi' } });
  });

  it('prefers the command the agent sent over the title, and keeps its other fields', () => {
    const item = toolItem(call({ title: '`ls`', kind: 'execute', rawInput: { command: 'ls -la', description: 'List' } }), cfg);
    expect(item).toMatchObject({ rawName: 'Bash', input: { command: 'ls -la', description: 'List' } });
  });

  it('shows an unbackticked shell title as the command it names', () => {
    expect(toolItem(call({ title: 'grep -l "x" a.ts', kind: 'execute' }), cfg))
      .toMatchObject({ rawName: 'Bash', input: { command: 'grep -l "x" a.ts' } });
  });

  it('shows an edit as an Edit on the file its title names, with the diff when one is sent', () => {
    expect(toolItem(call({ title: 'Edit `/w/a.txt`', kind: 'edit' }), cfg))
      .toMatchObject({ rawName: 'Edit', tool: 'file_edit', input: { file_path: '/w/a.txt' } });
    expect(toolItem(call({
      title: 'Edit a.txt', kind: 'edit', locations: [{ path: '/w/a.txt' }],
      content: [{ type: 'diff', path: '/w/a.txt', oldText: 'a', newText: 'b' }],
    }), cfg)).toMatchObject({ rawName: 'Edit', input: { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' } });
  });

  it('keeps an edit title that names no file, rather than rendering an empty Edit', () => {
    expect(toolItem(call({ title: 'Edit File', kind: 'edit' }), cfg)).toMatchObject({ rawName: 'Edit File', input: {} });
  });

  it('shows a read as a Read on its file', () => {
    expect(toolItem(call({ title: 'Read src/a.ts', kind: 'read' }), cfg))
      .toMatchObject({ rawName: 'Read', tool: 'file_read', input: { file_path: 'src/a.ts' } });
  });

  it('shows a search as a Grep only when it has a pattern', () => {
    expect(toolItem(call({ title: 'grep', kind: 'search', rawInput: { pattern: 'ships', path: 'src' } }), cfg))
      .toMatchObject({ rawName: 'Grep', tool: 'file_grep', input: { pattern: 'ships', path: 'src' } });
    expect(toolItem(call({ title: 'grep', kind: 'search' }), cfg)).toMatchObject({ rawName: 'grep', input: {} });
  });

  it('leaves MCP calls named by their title', () => {
    const mcpCfg = { ...cfg, mcpTitlePattern: '^(?<server>[\\w-]+)-(?<tool>[\\w-]+): \\k<tool>$' };
    expect(toolItem(call({ title: 'outpost-submit_plan: submit_plan', kind: 'other' }), mcpCfg))
      .toMatchObject({ kind: 'mcp_tool_call', rawName: 'outpost-submit_plan: submit_plan' });
  });
});
