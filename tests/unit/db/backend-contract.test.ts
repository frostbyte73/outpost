import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterOptions, Backend, CommitBatch, CommitPoint, DumpRecord } from '../../../src/db/backend.js';
import { LeaseHeld } from '../../../src/db/backend.js';
import { createMemoryStore, openMemory } from '../../../src/db/adapters/memory.js';
import { openPg, openPglite } from '../../../src/db/adapters/pg.js';
import { openSqlite } from '../../../src/db/adapters/sqlite.js';

interface Harness {
  name: string;
  // A fresh, migrated store; `second` opens another handle on the store the last `open` made.
  open(opts?: AdapterOptions): Promise<Backend>;
  second?(): Promise<Backend>;
  isConcurrent: boolean;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}

const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin';
const hasPg = existsSync(join(PG_BIN, 'initdb'));
const tmpDirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'outpost-db-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

async function migrated(b: Backend): Promise<Backend> {
  await b.migrate();
  return b;
}

function memoryHarness(): Harness {
  let store = createMemoryStore();
  return {
    name: 'memory', isConcurrent: false,
    open: async (opts) => { store = createMemoryStore(); return openMemory(store, opts); },
    second: async () => openMemory(store),
  };
}

function sqliteMemoryHarness(): Harness {
  return { name: 'sqlite :memory:', isConcurrent: false, open: async (opts) => migrated(await openSqlite(':memory:', opts)) };
}

function sqliteFileHarness(): Harness {
  let file = '';
  return {
    // Two DatabaseSync handles in one thread deadlock: the waiter blocks the event loop in busy_timeout.
    name: 'sqlite file', isConcurrent: false,
    open: async (opts) => { file = join(tmp(), 'store.db'); return migrated(await openSqlite(file, opts)); },
    second: async () => openSqlite(file),
  };
}

function pgliteHarness(): Harness {
  return { name: 'pglite', isConcurrent: false, open: async (opts) => migrated(await openPglite(undefined, opts)) };
}

