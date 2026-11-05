import { isAbsolute, join } from 'node:path';
import type { Backend } from './backend.js';
import { createMemoryStore, openMemory } from './adapters/memory.js';
import { openPg, openPglite } from './adapters/pg.js';
import { openSqlite } from './adapters/sqlite.js';

export type StoreUrl =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string; isPooler: boolean }
  | { kind: 'memory' }
  | { kind: 'pglite'; dataDir?: string };

// Parses OUTPOST_STORE; throws on a store the daemon must never run against.
export function parseStoreUrl(raw: string | undefined, runtimeDir: string): StoreUrl {
  if (!raw) return { kind: 'sqlite', path: join(runtimeDir, 'outpost.db') };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  switch (scheme) {
    case 'sqlite': {
      const path = raw.slice('sqlite:'.length);
      if (!isAbsolute(path)) throw new Error(`OUTPOST_STORE sqlite path must be absolute, got "${path}"`);
      return { kind: 'sqlite', path };
    }
    case 'postgres':
    case 'postgresql':
      return { kind: 'postgres', url: raw, isPooler: new URL(raw).hostname.includes('-pooler') };
    case 'memory':
      return { kind: 'memory' };
    case 'pglite': {
      const dir = raw.slice('pglite:'.length);
      return dir === 'memory' ? { kind: 'pglite' } : { kind: 'pglite', dataDir: dir };
    }
    case 'cockroachdb':
      throw new Error('OUTPOST_STORE cockroachdb:// is not enabled until its contract suite passes');
    default:
      throw new Error(`unsupported store "${scheme ?? '(unparseable)'}", see spec §2.6`);
  }
}

export async function openStore(url: StoreUrl, opts: { allowTestOnly: boolean }): Promise<Backend> {
  if ((url.kind === 'memory' || url.kind === 'pglite') && !opts.allowTestOnly) {
    throw new Error(`OUTPOST_STORE ${url.kind}: is a test-only store with no durability; the daemon refuses it`);
  }
  switch (url.kind) {
    case 'sqlite': return openSqlite(url.path);
    case 'postgres':
      if (url.isPooler) console.warn('[store] OUTPOST_STORE points at a -pooler host; use Neon\'s direct endpoint, the pooler breaks multi-statement transactions');
      return openPg(url.url);
    case 'memory': return openMemory(createMemoryStore());
    case 'pglite': return openPglite(url.dataDir);
  }
}
