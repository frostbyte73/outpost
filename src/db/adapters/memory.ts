import type { AdapterOptions, Backend, ChangeRow, DumpRecord, EventRow, Lease, Receipt, Row } from '../backend.js';
import { LeaseHeld } from '../backend.js';

export interface MemoryStore {
  lease?: Lease;
  rows: Map<string, Row>;
  events: EventRow[];
  changes: ChangeRow[];
  sessionOutput: Array<{ sessionId: string; seq: number; item: unknown; at: number }>;
  receipts: Map<string, Receipt>;
  eventsSeq: number;
  changesSeq: number;
  changesLowWater: number;
}

export function createMemoryStore(): MemoryStore {
  return {
    rows: new Map(), events: [], changes: [], sessionOutput: [], receipts: new Map(),
    eventsSeq: 0, changesSeq: 0, changesLowWater: 0,
  };
}

const rowKey = (collection: string, key: string) => `${collection}\u0000${key}`;

// A handle on `store`; several handles on one store stand in for several control planes on one DB.
export function openMemory(store: MemoryStore, opts: AdapterOptions = {}): Backend {
  const faults = opts.faults ?? (() => {});
  let held: Lease | undefined;
  const clone = <T>(v: T): T => structuredClone(v);

  return {
    kind: 'memory',

    async migrate() {},

    async acquireLease(holder, { force }) {
      const current = store.lease;
      if (current && current.holderId !== holder.holderId && !force) throw new LeaseHeld(clone(current));
      const epoch = !current ? 1 : current.holderId === holder.holderId ? current.epoch : current.epoch + 1;
      store.lease = { ...holder, epoch, acquiredAt: Date.now() };
      held = store.lease;
      return clone(store.lease);
    },

    async currentLease() { return store.lease && clone(store.lease); },

    async loadAll() {
      if (!store.lease) throw new Error('loadAll before any lease was acquired');
      return clone({
        lease: store.lease,
        rows: [...store.rows.values()].sort((a, b) => rowKey(a.collection, a.key) < rowKey(b.collection, b.key) ? -1 : 1),
        eventsHead: store.eventsSeq, changesHead: store.changesSeq, changesLowWater: store.changesLowWater,
      });
    },

    async commit(batch) {
      const current = store.lease!;
      if (!held || current.epoch !== batch.epoch || current.holderId !== held.holderId) {
        return { status: 'fenced', current: clone(current) };
      }
      faults('after-fence');
      const existing = store.receipts.get(batch.receipt.commandId);
      if (existing) return { status: 'duplicate', receipt: clone(existing) };

      const next = clone(store);
      const receipt: Receipt = { ...clone(batch.receipt), epoch: batch.epoch };
      next.receipts.set(receipt.commandId, receipt);
      faults('after-receipt');

      const firstEventSeq = next.eventsSeq + 1;
      const firstChangeSeq = next.changesSeq + 1;
      next.eventsSeq += batch.events.length;
      next.changesSeq += batch.changes.length;
      faults('after-seq');

      for (const p of batch.puts) next.rows.set(rowKey(p.collection, p.key), clone(p));
      for (const d of batch.deletes) next.rows.delete(rowKey(d.collection, d.key));
      faults('after-rows');

      batch.events.forEach((e, i) => next.events.push({ ...clone(e), seq: firstEventSeq + i, commandId: receipt.commandId }));
      batch.changes.forEach((c, i) => next.changes.push({ ...clone(c), seq: firstChangeSeq + i }));
      for (const o of batch.sessionOutput ?? []) next.sessionOutput.push(clone(o));
      faults('after-events');

      for (const p of batch.prune ?? []) {
        if (p.table === 'changes') {
          next.changes = next.changes.filter((c) => c.seq >= p.belowSeq);
          next.changesLowWater = Math.max(next.changesLowWater, p.belowSeq);
        } else if (p.table === 'session_output') {
          next.sessionOutput = next.sessionOutput.filter((o) => o.sessionId !== p.sessionId || o.seq >= p.belowSeq);
        } else if (p.table === 'events') {
          next.events = next.events.filter((e) => e.jobId !== p.jobId);
        } else {
          for (const [id, r] of next.receipts) if (r.receivedAt < p.receivedBefore) next.receipts.delete(id);
        }
      }
      if (batch.events.length > 0 && next.receipts.has(receipt.commandId)) receipt.firstSeq = firstEventSeq;

      Object.assign(store, next);
      return {
        status: 'committed',
        ...(batch.events.length > 0 ? { firstEventSeq } : {}),
        ...(batch.changes.length > 0 ? { firstChangeSeq } : {}),
      };
    },

    async receipt(commandId) {
      const r = store.receipts.get(commandId);
      return r && clone(r);
    },

    async scanEvents({ jobId, beforeSeq, limit }) {
      return clone(store.events
        .filter((e) => e.jobId === jobId && (beforeSeq === undefined || e.seq < beforeSeq))
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit));
    },

    async scanChanges({ fromSeq, limit }) {
      return clone(store.changes.filter((c) => c.seq >= fromSeq).slice(0, limit));
    },

    async scanSessionOutput({ sessionId, fromSeq, limit }) {
      return clone(store.sessionOutput
        .filter((o) => o.sessionId === sessionId && o.seq >= fromSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(({ seq, item, at }) => ({ seq, item, at })));
    },

    async *dump(): AsyncIterable<DumpRecord> {
      const s = clone(store);
      yield {
        t: 'head', ...(s.lease ? { lease: s.lease } : {}),
        eventsSeq: s.eventsSeq, changesSeq: s.changesSeq, changesLowWater: s.changesLowWater,
      };
      for (const row of [...s.rows.values()].sort((a, b) => rowKey(a.collection, a.key) < rowKey(b.collection, b.key) ? -1 : 1)) {
        yield { t: 'row', row };
      }
      for (const event of s.events) yield { t: 'event', event };
      for (const change of s.changes) yield { t: 'change', change };
      for (const o of [...s.sessionOutput].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.seq - b.seq)) {
        yield { t: 'session_output', ...o };
      }
      for (const receipt of [...s.receipts.values()].sort((a, b) => a.commandId < b.commandId ? -1 : 1)) yield { t: 'receipt', receipt };
    },

    async restore(records) {
      const isEmpty = !store.lease && store.rows.size === 0 && store.events.length === 0 && store.changes.length === 0
        && store.sessionOutput.length === 0 && store.receipts.size === 0 && store.eventsSeq === 0 && store.changesSeq === 0;
      if (!isEmpty) throw new Error('restore: target store is not empty');
      const next = createMemoryStore();
      let sawHead = false;
      for await (const r of records) {
        if (r.t === 'head') {
          sawHead = true;
          if (r.lease) next.lease = clone(r.lease);
          next.eventsSeq = r.eventsSeq;
          next.changesSeq = r.changesSeq;
          next.changesLowWater = r.changesLowWater;
        } else if (r.t === 'row') next.rows.set(rowKey(r.row.collection, r.row.key), clone(r.row));
        else if (r.t === 'event') next.events.push(clone(r.event));
        else if (r.t === 'change') next.changes.push(clone(r.change));
        else if (r.t === 'session_output') next.sessionOutput.push({ sessionId: r.sessionId, seq: r.seq, item: clone(r.item), at: r.at });
        else next.receipts.set(r.receipt.commandId, clone(r.receipt));
      }
      if (!sawHead) throw new Error('restore: dump has no head record');
      Object.assign(store, next);
    },

    async close() {},
  };
}
