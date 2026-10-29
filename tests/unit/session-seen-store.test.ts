import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSeenStore } from '../../src/storage/session-seen-store.js';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'seen-store-')), 'session-seen.json');

describe('SessionSeenStore', () => {
  it('treats every session as seen at first initialization', () => {
    const s = new SessionSeenStore(freshPath(), () => 1000);
    expect(s.seenAt('old')).toBe(1000);
  });

  it('keeps initializedAt across reloads, so sessions created later start unseen', () => {
    const path = freshPath();
    new SessionSeenStore(path, () => 1000);
    expect(new SessionSeenStore(path, () => 5000).seenAt('new')).toBe(1000);
  });

  it('persists markSeen', () => {
    const path = freshPath();
    let now = 1000;
    const s = new SessionSeenStore(path, () => now);
    now = 3000;
    expect(s.markSeen('a')).toBe(3000);
    expect(new SessionSeenStore(path, () => 9000).seenAt('a')).toBe(3000);
  });

  it('forget drops one session', () => {
    const path = freshPath();
    let now = 1000;
    const s = new SessionSeenStore(path, () => now);
    now = 3000;
    s.markSeen('a');
    s.forget('a');
    expect(new SessionSeenStore(path).seenAt('a')).toBe(1000);
  });

  it('retain keeps only the sessions still on disk', () => {
    const path = freshPath();
    let now = 1000;
    const s = new SessionSeenStore(path, () => now);
    now = 3000;
    s.markSeen('keep');
    s.markSeen('gone');
    s.retain(new Set(['keep']));
    const reloaded = new SessionSeenStore(path);
    expect(reloaded.seenAt('keep')).toBe(3000);
    expect(reloaded.seenAt('gone')).toBe(1000);
  });
});
