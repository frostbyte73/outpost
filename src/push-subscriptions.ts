import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  // Diagnostic only — not used for delivery.
  userAgent?: string;
  createdAt: number;
  lastSeenAt: number;
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class SubscriptionStore {
  private subs = new Map<string, PushSubscriptionRecord>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { records?: PushSubscriptionRecord[] };
      for (const r of parsed.records ?? []) {
        if (typeof r.endpoint === 'string' && r.keys?.p256dh && r.keys?.auth) {
          this.subs.set(r.endpoint, r);
        }
      }
    } catch {
      // Malformed — start empty; next persist overwrites cleanly.
    }
  }

  add(rec: PushSubscriptionRecord): void {
    this.subs.set(rec.endpoint, rec);
    this.persist();
  }

  remove(endpoint: string): void {
    if (!this.subs.delete(endpoint)) return;
    this.persist();
  }

  list(): PushSubscriptionRecord[] {
    return [...this.subs.values()];
  }

  markSeen(endpoint: string, at: number): void {
    const rec = this.subs.get(endpoint);
    if (!rec) return;
    rec.lastSeenAt = at;
    this.persist();
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify({ records: this.list() }, null, 2) + '\n');
  }
}
