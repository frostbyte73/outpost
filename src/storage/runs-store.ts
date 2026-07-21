import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Cross-category run ledger backing "Runs history": sessions, tracked jobs, and
// scheduled automations all append here once they finish, so one table can show
// them chronologically. The JSONL file is the permanent append-only ledger (never
// rewritten); `index` is a bounded, sorted in-memory view of it that serves list()/
// existsByRef() and is what retention (count/age) actually trims — old rows stay on
// disk, they just drop out of what the daemon serves.

export type RunKind = 'sess' | 'track' | 'sched';

export interface RunRefs {
  sessionId?: string;
  jobId?: string;
  stepId?: string;
  scheduleId?: string;
  prUrl?: string;
}

export interface RunRecord {
  id: string;
  kind: RunKind;
  title: string;
  sub?: string;
  cwd?: string;
  verdict?: string;
  startedAt: number;
  durationMs?: number;
  costUsd?: number;
  refs?: RunRefs;
}

export interface RunFilters {
  sinceMs?: number;
  kind?: RunKind;
  repo?: string;
  verdict?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const MAX_RUN_ENTRIES = 20_000;
const MAX_RUN_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function appendJsonLine(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 });
}

export class RunsStore {
  private index: RunRecord[] = []; // newest-first

  constructor(
    private readonly path: string,
    private readonly newId: () => string = () => randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries: number = MAX_RUN_ENTRIES,
    private readonly maxAgeMs: number = MAX_RUN_AGE_MS,
  ) {
    if (!existsSync(path)) return;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const rows: RunRecord[] = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line) as RunRecord); } catch { /* skip corrupt line */ }
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    this.index = this.applyRetention(rows);
  }

  private applyRetention(rows: RunRecord[]): RunRecord[] {
    const cutoff = this.now() - this.maxAgeMs;
    return rows.filter((r) => r.startedAt >= cutoff).slice(0, this.maxEntries);
  }

  append(input: Omit<RunRecord, 'id'> & { id?: string }): RunRecord {
    const record: RunRecord = { ...input, id: input.id ?? this.newId() };
    appendJsonLine(this.path, record);
    // Sorted insert rather than unshift: kind:'track'/'sched' rows are appended when the
    // job/schedule *finishes*, but startedAt is when it *began* — potentially long before
    // rows appended in between, so newest-append != newest-startedAt.
    const merged = [...this.index, record].sort((a, b) => b.startedAt - a.startedAt);
    this.index = this.applyRetention(merged);
    return record;
  }

  existsByRef(key: keyof RunRefs, value: string): boolean {
    return this.index.some((r) => r.refs?.[key] === value);
  }

  list(filters: RunFilters = {}): RunRecord[] {
    let rows = this.index;
    if (filters.sinceMs !== undefined) {
      const since = filters.sinceMs;
      rows = rows.filter((r) => r.startedAt >= since);
    }
    if (filters.kind) rows = rows.filter((r) => r.kind === filters.kind);
    if (filters.repo) {
      const needle = filters.repo.toLowerCase();
      rows = rows.filter((r) => (r.cwd ?? '').toLowerCase().includes(needle));
    }
    if (filters.verdict) {
      const needle = filters.verdict.toLowerCase();
      rows = rows.filter((r) => (r.verdict ?? '').toLowerCase().includes(needle));
    }
    if (filters.q) {
      const needle = filters.q.toLowerCase();
      rows = rows.filter((r) =>
        r.title.toLowerCase().includes(needle) || (r.sub ?? '').toLowerCase().includes(needle));
    }
    if (filters.limit !== undefined || filters.offset !== undefined) {
      const offset = filters.offset ?? 0;
      const limit = filters.limit ?? rows.length;
      rows = rows.slice(offset, offset + limit);
    }
    return rows;
  }

  toCsv(rows: RunRecord[]): string {
    const header = [
      'id', 'kind', 'title', 'sub', 'cwd', 'verdict', 'startedAt', 'durationMs', 'costUsd',
      'sessionId', 'jobId', 'stepId', 'scheduleId', 'prUrl',
    ];
    const esc = (v: unknown): string => {
      let s = v === undefined || v === null ? '' : String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.id, r.kind, r.title, r.sub ?? '', r.cwd ?? '', r.verdict ?? '',
        new Date(r.startedAt).toISOString(), r.durationMs ?? '', r.costUsd ?? '',
        r.refs?.sessionId ?? '', r.refs?.jobId ?? '', r.refs?.stepId ?? '',
        r.refs?.scheduleId ?? '', r.refs?.prUrl ?? '',
      ].map(esc).join(','));
    }
    return lines.join('\n') + '\n';
  }
}
