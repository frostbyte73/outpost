import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 256 * 1024;

// Content-addressed text for replay snapshots; a JSONL row is the wrong home for a 200KB response.
export class BlobStore {
  constructor(private readonly dir: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  put(text: string): string | undefined {
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) return undefined;
    const ref = createHash('sha256').update(text).digest('hex');
    if (this.get(ref) === text) return ref;
    const tmp = join(this.dir, `.${ref}.${process.pid}.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, join(this.dir, ref));
    return ref;
  }

  get(ref: string): string | undefined {
    if (!/^[0-9a-f]{64}$/.test(ref)) return undefined;
    try { return readFileSync(join(this.dir, ref), 'utf8'); } catch { return undefined; }
  }

  prune(keep: ReadonlySet<string>): number {
    let n = 0;
    for (const name of readdirSync(this.dir)) {
      if (keep.has(name)) continue;
      rmSync(join(this.dir, name), { force: true });
      n += 1;
    }
    return n;
  }
}
