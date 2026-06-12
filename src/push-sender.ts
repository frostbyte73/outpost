import type { Agent as HttpsAgent } from 'node:https';
import webpush from 'web-push';
import type { SubscriptionStore, PushSubscriptionRecord } from './push-subscriptions.js';
import type { VapidKeys } from './push-keys.js';

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface PushSenderOpts {
  store: SubscriptionStore;
  vapid: VapidKeys;
  ttlSeconds: number;
  now?: () => number;
  // Optional: custom HTTPS agent forwarded to web-push (e.g. to pin a CA in tests).
  // Production leaves this unset so Node's default trust store applies.
  agent?: HttpsAgent;
}

const DEAD_STATUS = new Set([404, 410]);

export class PushSender {
  private readonly now: () => number;

  constructor(private readonly opts: PushSenderOpts) {
    this.now = opts.now ?? (() => Date.now());
    webpush.setVapidDetails(opts.vapid.subject, opts.vapid.publicKey, opts.vapid.privateKey);
  }

  async send(payload: PushPayload): Promise<void> {
    const subs = this.opts.store.list();
    await Promise.all(subs.map((sub) => this.sendOne(sub, payload)));
  }

  private async sendOne(sub: PushSubscriptionRecord, payload: PushPayload): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: this.opts.ttlSeconds, ...(this.opts.agent ? { agent: this.opts.agent } : {}) },
      );
      this.opts.store.markSeen(sub.endpoint, this.now());
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status !== undefined && DEAD_STATUS.has(status)) {
        this.opts.store.remove(sub.endpoint);
        console.log(`[push] pruned dead subscription (${status}): ${sub.endpoint}`);
        return;
      }
      console.error(`[push] send failed (status=${status ?? '?'}): ${sub.endpoint}`, (e as Error).message);
    }
  }
}
