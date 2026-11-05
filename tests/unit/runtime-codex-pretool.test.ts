import { describe, it, expect, vi } from 'vitest';
import { decideCodexPreTool, type CodexPreToolPayload } from '../../src/runtime/codex/pretool.js';
import type { GateDecision, GateRequest } from '../../src/runtime/types.js';

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export {};',
  '*** Update File: src/old.ts',
  '*** Move to: src/moved.ts',
  '@@',
  '-a',
  '+b',
  '*** Delete File: /abs/gone.ts',
  '*** Update File: README.md',
  '@@',
  '-x',
  '+y',
  '*** End Patch',
].join('\n');

const payload = (tool_input: unknown): CodexPreToolPayload => ({
  session_id: 'thread-1', tool_name: 'apply_patch', tool_input, tool_use_id: 'call-1', cwd: '/w',
});
const known = (t: string) => (t === 'thread-1' ? { sessionId: 'sess-1', cwd: '/w' } : undefined);

// A header form the parser skips is a file written past the gate, so each one is pinned here.
describe('decideCodexPreTool', () => {
  it('gates every file the patch touches, the move destination included', async () => {
    const gate = vi.fn(async (_r: GateRequest): Promise<GateDecision> => ({ allow: true }));
    expect(await decideCodexPreTool(payload({ command: PATCH }), known, gate)).toEqual({ allow: true });
    expect(gate.mock.calls.map(([r]) => [r.tool, (r.input as { file_path: string }).file_path])).toEqual([
      ['file_write', '/w/src/new.ts'],
      ['file_edit', '/w/src/old.ts'],
      ['file_write', '/w/src/moved.ts'],
      ['file_edit', '/abs/gone.ts'],
      ['file_edit', '/w/README.md'],
    ]);
    expect(gate.mock.calls.every(([r]) => r.sessionId === 'sess-1' && r.toolUseId === 'call-1' && r.rawName === 'apply_patch')).toBe(true);
  });

  it('denies the whole patch on the first denied file', async () => {
    const gate = vi.fn(async (r: GateRequest): Promise<GateDecision> =>
      (r.input as { file_path: string }).file_path === '/w/src/moved.ts' ? { allow: false, reason: 'outside the worktree' } : { allow: true });
    expect(await decideCodexPreTool(payload({ command: PATCH }), known, gate)).toEqual({ allow: false, reason: 'outside the worktree' });
    expect(gate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['no headers', { command: '*** Begin Patch\n*** End Patch' }],
    ['no envelope', { command: '*** Add File: a.ts' }],
    ['no patch text', {}],
  ])('denies without asking the gate when the patch has %s', async (_name, input) => {
    const gate = vi.fn();
    expect((await decideCodexPreTool(payload(input), known, gate)).allow).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });

  // A workdir moves where a command's relative paths land without changing the text the gate judges.
  it('denies a shell call run from a directory other than the session one', async () => {
    const gate = vi.fn(async (): Promise<GateDecision> => ({ allow: true }));
    const shell = (cwd: string): CodexPreToolPayload => ({ ...payload({ command: 'rm -r build' }), tool_name: 'Bash', cwd });
    expect((await decideCodexPreTool(shell('/elsewhere'), known, gate)).allow).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    expect((await decideCodexPreTool(shell('/w'), known, gate)).allow).toBe(true);
  });

  it('denies a call from a thread Outpost did not start', async () => {
    const gate = vi.fn();
    expect((await decideCodexPreTool({ ...payload({ command: PATCH }), session_id: 'stranger' }, known, gate)).allow).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
});
