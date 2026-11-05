export type Collection =
  | 'jobs' | 'steps' | 'step_inbox' | 'dispatches' | 'gates' | 'drafts' | 'pins'
  | 'sessions' | 'approvals' | 'outbox' | 'timers'
  | 'schedules' | 'schedule_runs' | 'schedule_edits'
  | 'action_runs' | 'runs' | 'journal' | 'denials' | 'recurrence'
  | 'actions_catalog' | 'action_revisions' | 'permission_revisions'
  | 'preferences' | 'approval_modes' | 'session_seen' | 'action_edits'
  | 'devices' | 'nodes' | 'node_projects' | 'pairing_codes' | 'push_subscriptions'
  | 'cp_identity';

export interface Lease { holderId: string; holderAddr: string; epoch: number; acquiredAt: number }

export interface Row { collection: Collection; key: string; doc: unknown }
export interface EventRow { seq: number; aggregate: string; aggregateId: string; jobId?: string; kind: string; who: string; body: unknown; at: number; commandId: string }
export interface ChangeRow { seq: number; topic: string; op: 'upsert' | 'patch' | 'delete'; key: string; doc: unknown; at: number }
export interface Receipt { commandId: string; kind: string; issuerKind: string; issuerId: string; receivedAt: number; epoch: number; status: 'ok' | 'rejected'; result: unknown; firstSeq?: number }

export interface CommitBatch {
  epoch: number;
  receipt: Omit<Receipt, 'firstSeq' | 'epoch'>;
  puts: Row[];
  deletes: Array<{ collection: Collection; key: string }>;
  events: Array<Omit<EventRow, 'seq' | 'commandId'>>;
  changes: Array<Omit<ChangeRow, 'seq'>>;
  sessionOutput?: Array<{ sessionId: string; seq: number; item: unknown; at: number }>;
  prune?: Array<
    | { table: 'changes'; belowSeq: number }
    | { table: 'session_output'; sessionId: string; belowSeq: number }
    | { table: 'events'; jobId: string }
    | { table: 'commands'; receivedBefore: number }>;
}

export type CommitResult =
  | { status: 'committed'; firstEventSeq?: number; firstChangeSeq?: number }
  | { status: 'duplicate'; receipt: Receipt }
  | { status: 'fenced'; current: Lease };

export interface Snapshot {
  lease: Lease;
  rows: Row[];
  eventsHead: number;
  changesHead: number;
  changesLowWater: number;
}

export type DumpRecord =
  | { t: 'head'; lease?: Lease; eventsSeq: number; changesSeq: number; changesLowWater: number }
  | { t: 'row'; row: Row }
  | { t: 'event'; event: EventRow }
  | { t: 'change'; change: ChangeRow }
  | { t: 'session_output'; sessionId: string; seq: number; item: unknown; at: number }
  | { t: 'receipt'; receipt: Receipt };

export interface Backend {
  readonly kind: 'postgres' | 'cockroachdb' | 'sqlite' | 'memory';
  migrate(): Promise<void>;
  acquireLease(holder: { holderId: string; holderAddr: string }, opts: { force: boolean }): Promise<Lease>;
  currentLease(): Promise<Lease | undefined>;
  loadAll(): Promise<Snapshot>;
  commit(batch: CommitBatch): Promise<CommitResult>;
  receipt(commandId: string): Promise<Receipt | undefined>;
  scanEvents(q: { jobId: string; beforeSeq?: number; limit: number }): Promise<EventRow[]>;
  scanChanges(q: { fromSeq: number; limit: number }): Promise<ChangeRow[]>;
  scanSessionOutput(q: { sessionId: string; fromSeq: number; limit: number }): Promise<Array<{ seq: number; item: unknown; at: number }>>;
  dump(): AsyncIterable<DumpRecord>;
  restore(records: AsyncIterable<DumpRecord>): Promise<void>;
  close(): Promise<void>;
}

export type CommitPoint = 'after-fence' | 'after-receipt' | 'after-seq' | 'after-rows' | 'after-events';

export interface AdapterOptions { faults?: (point: CommitPoint) => void }

export class LeaseHeld extends Error {
  constructor(readonly current: Lease) {
    super(`control-plane lease is held by ${current.holderAddr} (${current.holderId}) at epoch ${current.epoch}; set OUTPOST_LEASE_FORCE=1 to take it`);
  }
}