function postgresHarness(): Harness {
  let dir = '';
  let port = 0;
  let n = 0;
  let url = '';
  let isStarted = false;
  // Without a valid LC_ALL the postmaster aborts on macOS ("became multithreaded during startup").
  const pg = (bin: string, args: string[]) =>
    execFileSync(join(PG_BIN, bin), args, { stdio: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
  return {
    name: 'postgres 17', isConcurrent: true,
    async setup() {
      dir = tmp();
      port = await new Promise<number>((resolve) => {
        const srv = createServer().listen(0, () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
      });
      pg('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'outpost']);
      try {
        pg('pg_ctl', ['-D', join(dir, 'data'), '-l', join(dir, 'log'), '-w', '-o',
          `-k ${dir} -c listen_addresses='' -p ${port} -c fsync=off`, 'start']);
      } catch (err) {
        throw new Error(`postgres failed to start: ${readFileSync(join(dir, 'log'), 'utf8')}`, { cause: err });
      }
      isStarted = true;
    },
    async teardown() { if (isStarted) pg('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); },
    async open(opts) {
      const db = `d${++n}`;
      pg('createdb', ['-h', dir, '-p', String(port), '-U', 'outpost', db]);
      url = `postgresql://outpost@localhost/${db}?host=${encodeURIComponent(dir)}&port=${port}`;
      return migrated(await openPg(url, opts));
    },
    second: async () => openPg(url),
  };
}

const harnesses: Harness[] = [memoryHarness(), sqliteMemoryHarness(), sqliteFileHarness(), pgliteHarness()];
if (hasPg) harnesses.push(postgresHarness());
else console.warn(`[backend-contract] ${PG_BIN}/initdb not found; skipping the real-Postgres harness`);

const A = { holderId: 'A', holderAddr: 'a' };
const B = { holderId: 'B', holderAddr: 'b' };

function batch(i: number, over: Partial<CommitBatch> = {}): CommitBatch {
  return {
    epoch: 1,
    receipt: { commandId: `c${i}`, kind: 'test', issuerKind: 'system', issuerId: 'test', receivedAt: 1000 + i, status: 'ok', result: { i } },
    puts: [{ collection: 'jobs', key: `j${i}`, doc: { i, nested: { ok: true } } }],
    deletes: [],
    events: [{ aggregate: 'job', aggregateId: `j${i}`, jobId: `j${i % 3}`, kind: 'created', who: 'test', body: { i }, at: 2000 + i }],
    changes: [{ topic: 'jobs', op: 'upsert', key: `j${i}`, doc: { i }, at: 3000 + i }],
    ...over,
  };
}

async function drain(it: AsyncIterable<DumpRecord>): Promise<DumpRecord[]> {
  const out: DumpRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

async function state(b: Backend) {
  const records = await drain(b.dump());
  return records.map((r) => r.t === 'head' && r.lease ? { ...r, lease: { ...r.lease, acquiredAt: 0 } } : r);
}

describe.each(harnesses)('Backend contract: $name', (h) => {
  beforeAll(async () => { await h.setup?.(); }, 60_000);
  afterAll(async () => { await h.teardown?.(); });

  async function fresh(opts?: AdapterOptions): Promise<Backend> {
    const b = await h.open(opts);
    await b.acquireLease(A, { force: false });
    return b;
  }

  it('keeps the epoch for the same holder and refuses another without force', async () => {
    const b = await fresh();
    expect((await b.acquireLease(A, { force: false })).epoch).toBe(1);
    const other = await h.second?.() ?? b;
    await expect(other.acquireLease(B, { force: false })).rejects.toBeInstanceOf(LeaseHeld);
    expect((await other.acquireLease(B, { force: true })).epoch).toBe(2);
    if (other !== b) await other.close();
    await b.close();
  });

  it('fences a commit after another holder forces the lease', async () => {
    const b = await fresh();
    expect((await b.commit(batch(1))).status).toBe('committed');
    const other = await h.second?.() ?? b;
    await other.acquireLease(B, { force: true });
    const before = await state(b);
    const res = await b.commit(batch(2));
    expect(res).toMatchObject({ status: 'fenced', current: { holderId: 'B', epoch: 2 } });
    expect(await state(b)).toEqual(before);
    if (other !== b) await other.close();
    await b.close();
  });

  it.runIf(h.isConcurrent)('fences every commit issued after a racing forced acquire', async () => {
    const a = await fresh();
    const other = (await h.second!())!;
    // The writer commits one at a time (its single command queue); the forced acquire races it from outside.
    const settled: Array<{ i: number; issuedAfter: boolean; status: string }> = [];
    let acquired = false;
    let acquire: Promise<unknown> | undefined;
    let tail = 0;
    for (let i = 1; tail < 5; i++) {
      if (i === 10) acquire = other.acquireLease(B, { force: true }).then(() => { acquired = true; });
      const issuedAfter = acquired;
      if (issuedAfter) tail++;
      settled.push({ i, issuedAfter, status: (await a.commit(batch(i))).status });
    }
    await acquire;
    expect(settled.some((r) => !r.issuedAfter && r.status === 'committed')).toBe(true);
    for (const r of settled) {
      if (r.issuedAfter) expect(r.status).toBe('fenced');
      const receipt = await a.receipt(`c${r.i}`);
      expect(receipt !== undefined).toBe(r.status === 'committed');
    }
    expect(settled.some((r) => r.status === 'fenced')).toBe(true);
    await other.close();
    await a.close();
  });

  it('returns the stored receipt for a duplicate commandId and writes nothing', async () => {
    const b = await fresh();
    await b.commit(batch(1));
    const before = await state(b);
    const res = await b.commit(batch(1, { puts: [{ collection: 'jobs', key: 'other', doc: 1 }] }));
    expect(res).toEqual({ status: 'duplicate', receipt: expect.objectContaining({ commandId: 'c1', epoch: 1, firstSeq: 1, result: { i: 1 } }) });
    expect(await state(b)).toEqual(before);
    await b.close();
  });

  it('keeps both seq counters gapless and in commit order', async () => {
    const b = await fresh();
    for (let i = 0; i < 1000; i++) {
      const events = Array.from({ length: i % 3 }, (_, k) => ({ ...batch(i).events[0]!, aggregateId: `e${k}` }));
      const changes = Array.from({ length: i % 2 }, () => batch(i).changes[0]!);
      await b.commit(batch(i, { events, changes }));
    }
    const records = await drain(b.dump());
    const events = records.flatMap((r) => r.t === 'event' ? [r.event.seq] : []);
    const changes = records.flatMap((r) => r.t === 'change' ? [r.change.seq] : []);
    expect(events).toEqual(Array.from({ length: events.length }, (_, k) => k + 1));
    expect(changes).toEqual(Array.from({ length: changes.length }, (_, k) => k + 1));
    const snap = await b.loadAll();
    expect([snap.eventsHead, snap.changesHead]).toEqual([events.length, changes.length]);
    await b.close();
  }, 120_000);

  it.each<CommitPoint>(['after-fence', 'after-receipt', 'after-seq', 'after-rows', 'after-events'])(
    'writes nothing when a commit throws %s', async (point) => {
      let armed = false;
      const b = await fresh({ faults: (p) => { if (armed && p === point) throw new Error(`injected ${p}`); } });
      await b.commit(batch(1));
      const before = await state(b);
      armed = true;
      await expect(b.commit(batch(2))).rejects.toThrow(`injected ${point}`);
      expect(await state(b)).toEqual(before);
      armed = false;
      expect(await b.commit(batch(2))).toEqual({ status: 'committed', firstEventSeq: 2, firstChangeSeq: 2 });
      await b.close();
    });

  it('keeps the last of two puts to one key in a single batch', async () => {
    const b = await fresh();
    const res = await b.commit(batch(1, { puts: [
      { collection: 'jobs', key: 'k', doc: { v: 1 } },
      { collection: 'jobs', key: 'k', doc: { v: 2 } },
    ] }));
    expect(res.status).toBe('committed');
    expect((await b.loadAll()).rows).toEqual([{ collection: 'jobs', key: 'k', doc: { v: 2 } }]);
    await b.close();
  });

  it('scans a job\'s events newest-first, paging by beforeSeq', async () => {
    const b = await fresh();
    for (let i = 0; i < 9; i++) await b.commit(batch(i));
    const page1 = await b.scanEvents({ jobId: 'j0', limit: 2 });
    expect(page1.map((e) => e.seq)).toEqual([7, 4]);
    expect(page1[0]).toMatchObject({ jobId: 'j0', aggregateId: 'j6', commandId: 'c6', body: { i: 6 } });
    const page2 = await b.scanEvents({ jobId: 'j0', beforeSeq: 4, limit: 2 });
    expect(page2.map((e) => e.seq)).toEqual([1]);
    await b.close();
  });

  it('prunes exactly the requested ranges and advances the low-water mark', async () => {
    const b = await fresh();
    for (let i = 0; i < 6; i++) {
      await b.commit(batch(i, { sessionOutput: [{ sessionId: 's', seq: i, item: { i }, at: i }] }));
    }
    await b.commit(batch(6, {
      events: [], changes: [],
      prune: [
        { table: 'changes', belowSeq: 4 },
        { table: 'session_output', sessionId: 's', belowSeq: 3 },
        { table: 'events', jobId: 'j1' },
        { table: 'commands', receivedBefore: 1002 },
      ],
    }));
    expect((await b.loadAll()).changesLowWater).toBe(4);
    expect((await b.scanChanges({ fromSeq: 0, limit: 100 })).map((c) => c.seq)).toEqual([4, 5, 6]);
    expect((await b.scanSessionOutput({ sessionId: 's', fromSeq: 0, limit: 100 })).map((o) => o.seq)).toEqual([3, 4, 5]);
    expect(await b.scanEvents({ jobId: 'j1', limit: 100 })).toEqual([]);
    expect((await b.scanEvents({ jobId: 'j0', limit: 100 })).length).toBe(2);
    expect(await b.receipt('c1')).toBeUndefined();
    expect(await b.receipt('c2')).toBeDefined();
    await b.close();
  });

  it('round-trips dump into restore and refuses a non-empty target', async () => {
    const b = await fresh();
    for (let i = 0; i < 5; i++) {
      await b.commit(batch(i, {
        deletes: i === 4 ? [{ collection: 'jobs', key: 'j0' }] : [],
        sessionOutput: [{ sessionId: `s${i % 2}`, seq: i, item: [i, 'x'], at: i }],
      }));
    }
    const target = await h.open();
    await target.restore(b.dump());
    expect(await drain(target.dump())).toEqual(await drain(b.dump()));
    expect(await target.loadAll()).toEqual(await b.loadAll());
    expect(await target.receipt('c3')).toEqual(await b.receipt('c3'));
    await expect(target.restore(b.dump())).rejects.toThrow(/not empty/);
    await target.close();
    await b.close();
  });
});
