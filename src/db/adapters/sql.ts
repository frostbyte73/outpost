import type {
  AdapterOptions, Backend, ChangeRow, CommitBatch, CommitResult, DumpRecord, EventRow, Lease, Receipt, Row, Snapshot,
} from '../backend.js';
import { LeaseHeld } from '../backend.js';
import { runMigrations, type MigrationDialect } from '../migrate.js';

export interface SqlTx {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
}

export interface SqlConn extends SqlTx {
  withTx<T>(begin: string, fn: (tx: SqlTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type ColType = 'text' | 'bigint' | 'json';

export interface SqlDialect extends MigrationDialect {
  kind: 'sqlite' | 'postgres';
  beginCommit: string;
  beginRead: string;
  fenceSql: string;
  leaseLockSql: string;
  // Postgres drivers serialize a JS string bound to a jsonb parameter differently; binding as text sidesteps that.
  jsonCast: '' | '::text::jsonb';
  parseJson(v: unknown): unknown;
  insertMany(tx: SqlTx, table: string, cols: Array<[string, ColType]>, rows: unknown[][], onConflict?: string): Promise<void>;
}

// Shared by sqlite and PGlite, whose single connection would otherwise interleave transactions at await points.
export function serialize(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function sqlBackend(conn: SqlConn, d: SqlDialect, opts: AdapterOptions = {}): Backend {
  const faults = opts.faults ?? (() => {});
  let held: Lease | undefined;

  const json = (v: unknown): string | null => v === undefined ? null : JSON.stringify(v);
  const num = (v: unknown): number => Number(v);

  const toLease = (r: Record<string, unknown> | undefined): Lease | undefined => r && {
    holderId: String(r.holder_id), holderAddr: String(r.holder_addr), epoch: num(r.epoch), acquiredAt: num(r.acquired_at),
  };
  const toEvent = (r: Record<string, unknown>): EventRow => ({
    seq: num(r.seq), aggregate: String(r.aggregate), aggregateId: String(r.aggregate_id),
    ...(r.job_id != null ? { jobId: String(r.job_id) } : {}),
    kind: String(r.kind), who: String(r.who), body: d.parseJson(r.body), at: num(r.at), commandId: String(r.command_id),
  });
  const toChange = (r: Record<string, unknown>): ChangeRow => ({
    seq: num(r.seq), topic: String(r.topic), op: r.op as ChangeRow['op'], key: String(r.key),
    doc: r.doc == null ? undefined : d.parseJson(r.doc), at: num(r.at),
  });
  const toReceipt = (r: Record<string, unknown>): Receipt => ({
    commandId: String(r.command_id), kind: String(r.kind), issuerKind: String(r.issuer_kind), issuerId: String(r.issuer_id),
    receivedAt: num(r.received_at), epoch: num(r.epoch), status: r.status as Receipt['status'],
    result: r.result == null ? undefined : d.parseJson(r.result),
    ...(r.first_seq != null ? { firstSeq: num(r.first_seq) } : {}),
  });
  const toRow = (r: Record<string, unknown>): Row => ({
    collection: r.collection as Row['collection'], key: String(r.key), doc: d.parseJson(r.doc),
  });

  const ROW_COLS: Array<[string, ColType]> = [['collection', 'text'], ['key', 'text'], ['doc', 'json']];
  const EVENT_COLS: Array<[string, ColType]> = [
    ['seq', 'bigint'], ['aggregate', 'text'], ['aggregate_id', 'text'], ['job_id', 'text'], ['kind', 'text'],
    ['who', 'text'], ['body', 'json'], ['at', 'bigint'], ['command_id', 'text'],
  ];
  const CHANGE_COLS: Array<[string, ColType]> = [
    ['seq', 'bigint'], ['topic', 'text'], ['op', 'text'], ['key', 'text'], ['doc', 'json'], ['at', 'bigint'],
  ];
  const OUTPUT_COLS: Array<[string, ColType]> = [['session_id', 'text'], ['seq', 'bigint'], ['item', 'json'], ['at', 'bigint']];
  const COMMAND_COLS: Array<[string, ColType]> = [
    ['command_id', 'text'], ['kind', 'text'], ['issuer_kind', 'text'], ['issuer_id', 'text'], ['received_at', 'bigint'],
    ['epoch', 'bigint'], ['status', 'text'], ['result', 'json'], ['first_seq', 'bigint'],
  ];
  const eventValues = (e: EventRow) => [e.seq, e.aggregate, e.aggregateId, e.jobId ?? null, e.kind, e.who, json(e.body), e.at, e.commandId];
  const changeValues = (c: ChangeRow) => [c.seq, c.topic, c.op, c.key, json(c.doc), c.at];
  const receiptValues = (r: Receipt) => [
    r.commandId, r.kind, r.issuerKind, r.issuerId, r.receivedAt, r.epoch, r.status, json(r.result), r.firstSeq ?? null,
  ];

  async function readReceipt(q: SqlTx, commandId: string): Promise<Receipt | undefined> {
    const [r] = await q.query('SELECT * FROM commands WHERE command_id = $1', [commandId]);
    return r && toReceipt(r);
  }

  return {
    kind: d.kind,

    migrate: () => runMigrations(conn, d),

    acquireLease: (holder, { force }) => conn.withTx(d.beginCommit, async (tx) => {
      const current = toLease((await tx.query(d.leaseLockSql))[0]);
      const now = Date.now();
      let lease: Lease;
      if (!current) {
        lease = { ...holder, epoch: 1, acquiredAt: now };
        await tx.query('INSERT INTO cp_lease (id, holder_id, holder_addr, epoch, acquired_at) VALUES (1, $1, $2, $3, $4)',
          [lease.holderId, lease.holderAddr, lease.epoch, lease.acquiredAt]);
      } else {
        if (current.holderId !== holder.holderId && !force) throw new LeaseHeld(current);
        const epoch = current.holderId === holder.holderId ? current.epoch : current.epoch + 1;
        lease = { ...holder, epoch, acquiredAt: now };
        await tx.query('UPDATE cp_lease SET holder_id = $1, holder_addr = $2, epoch = $3, acquired_at = $4 WHERE id = 1',
          [lease.holderId, lease.holderAddr, lease.epoch, lease.acquiredAt]);
      }
      held = lease;
      return lease;
    }),

    currentLease: async () => toLease((await conn.query('SELECT * FROM cp_lease WHERE id = 1'))[0]),

    loadAll: (): Promise<Snapshot> => conn.withTx(d.beginRead, async (tx) => {
      const lease = toLease((await tx.query('SELECT * FROM cp_lease WHERE id = 1'))[0]);
      if (!lease) throw new Error('loadAll before any lease was acquired');
      const [head] = await tx.query('SELECT events_seq, changes_seq FROM stream_head WHERE id = 1');
      const [low] = await tx.query('SELECT seq FROM changes_low_water WHERE id = 1');
      const rows = (await tx.query('SELECT collection, key, doc FROM rows ORDER BY collection, key')).map(toRow);
      return { lease, rows, eventsHead: num(head!.events_seq), changesHead: num(head!.changes_seq), changesLowWater: num(low!.seq) };
    }),

    commit: (batch: CommitBatch): Promise<CommitResult> => conn.withTx(d.beginCommit, async (tx) => {
      const current = toLease((await tx.query(d.fenceSql))[0])!;
      if (!held || current.epoch !== batch.epoch || current.holderId !== held.holderId) {
        return { status: 'fenced', current };
      }
      faults('after-fence');

      const r = batch.receipt;
      const inserted = await tx.query(
        `INSERT INTO commands (command_id, kind, issuer_kind, issuer_id, received_at, epoch, status, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8${d.jsonCast})
         ON CONFLICT (command_id) DO NOTHING RETURNING command_id`,
        [r.commandId, r.kind, r.issuerKind, r.issuerId, r.receivedAt, batch.epoch, r.status, json(r.result)]);
      if (inserted.length === 0) return { status: 'duplicate', receipt: (await readReceipt(tx, r.commandId))! };
      faults('after-receipt');

      const [head] = await tx.query(
        'UPDATE stream_head SET events_seq = events_seq + $1, changes_seq = changes_seq + $2 WHERE id = 1 RETURNING events_seq, changes_seq',
        [batch.events.length, batch.changes.length]);
      const firstEventSeq = num(head!.events_seq) - batch.events.length + 1;
      const firstChangeSeq = num(head!.changes_seq) - batch.changes.length + 1;
      faults('after-seq');

      // Last put wins, as in memory; Postgres refuses an upsert that touches one row twice.
      const puts = new Map(batch.puts.map((p) => [`${p.collection}\u0000${p.key}`, p]));
      await d.insertMany(tx, 'rows', ROW_COLS, [...puts.values()].map((p) => [p.collection, p.key, json(p.doc)]),
        'ON CONFLICT (collection, key) DO UPDATE SET doc = excluded.doc');
      for (const del of batch.deletes) {
        await tx.query('DELETE FROM rows WHERE collection = $1 AND key = $2', [del.collection, del.key]);
      }
      faults('after-rows');

      await d.insertMany(tx, 'events', EVENT_COLS,
        batch.events.map((e, i) => eventValues({ ...e, seq: firstEventSeq + i, commandId: r.commandId })));
      await d.insertMany(tx, 'changes', CHANGE_COLS, batch.changes.map((c, i) => changeValues({ ...c, seq: firstChangeSeq + i })));
      await d.insertMany(tx, 'session_output', OUTPUT_COLS,
        (batch.sessionOutput ?? []).map((o) => [o.sessionId, o.seq, json(o.item), o.at]));
      faults('after-events');

      for (const p of batch.prune ?? []) {
        if (p.table === 'changes') {
          await tx.query('DELETE FROM changes WHERE seq < $1', [p.belowSeq]);
          await tx.query('UPDATE changes_low_water SET seq = CASE WHEN seq < $1 THEN $1 ELSE seq END WHERE id = 1', [p.belowSeq]);
        } else if (p.table === 'session_output') {
          await tx.query('DELETE FROM session_output WHERE session_id = $1 AND seq < $2', [p.sessionId, p.belowSeq]);
        } else if (p.table === 'events') {
          await tx.query('DELETE FROM events WHERE job_id = $1', [p.jobId]);
        } else {
          await tx.query('DELETE FROM commands WHERE received_at < $1', [p.receivedBefore]);
        }
      }
      if (batch.events.length > 0) await tx.query('UPDATE commands SET first_seq = $1 WHERE command_id = $2', [firstEventSeq, r.commandId]);

      return {
        status: 'committed',
        ...(batch.events.length > 0 ? { firstEventSeq } : {}),
        ...(batch.changes.length > 0 ? { firstChangeSeq } : {}),
      };
    }),

    receipt: (commandId) => readReceipt(conn, commandId),

    async scanEvents({ jobId, beforeSeq, limit }) {
      return (await conn.query('SELECT * FROM events WHERE job_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3',
        [jobId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit])).map(toEvent);
    },

    async scanChanges({ fromSeq, limit }) {
      return (await conn.query('SELECT * FROM changes WHERE seq >= $1 ORDER BY seq LIMIT $2', [fromSeq, limit])).map(toChange);
    },

    async scanSessionOutput({ sessionId, fromSeq, limit }) {
      return (await conn.query('SELECT seq, item, at FROM session_output WHERE session_id = $1 AND seq >= $2 ORDER BY seq LIMIT $3',
        [sessionId, fromSeq, limit])).map((r) => ({ seq: num(r.seq), item: d.parseJson(r.item), at: num(r.at) }));
    },

    // Reads the whole store into memory in one snapshot; page by primary key once a store outgrows memory.
    async *dump(): AsyncIterable<DumpRecord> {
      yield* await conn.withTx(d.beginRead, async (tx): Promise<DumpRecord[]> => {
        const lease = toLease((await tx.query('SELECT * FROM cp_lease WHERE id = 1'))[0]);
        const [head] = await tx.query('SELECT events_seq, changes_seq FROM stream_head WHERE id = 1');
        const [low] = await tx.query('SELECT seq FROM changes_low_water WHERE id = 1');
        return [
          {
            t: 'head', ...(lease ? { lease } : {}),
            eventsSeq: num(head!.events_seq), changesSeq: num(head!.changes_seq), changesLowWater: num(low!.seq),
          },
          ...(await tx.query('SELECT * FROM rows ORDER BY collection, key')).map((r) => ({ t: 'row' as const, row: toRow(r) })),
          ...(await tx.query('SELECT * FROM events ORDER BY seq')).map((r) => ({ t: 'event' as const, event: toEvent(r) })),
          ...(await tx.query('SELECT * FROM changes ORDER BY seq')).map((r) => ({ t: 'change' as const, change: toChange(r) })),
          ...(await tx.query('SELECT * FROM session_output ORDER BY session_id, seq')).map((r) => ({
            t: 'session_output' as const, sessionId: String(r.session_id), seq: num(r.seq), item: d.parseJson(r.item), at: num(r.at),
          })),
          ...(await tx.query('SELECT * FROM commands ORDER BY command_id')).map((r) => ({ t: 'receipt' as const, receipt: toReceipt(r) })),
        ];
      });
    },

    async restore(records) {
      const all: DumpRecord[] = [];
      for await (const rec of records) all.push(rec);
      const head = all.find((r): r is Extract<DumpRecord, { t: 'head' }> => r.t === 'head');
      if (!head) throw new Error('restore: dump has no head record');
      const pick = <K extends DumpRecord['t']>(t: K) => all.filter((r): r is Extract<DumpRecord, { t: K }> => r.t === t);

      await conn.withTx(d.beginCommit, async (tx) => {
        const [counts] = await tx.query(`SELECT
          (SELECT COUNT(*) FROM rows) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM changes)
          + (SELECT COUNT(*) FROM session_output) + (SELECT COUNT(*) FROM commands) + (SELECT COUNT(*) FROM cp_lease)
          + (SELECT events_seq + changes_seq FROM stream_head WHERE id = 1) AS n`);
        if (num(counts!.n) !== 0) throw new Error('restore: target store is not empty');

        await d.insertMany(tx, 'rows', ROW_COLS, pick('row').map(({ row: p }) => [p.collection, p.key, json(p.doc)]));
        await d.insertMany(tx, 'events', EVENT_COLS, pick('event').map((r) => eventValues(r.event)));
        await d.insertMany(tx, 'changes', CHANGE_COLS, pick('change').map((r) => changeValues(r.change)));
        await d.insertMany(tx, 'session_output', OUTPUT_COLS,
          pick('session_output').map((o) => [o.sessionId, o.seq, json(o.item), o.at]));
        await d.insertMany(tx, 'commands', COMMAND_COLS, pick('receipt').map((r) => receiptValues(r.receipt)));
        await tx.query('UPDATE stream_head SET events_seq = $1, changes_seq = $2 WHERE id = 1', [head.eventsSeq, head.changesSeq]);
        await tx.query('UPDATE changes_low_water SET seq = $1 WHERE id = 1', [head.changesLowWater]);
        if (head.lease) {
          await tx.query('INSERT INTO cp_lease (id, holder_id, holder_addr, epoch, acquired_at) VALUES (1, $1, $2, $3, $4)',
            [head.lease.holderId, head.lease.holderAddr, head.lease.epoch, head.lease.acquiredAt]);
        }
      });
    },

    close: () => conn.close(),
  };
}
