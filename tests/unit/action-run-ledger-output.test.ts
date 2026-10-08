import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRunLedger } from '../../src/work/action-run-ledger.js';
import { ActionRunsStore } from '../../src/storage/action-runs-store.js';
import { BlobStore } from '../../src/storage/blob-store.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';

function fakeQueue() {
  const subs: Array<(ev: unknown) => void> = [];
  return {
    list: () => [] as JobRecord[],
    subscribe: (fn: (ev: unknown) => void) => { subs.push(fn); return () => {}; },
    emit: (job: JobRecord) => subs.forEach((f) => f({ kind: 'upsert', jobId: job.id, job })),
  };
}

const step: ActionStep = {
  id: 's1', type: 'action', title: 't', description: '', goal: 'g', action: 'read.investigate',
  workspace: { kind: 'none' }, state: 'running', sessionId: 'x', createdAt: 0, updatedAt: 0,
};
const job: JobRecord = { id: 'j1', source: 'manual', title: 't', description: '', state: 'executing', steps: [step], createdAt: 0, updatedAt: 0 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-out-'));
  const store = new ActionRunsStore(join(dir, 'runs.jsonl'));
  const blobs = new BlobStore(join(dir, 'blobs'));
  const ledger = new ActionRunLedger({ store, blobs });
  const q = fakeQueue();
  ledger.attach(q as never);
  q.emit(job);
  return { store, blobs, ledger };
}

describe('ledger round output', () => {
  it('accumulates every submit of the round into one blob', () => {
    const { store, blobs, ledger } = setup();
    const id = ledger.openRunId('j1', 's1')!;
    ledger.noteOutput(id, { tool: 'submit_step_progress', args: { next: { kind: 'self-round' } } });
    ledger.noteOutput(id, { tool: 'worktree-diff', args: { diff: '+x' } });
    const ref = store.get(id)!.outputRef!;
    expect(JSON.parse(blobs.get(ref)!)).toEqual([
      { tool: 'submit_step_progress', args: { next: { kind: 'self-round' } } },
      { tool: 'worktree-diff', args: { diff: '+x' } },
    ]);
    expect(store.referencedBlobs().has(ref)).toBe(true);
  });

  it('ignores an unknown run id', () => {
    const { ledger } = setup();
    expect(() => ledger.noteOutput('nope', { tool: 't', args: {} })).not.toThrow();
  });

  it('has no open run for a step that is not running', () => {
    const { ledger } = setup();
    expect(ledger.openRunId('j1', 'other')).toBeUndefined();
  });
});

describe('ledger round output across a relaunch', () => {
  it('starts a collapsed round\'s output over when it relaunches, so it matches the new envelope', () => {
    const { store, blobs, ledger } = setup();
    const id = ledger.openRunId('j1', 's1')!;
    ledger.beginLaunch('x', { envelopeRef: 'env-1' });
    ledger.noteOutput(id, { tool: 'submit_step_progress', args: { turn: 1 } });
    ledger.beginLaunch('x', { envelopeRef: 'env-2' });
    expect(store.get(id)!.outputRef).toBe('');
    ledger.noteOutput(id, { tool: 'submit_step_progress', args: { turn: 2 } });
    expect(JSON.parse(blobs.get(store.get(id)!.outputRef!)!)).toEqual([{ tool: 'submit_step_progress', args: { turn: 2 } }]);
    expect(store.get(id)!.envelopeRef).toBe('env-2');
  });
});

describe('ledger launch snapshot that completes after the round has output', () => {
  it('keeps the output and lands the git snapshot on the run', () => {
    const { store, ledger } = setup();
    const id = ledger.openRunId('j1', 's1')!;
    const seq = ledger.beginLaunch('x', { envelopeRef: 'env-1', worktreePath: '/wt' });
    expect(store.get(id)).toMatchObject({ worktreePath: '/wt', baseSha: '', gitDir: '' });
    ledger.noteOutput(id, { tool: 'submit_step_progress', args: { turn: 1 } });
    ledger.completeLaunch('x', seq, { baseSha: 'abc', gitDir: '/repo/.git' });
    expect(store.get(id)).toMatchObject({ baseSha: 'abc', gitDir: '/repo/.git', envelopeRef: 'env-1' });
    expect(store.get(id)!.outputRef).toBeTruthy();
  });

  it('drops a snapshot whose launch was already superseded', () => {
    const { store, ledger } = setup();
    const id = ledger.openRunId('j1', 's1')!;
    const first = ledger.beginLaunch('x', { envelopeRef: 'env-1', worktreePath: '/wt' });
    const second = ledger.beginLaunch('x', { envelopeRef: 'env-2', worktreePath: '/wt' });
    ledger.completeLaunch('x', first, { baseSha: 'old', gitDir: '/repo/.git' });
    expect(store.get(id)!.baseSha).toBe('');
    ledger.completeLaunch('x', second, { baseSha: 'new', gitDir: '/repo/.git' });
    expect(store.get(id)!.baseSha).toBe('new');
  });

  it('records the model the session reported', () => {
    const { store, ledger } = setup();
    const id = ledger.openRunId('j1', 's1')!;
    ledger.noteSessionModel('x', 'claude-opus-5-5');
    expect(store.get(id)!.model).toBe('claude-opus-5-5');
  });
});
