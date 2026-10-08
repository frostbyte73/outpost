import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from '../../src/storage/blob-store.js';

describe('BlobStore', () => {
  it('dedupes by content, refuses oversize, and prunes what nothing references', () => {
    const s = new BlobStore(mkdtempSync(join(tmpdir(), 'blobs-')), 10);
    const a = s.put('hello')!;
    expect(s.put('hello')).toBe(a);
    expect(s.get(a)).toBe('hello');
    expect(s.put('x'.repeat(11))).toBeUndefined();
    const b = s.put('world')!;
    expect(s.prune(new Set([a]))).toBe(1);
    expect(s.get(b)).toBeUndefined();
    expect(s.get(a)).toBe('hello');
  });
});

describe('BlobStore durability', () => {
  it('repairs a blob a crash left truncated, and leaves no temp files behind', async () => {
    const { writeFileSync, readdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'blobs-'));
    const s = new BlobStore(dir);
    const ref = s.put('full content')!;
    writeFileSync(join(dir, ref), 'full con');
    expect(s.put('full content')).toBe(ref);
    expect(s.get(ref)).toBe('full content');
    expect(readdirSync(dir)).toEqual([ref]);
  });
});
