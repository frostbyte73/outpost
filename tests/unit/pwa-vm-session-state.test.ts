import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessionState } from '../../src/pwa/vm/session-state.js';

const base = { hasApproval: false, working: false, lastReplyAt: null, seenAt: 1000 };

describe('sessionState', () => {
  it('approval beats unread', () => {
    expect(sessionState({ ...base, hasApproval: true, lastReplyAt: 2000 })).toBe('approval');
  });
  it('unread beats thinking', () => {
    expect(sessionState({ ...base, working: true, lastReplyAt: 2000 })).toBe('unread');
  });
  it('thinking when working and read', () => {
    expect(sessionState({ ...base, working: true, lastReplyAt: 500 })).toBe('thinking');
  });
  it('idle otherwise', () => {
    expect(sessionState(base)).toBe('idle');
    expect(sessionState({ ...base, lastReplyAt: 1000 })).toBe('idle');
  });
  it('never unread when unread is not tracked', () => {
    expect(sessionState({ ...base, lastReplyAt: 2000, unreadTracked: false })).toBe('idle');
  });
});
