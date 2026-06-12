import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore, type PushSubscriptionRecord } from '../../src/push-subscriptions.js';

const { sendNotification, setVapidDetails } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));
vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails, generateVAPIDKeys: () => ({ publicKey: 'pk', privateKey: 'sk' }) },
}));

import { PushSender } from '../../src/push-sender.js';

function rec(endpoint: string): PushSubscriptionRecord {
  return {
    endpoint,
    keys: { p256dh: 'p256dh', auth: 'auth' },
    createdAt: 0,
    lastSeenAt: 0,
  };
}

function newStore(): SubscriptionStore {
  return new SubscriptionStore(join(mkdtempSync(join(tmpdir(), 'pushsend-')), 'subs.json'));
}

describe('PushSender', () => {
  beforeEach(() => {
    sendNotification.mockReset();
    setVapidDetails.mockReset();
  });

  it('setVapidDetails is called once at construction', () => {
    const store = newStore();
    new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
    });
    expect(setVapidDetails).toHaveBeenCalledWith('mailto:o@l', 'pk', 'sk');
  });

  it('send() fans out to every stored subscription', async () => {
    const store = newStore();
    store.add(rec('https://a/'));
    store.add(rec('https://b/'));
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const sender = new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
    });
    await sender.send({ title: 't', body: 'b', data: { x: 1 } });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [sub0, payload0, opts0] = sendNotification.mock.calls[0]!;
    expect((sub0 as { endpoint: string }).endpoint).toBe('https://a/');
    expect(JSON.parse(payload0 as string)).toEqual({ title: 't', body: 'b', data: { x: 1 } });
    expect(opts0).toEqual({ TTL: 60 });
  });

  it('prunes endpoints that return 410 Gone', async () => {
    const store = newStore();
    store.add(rec('https://gone/'));
    store.add(rec('https://alive/'));
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === 'https://gone/') {
        const err: Error & { statusCode?: number } = new Error('gone');
        err.statusCode = 410;
        throw err;
      }
      return { statusCode: 201 };
    });
    const sender = new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
    });
    await sender.send({ title: 't', body: 'b' });
    expect(store.list().map((r) => r.endpoint)).toEqual(['https://alive/']);
  });

  it('also prunes endpoints that return 404 Not Found', async () => {
    const store = newStore();
    store.add(rec('https://notfound/'));
    sendNotification.mockImplementation(async () => {
      const err: Error & { statusCode?: number } = new Error('not found');
      err.statusCode = 404;
      throw err;
    });
    const sender = new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
    });
    await sender.send({ title: 't', body: 'b' });
    expect(store.list()).toHaveLength(0);
  });

  it('non-410/404 errors are swallowed (not thrown), endpoint kept', async () => {
    const store = newStore();
    store.add(rec('https://transient/'));
    sendNotification.mockImplementation(async () => {
      const err: Error & { statusCode?: number } = new Error('timeout');
      err.statusCode = 408;
      throw err;
    });
    const sender = new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
    });
    await expect(sender.send({ title: 't', body: 'b' })).resolves.toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it('send() resolves even when the store is empty', async () => {
    const store = newStore();
    const sender = new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
    });
    await expect(sender.send({ title: 't', body: 'b' })).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('markSeen() touches lastSeenAt on successful send', async () => {
    const store = newStore();
    store.add(rec('https://ok/'));
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const sender = new PushSender({
      store,
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:o@l' },
      ttlSeconds: 60,
      now: () => 12345,
    });
    await sender.send({ title: 't', body: 'b' });
    expect(store.list()[0]!.lastSeenAt).toBe(12345);
  });
});
