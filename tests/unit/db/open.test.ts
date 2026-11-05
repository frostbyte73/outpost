import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bootStore } from '../../../src/db/lease.js';
import { openStore, parseStoreUrl } from '../../../src/db/open.js';

const dir = mkdtempSync(join(tmpdir(), 'outpost-open-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('OUTPOST_STORE', () => {
  it('defaults to sqlite in the runtime dir', () => {
    expect(parseStoreUrl(undefined, '/rt')).toEqual({ kind: 'sqlite', path: '/rt/outpost.db' });
  });

  it('refuses the test-only stores for the daemon', async () => {
    await expect(openStore(parseStoreUrl('memory:', dir), { allowTestOnly: false })).rejects.toThrow(/test-only/);
    await expect(openStore(parseStoreUrl('pglite:memory', dir), { allowTestOnly: false })).rejects.toThrow(/test-only/);
  });

  it('refuses unsupported and not-yet-enabled stores without echoing credentials', () => {
    for (const raw of ['cockroachdb://u:s3cret@h/db', 'redis://u:s3cret@h', '//u:s3cret@h/db', 'file:///x', 'sqlite:relative.db']) {
      expect(() => parseStoreUrl(raw, dir)).toThrow();
      try { parseStoreUrl(raw, dir); } catch (err) { expect((err as Error).message).not.toContain('s3cret'); }
    }
  });

  it('reboots on the same runtime dir as the same holder at the same epoch', async () => {
    const first = await bootStore(dir, {});
    await first.backend.close();
    const second = await bootStore(dir, {});
    expect(second.lease).toMatchObject({ holderId: first.lease.holderId, epoch: first.lease.epoch });
    await second.backend.close();
  });
});
