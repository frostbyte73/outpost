import { describe, it, expect } from 'vitest';
import { CallTracker } from '../../src/runtime/codex/call-tracker.js';
import type { CodexItem } from '../../src/runtime/codex/items.js';

const cmd = (id: string, over: Partial<Extract<CodexItem, { type: 'commandExecution' }>> = {}): CodexItem => ({
  type: 'commandExecution', id, command: 'git push origin HEAD:main (presented)', status: 'completed', source: 'agent', exitCode: 0, ...over,
});

// A release against the wrong input or a spent-but-landed write frees a pin the user approved once;
// a missed ungated call is a write that never met the gate.
describe('CallTracker', () => {
  const gatedInput = { command: 'git push origin HEAD:main' };

  it('releases a failed or non-zero-exit call with the input the gate saw, not the item text', () => {
    const t = new CallTracker();
    t.noteGated('c1', 'shell', gatedInput);
    t.noteGated('c2', 'shell', gatedInput);
    expect(t.releaseFor(cmd('c1', { status: 'failed', exitCode: null }), 'turn-1'))
      .toEqual({ toolUseId: 'c1', tool: 'shell', input: gatedInput, interrupted: false });
    expect(t.releaseFor(cmd('c2', { exitCode: 1 }), 'turn-1')).toMatchObject({ toolUseId: 'c2', input: gatedInput });
  });

  it('keeps the pin spent for a call that succeeded or was never gated', () => {
    const t = new CallTracker();
    t.noteGated('c1', 'shell', gatedInput);
    expect(t.releaseFor(cmd('c1'), 'turn-1')).toBeUndefined();
    expect(t.releaseFor(cmd('never', { status: 'failed' }), 'turn-1')).toBeUndefined();
  });

  it('marks a release interrupted once the turn was asked to stop', () => {
    const t = new CallTracker();
    t.noteGated('c1', 'shell', gatedInput);
    t.noteInterruptRequested('turn-1');
    expect(t.releaseFor(cmd('c1', { status: 'failed' }), 'turn-1')?.interrupted).toBe(true);
  });

  it('flags a tool item the gate never saw, and a web search at all', () => {
    const t = new CallTracker();
    t.noteGated('c1', 'shell', gatedInput);
    expect(t.ungatedCall(cmd('c1'))).toBeUndefined();
    expect(t.ungatedCall(cmd('c9'))).toBe('commandExecution c9');
    expect(t.ungatedCall({ type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', arguments: {}, status: 'inProgress' })).toBe('mcpToolCall m1');
    expect(t.ungatedCall({ type: 'webSearch', id: 'w1' })).toBe('webSearch w1');
  });

  it('lets Codex report a call it blocked, but flags a denied call it starts anyway', () => {
    const t = new CallTracker();
    t.noteDenied('d1');
    expect(t.ungatedCall(cmd('d1', { status: 'declined' }))).toBeUndefined();
    expect(t.ungatedCall(cmd('d1', { status: 'inProgress' }))).toBe('commandExecution d1');
    expect(t.ungatedCall(cmd('d1', { status: 'completed' }))).toBe('commandExecution d1');
    expect(t.releaseFor(cmd('d1', { status: 'declined' }), 'turn-1')).toBeUndefined();
  });

  it('does not flag write_stdin polls or the user\'s own shell commands', () => {
    const t = new CallTracker();
    expect(t.ungatedCall(cmd('p1', { source: 'unifiedExecInteraction' }))).toBeUndefined();
    expect(t.ungatedCall(cmd('u1', { source: 'userShell' }))).toBeUndefined();
    expect(t.ungatedCall({ type: 'agentMessage', id: 'a1', text: 'hi' })).toBeUndefined();
  });
});
