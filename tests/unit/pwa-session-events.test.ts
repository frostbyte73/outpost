import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { itemToEntries } from '../../src/pwa/vm/session-events.js';

describe('itemToEntries tool results', () => {
  it('does not surface the shell allowlist notice as a result row', () => {
    const entries = itemToEntries({
      type: 'tool_call', id: 't1', rawName: 'Bash', tool: 'shell', input: { command: 'ls' },
      resultText: 'Shell allowlist is empty',
    });
    expect(entries.map((m: { role: string }) => m.role)).toEqual(['tool_use']);
  });

  it('keeps a real result next to its call', () => {
    const entries = itemToEntries({
      type: 'tool_call', id: 't1', rawName: 'Bash', tool: 'shell', input: { command: 'ls' },
      resultText: 'Shell allowlist is empty\nsrc',
    });
    expect(entries.map((m: { role: string }) => m.role)).toEqual(['tool_use', 'tool_result']);
    expect(entries[1].text).toBe('src');
  });
});
