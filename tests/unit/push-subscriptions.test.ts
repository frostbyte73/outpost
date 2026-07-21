import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore, type PushSubscriptionRecord } from '../../src/push-subscriptions.js';

function newPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pushsubs-')), 'subs.json');
}

function rec(endpoint: string, overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    endpoint,
    keys: { p256dh: 'p256dh-' + endpoint, auth: 'auth-' + endpoint },
    userAgent: 'iPhone Safari',
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('SubscriptionStore', () => {
  it('starts empty when the file does not exist', () => {
    const s = new SubscriptionStore(newPath());
    expect(s.list()).toEqual([]);
  });

  it('add() persists and round-trips across instances', () => {
    const path = newPath();
    const s1 = new SubscriptionStore(path);
    s1.add(rec('https://fcm.googleapis.com/abc'));
    expect(existsSync(path)).toBe(true);
    const s2 = new SubscriptionStore(path);
    expect(s2.list()).toHaveLength(1);
    expect(s2.list()[0]!.endpoint).toBe('https://fcm.googleapis.com/abc');
  });

  it('persists with 0600 permissions', () => {
    const path = newPath();
    const s = new SubscriptionStore(path);
    s.add(rec('https://example.org/x'));
    const st = statSync(path);
    expect((st.mode & 0o777).toString(8)).toBe('600');
  });

  it('add() with an endpoint already present updates the record (idempotent re-subscribe)', () => {
    const path = newPath();
    const s = new SubscriptionStore(path);
    s.add(rec('https://x.example/a', { userAgent: 'old' }));
    s.add(rec('https://x.example/a', { userAgent: 'new', createdAt: 1_700_000_000_001 }));
    const list = s.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.userAgent).toBe('new');
  });

  it('remove() drops the record and persists', () => {
    const path = newPath();
    const s = new SubscriptionStore(path);
    s.add(rec('https://x.example/a'));
    s.add(rec('https://x.example/b'));
    s.remove('https://x.example/a');
    expect(s.list().map((r) => r.endpoint)).toEqual(['https://x.example/b']);
    const reload = new SubscriptionStore(path);
    expect(reload.list()).toHaveLength(1);
  });

  it('remove() of an unknown endpoint is a no-op', () => {
    const s = new SubscriptionStore(newPath());
    expect(() => s.remove('https://nope')).not.toThrow();
    expect(s.list()).toHaveLength(0);
  });

  it('markSeen() updates lastSeenAt and persists', () => {
    const path = newPath();
    const s = new SubscriptionStore(path);
    s.add(rec('https://x.example/a', { lastSeenAt: 1 }));
    s.markSeen('https://x.example/a', 999);
    expect(s.list()[0]!.lastSeenAt).toBe(999);
    const reload = new SubscriptionStore(path);
    expect(reload.list()[0]!.lastSeenAt).toBe(999);
  });

  it('tolerates a malformed file by starting empty + overwriting on next add', () => {
    const path = newPath();
    writeFileSync(path, '{{not json', { mode: 0o600 });
    const s = new SubscriptionStore(path);
    expect(s.list()).toEqual([]);
    s.add(rec('https://x.example/a'));
    expect(JSON.parse(readFileSync(path, 'utf8')).records).toHaveLength(1);
  });
});
