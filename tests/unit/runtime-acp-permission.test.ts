import { describe, it, expect } from 'vitest';
import { gateCallsFor, permissionReply, type AcpToolCall } from '../../src/runtime/acp/permission.js';
import type { AcpAgentConfig } from '../../src/runtime/acp/config.js';

const cfg: AcpAgentConfig = {
  id: 'fake', command: 'fake', args: [], env: {}, shellCommandField: 'command',
  mcpTitlePattern: '^(?<server>[a-z]+)_(?<tool>.+)$',
};
const call = (c: Omit<AcpToolCall, 'toolCallId'>): AcpToolCall => ({ toolCallId: 't1', ...c });

// Every case here is a request Outpost can't fully read; answering it with anything but a denial runs it ungated.
describe('gateCallsFor', () => {
  it('denies a shell call with no command or a working directory other than the session', () => {
    expect(gateCallsFor(call({ kind: 'execute', rawInput: {} }), '/w', cfg)).toHaveProperty('deny');
    expect(gateCallsFor(call({ kind: 'execute', rawInput: { command: 'ls', directory: '/etc' } }), '/w', cfg)).toHaveProperty('deny');
    expect(gateCallsFor(call({ kind: 'execute', rawInput: { command: 'ls', dir_path: '../elsewhere' } }), '/w', cfg)).toHaveProperty('deny');
  });

  it('denies an edit that names no file, and gates every file one names', () => {
    expect(gateCallsFor(call({ kind: 'edit', rawInput: { anything: 1 } }), '/w', cfg)).toHaveProperty('deny');
    const calls = gateCallsFor(call({
      kind: 'edit', locations: [{ path: 'a.ts' }], content: [{ type: 'diff', path: '/w/b.ts' }],
    }), '/w', cfg);
    expect(calls).toEqual([
      { tool: 'file_edit', rawName: 'edit', input: { file_path: '/w/a.ts' } },
      { tool: 'file_edit', rawName: 'edit', input: { file_path: '/w/b.ts' } },
    ]);
  });

  it('names an MCP call only when the title matches the agent pattern', () => {
    expect(gateCallsFor(call({ kind: 'other', title: 'outpost_submit_step_output' }), '/w', cfg))
      .toEqual([{ tool: 'mcp:outpost/submit_step_output', rawName: 'outpost_submit_step_output', input: {} }]);
    expect(gateCallsFor(call({ kind: 'other', title: 'Do Something' }), '/w', cfg))
      .toEqual([{ tool: 'native:Do Something', rawName: 'Do Something', input: {} }]);
  });
});

describe('permissionReply', () => {
  it('never answers allow_always, even when it is the only allow offered', () => {
    const all = [{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'ao', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }];
    expect(permissionReply(all, true)).toEqual({ outcome: { outcome: 'selected', optionId: 'ao' } });
    const noOnce = [{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'r', kind: 'reject_once' }];
    expect(permissionReply(noOnce, true)).toEqual({ outcome: { outcome: 'selected', optionId: 'r' } });
  });
});
