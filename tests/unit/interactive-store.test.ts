import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveStore } from '../../src/session/interactive-store.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'interactive-')), 'interactive-sessions.json');
}

describe('InteractiveStore', () => {
  it('reports false for an unknown session and for undefined', () => {
    const s = new InteractiveStore();
    expect(s.isInteractive('nope')).toBe(false);
    expect(s.isInteractive(undefined)).toBe(false);
  });

  it('survives a restart — the whole reason it is on disk', () => {
    const path = tmpPath();
    new InteractiveStore(path).set('s1', true);
    expect(new InteractiveStore(path).isInteractive('s1')).toBe(true);
  });

  it('clearing a session persists the clear', () => {
    const path = tmpPath();
    const a = new InteractiveStore(path);
    a.set('s1', true);
    a.set('s1', false);
    expect(new InteractiveStore(path).isInteractive('s1')).toBe(false);
  });

  it('starts empty on a malformed file rather than throwing at boot', () => {
    const path = tmpPath();
    writeFileSync(path, '{ not json');
    expect(new InteractiveStore(path).isInteractive('s1')).toBe(false);
  });
});
