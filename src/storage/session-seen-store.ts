import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface SeenBlob {
  initializedAt: number;
  seen: Record<string, number>;
}

// A session never marked seen counts as seen when this store was created, so upgrading lights nothing up as unread.
export class SessionSeenStore {
  private blob: SeenBlob;

  constructor(private path: string, private now: () => number = Date.now) {
    this.blob = this.load() ?? { initializedAt: now(), seen: {} };
    if (!existsSync(path)) this.persist();
  }

  seenAt(sessionId: string): number {
    return this.blob.seen[sessionId] ?? this.blob.initializedAt;
  }

  markSeen(sessionId: string): number {
    const at = this.now();
    this.blob.seen[sessionId] = at;
    this.persist();
    return at;
  }

  forget(sessionId: string): void {
    if (!(sessionId in this.blob.seen)) return;
    delete this.blob.seen[sessionId];
    this.persist();
  }

  retain(sessionIds: Set<string>): void {
    const kept = Object.entries(this.blob.seen).filter(([id]) => sessionIds.has(id));
    if (kept.length === Object.keys(this.blob.seen).length) return;
    this.blob.seen = Object.fromEntries(kept);
    this.persist();
  }

  private load(): SeenBlob | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SeenBlob>;
      if (typeof parsed.initializedAt !== 'number') return null;
      const seen = parsed.seen && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen) ? parsed.seen : {};
      return { initializedAt: parsed.initializedAt, seen };
    } catch {
      return null;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.blob) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
