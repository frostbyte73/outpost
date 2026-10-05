// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { parseRepo } from '../../src/pwa/components/settings-surface/pr-reviews.js';

describe('parseRepo', () => {
  it('accepts owner/repo and a pasted GitHub URL, lowercased', () => {
    expect(parseRepo('Frostbyte73/Outpost')).toBe('frostbyte73/outpost');
    expect(parseRepo(' https://github.com/livekit/protocol.git/ ')).toBe('livekit/protocol');
  });

  it('rejects anything that is not one owner/repo', () => {
    expect(parseRepo('outpost')).toBeNull();
    expect(parseRepo('a/b/c')).toBeNull();
    expect(parseRepo('')).toBeNull();
  });
});
