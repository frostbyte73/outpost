import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunsStore, type RunRecord } from '../../src/storage/runs-store.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'runs-store-')), 'runs.jsonl');
}

let idCounter = 0;
function newId(): string { return `id-${idCounter++}`; }

// Fixed "now" far enough past any startedAt used below that the default 180d retention
// window never interferes with tests that aren't specifically about retention.
const NOW = 10_000_000;
function store(maxEntries?: number, maxAgeMs?: number): RunsStore {
  return new RunsStore(tmpPath(), newId, () => NOW, maxEntries, maxAgeMs);
}

function row(over: Partial<Omit<RunRecord, 'id'>> = {}): Omit<RunRecord, 'id'> {
  return {
    kind: 'sess',
    title: 'a session',
    startedAt: 1_000_000,
    ...over,
  };
}

describe('RunsStore', () => {
  it('appends and lists newest-first regardless of append order', () => {
    const s = store();
    s.append(row({ title: 'first', startedAt: 100 }));
    s.append(row({ title: 'third', startedAt: 300 }));
    s.append(row({ title: 'second', startedAt: 200 }));
    expect(s.list().map((r) => r.title)).toEqual(['third', 'second', 'first']);
  });

  it('persists across instances (reloads from JSONL)', () => {
    const path = mkdtempSync(join(tmpdir(), 'runs-store-')) + '/runs.jsonl';
    const s1 = new RunsStore(path, newId, () => NOW);
    s1.append(row({ title: 'persisted' }));
    const s2 = new RunsStore(path, newId, () => NOW);
    expect(s2.list().map((r) => r.title)).toEqual(['persisted']);
  });

  it('filters by kind', () => {
    const s = store();
    s.append(row({ kind: 'sess', title: 'a session' }));
    s.append(row({ kind: 'track', title: 'a job' }));
    s.append(row({ kind: 'sched', title: 'a scheduled run' }));
    expect(s.list({ kind: 'track' }).map((r) => r.title)).toEqual(['a job']);
  });

  it('filters by sinceMs', () => {
    const s = store();
    s.append(row({ title: 'old', startedAt: 1000 }));
    s.append(row({ title: 'new', startedAt: 5000 }));
    expect(s.list({ sinceMs: 4000 }).map((r) => r.title)).toEqual(['new']);
  });

  it('filters by repo (substring match on cwd, case-insensitive)', () => {
    const s = store();
    s.append(row({ title: 'a', cwd: '/Users/alice/outpost' }));
    s.append(row({ title: 'b', cwd: '/Users/alice/other-repo' }));
    expect(s.list({ repo: 'OUTPOST' }).map((r) => r.title)).toEqual(['a']);
  });

  it('filters by verdict (substring match, case-insensitive)', () => {
    const s = store();
    s.append(row({ title: 'a', verdict: 'Skipped — usage 96%' }));
    s.append(row({ title: 'b', verdict: 'Client-side · closed' }));
    expect(s.list({ verdict: 'skipped' }).map((r) => r.title)).toEqual(['a']);
  });

  it('filters by q across title and sub', () => {
    const s = store();
    s.append(row({ title: 'Investigate ABC-42', sub: 'read.investigate' }));
    s.append(row({ title: 'Nightly PR sweep', sub: 'code.review' }));
    expect(s.list({ q: 'abc' }).map((r) => r.title)).toEqual(['Investigate ABC-42']);
    expect(s.list({ q: 'code.review' }).map((r) => r.title)).toEqual(['Nightly PR sweep']);
  });

  it('paginates with limit/offset', () => {
    const s = store();
    for (let i = 0; i < 5; i++) s.append(row({ title: `r${i}`, startedAt: i }));
    expect(s.list({ limit: 2, offset: 1 }).map((r) => r.title)).toEqual(['r3', 'r2']);
  });

  it('existsByRef finds a run by a given ref field', () => {
    const s = store();
    s.append(row({ refs: { jobId: 'job-1' } }));
    expect(s.existsByRef('jobId', 'job-1')).toBe(true);
    expect(s.existsByRef('jobId', 'job-2')).toBe(false);
    expect(s.existsByRef('sessionId', 'job-1')).toBe(false);
  });

  it('retention: drops entries older than maxAgeMs from the in-memory index', () => {
    let now = 10_000_000;
    const s = new RunsStore(tmpPath(), newId, () => now, 20_000, 2_000);
    s.append(row({ title: 'old', startedAt: now }));
    now += 3_000; // past maxAgeMs; the *next* append re-evaluates retention against current now()
    s.append(row({ title: 'new', startedAt: now }));
    expect(s.list().map((r) => r.title)).toEqual(['new']);
  });

  it('retention: caps in-memory index at maxEntries, keeping the newest', () => {
    const s = new RunsStore(tmpPath(), newId, () => NOW, 3, 1000 * 60 * 60 * 24 * 365);
    for (let i = 0; i < 5; i++) s.append(row({ title: `r${i}`, startedAt: i }));
    expect(s.list().map((r) => r.title)).toEqual(['r4', 'r3', 'r2']);
  });

  it('toCsv escapes commas/quotes and includes a header row', () => {
    const s = store();
    const r = s.append(row({ title: 'Fix "the" bug, please', cwd: '/x', verdict: 'ok', startedAt: 0 }));
    const csv = s.toCsv([r]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,kind,title,sub,cwd,verdict,startedAt,durationMs,costUsd,sessionId,jobId,stepId,scheduleId,prUrl');
    expect(lines[1]).toContain('"Fix ""the"" bug, please"');
  });

  it('recovers gracefully from a corrupt JSONL line', () => {
    const path = mkdtempSync(join(tmpdir(), 'runs-store-')) + '/runs.jsonl';
    const s1 = new RunsStore(path, newId, () => NOW);
    s1.append(row({ title: 'good' }));
    appendFileSync(path, 'not json\n');
    const s2 = new RunsStore(path, newId, () => NOW);
    expect(s2.list().map((r) => r.title)).toEqual(['good']);
  });
});
