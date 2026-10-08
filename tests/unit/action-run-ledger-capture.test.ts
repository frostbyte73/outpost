import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRunLedger } from '../../src/work/action-run-ledger.js';
import { ActionRunsStore } from '../../src/storage/action-runs-store.js';
import { BlobStore } from '../../src/storage/blob-store.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';
import type { WriteDraft } from '../../src/work/write-draft.js';

function fakeQueue() {
  const subs: Array<(ev: unknown) => void> = [];
  return {
    list: () => [] as JobRecord[],
    subscribe: (fn: (ev: unknown) => void) => { subs.push(fn); return () => {}; },
    emit: (job: JobRecord) => subs.forEach((f) => f({ kind: 'upsert', jobId: job.id, job })),
  };
}

const draft: WriteDraft = { id: 'd1', action: 'write.linear-comment', raisedBy: { kind: 'step' }, summary: 's', calls: [], requestedAt: 0 };
const step = (over: Partial<ActionStep> = {}): ActionStep => ({
  id: 's1', type: 'action', title: 't', description: '', goal: 'g', action: 'write.linear-comment',
  workspace: { kind: 'none' }, state: 'running', sessionId: 'x', createdAt: 0, updatedAt: 0, ...over,
});
const job = (s: ActionStep, id = 'j1'): JobRecord => ({ id, source: 'manual', title: 't', description: '', state: 'executing', steps: [s], createdAt: 0, updatedAt: 0 });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const store = new ActionRunsStore(join(dir, 'runs.jsonl'));
  const ledger = new ActionRunLedger({ store, blobs: new BlobStore(join(dir, 'blobs')) });
  const q = fakeQueue();
  ledger.attach(q as never);
  q.emit(job(step({ state: 'gate_pending_approval', drafts: [draft] })));
  const draftRow = () => store.listByAction('write.linear-comment').find((r) => r.round === 'draft')!;
  return { store, ledger, q, draftRow };
}

describe('ledger verdict detail', () => {
  it('turns an edited approval into `edited` with the diff stored', () => {
    const { ledger, q, draftRow } = setup();
    ledger.noteVerdict('j1', 's1', { edit: { chars: 5, diff: '-a\n+b' } });
    q.emit(job(step({ drafts: [{ ...draft, approvedAt: 1 }] })));
    expect(draftRow().outcome).toBe('edited');
    expect(draftRow().editChars).toBe(5);
    expect(draftRow().editDiffRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores send-back text', () => {
    const { ledger, q, draftRow } = setup();
    ledger.noteVerdict('j1', 's1', { feedbackText: 'shorter', stale: false });
    q.emit(job(step({ drafts: [{ ...draft, feedback: ['shorter'] }] })));
    expect(draftRow()).toMatchObject({ outcome: 'revised', feedbackText: 'shorter' });
  });

  it('drops a stash the next mutation never verdicts', () => {
    const { ledger, q, draftRow } = setup();
    ledger.noteVerdict('j1', 's1', { edit: { chars: 1, diff: 'd' } });
    q.emit(job(step({ state: 'gate_pending_approval', drafts: [draft], updatedAt: 5 })));
    q.emit(job(step({ drafts: [{ ...draft, approvedAt: 1 }] })));
    expect(draftRow().outcome).toBe('accepted');
  });
});

describe('ledger round snapshots', () => {
  function withSkill() {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const store = new ActionRunsStore(join(dir, 'runs.jsonl'));
    const ledger = new ActionRunLedger({ store, blobs: new BlobStore(join(dir, 'blobs')), skillFor: () => 'SKILL BODY' });
    const q = fakeQueue();
    ledger.attach(q as never);
    return { store, ledger, q };
  }

  it('attaches to the open run and stamps the skill hash from the run\'s own action', () => {
    const { store, ledger, q } = withSkill();
    q.emit(job(step()));
    ledger.attachSnapshot('x', { envelopeRef: 'e1', baseSha: 'b1' });
    expect(store.listByAction('write.linear-comment')[0]).toMatchObject({
      envelopeRef: 'e1', baseSha: 'b1', skillSha: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('holds a snapshot for a session whose round has not opened yet', () => {
    const { store, ledger, q } = withSkill();
    ledger.attachSnapshot('y', { envelopeRef: 'e2' });
    q.emit(job(step({ id: 's2', sessionId: 'y' }), 'j2'));
    expect(store.listByAction('write.linear-comment')[0]).toMatchObject({ envelopeRef: 'e2', stepId: 's2' });
  });
});

describe('ledger recorded reads', () => {
  it('accumulates reads on the open run, deduped, and writes them when the round closes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const store = new ActionRunsStore(join(dir, 'runs.jsonl'));
    const ledger = new ActionRunLedger({ store });
    const q = fakeQueue();
    ledger.attach(q as never);
    q.emit(job(step()));
    const r = { tool: 'Bash', inputKey: 'k', responseRef: 'a' };
    ledger.noteRead('x', r);
    ledger.noteRead('x', { ...r, responseRef: 'b' });
    expect(store.listByAction('write.linear-comment')[0]!.reads).toBeUndefined();
    q.emit(job(step({ state: 'resolved' })));
    expect(store.listByAction('write.linear-comment')[0]!.reads).toEqual([r]);
  });
});

describe('ledger downstream links', () => {
  it('patches a link onto the newest code round on the step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const store = new ActionRunsStore(join(dir, 'runs.jsonl'));
    const ledger = new ActionRunLedger({ store, blobs: new BlobStore(join(dir, 'blobs')) });
    const q = fakeQueue();
    ledger.attach(q as never);
    const orch = (over: Record<string, unknown>) => ({
      id: 's1', type: 'orchestrated', title: 't', description: '', controller: 'code.orchestrate-pr',
      workspace: { kind: 'none' }, goal: 'g', dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', sessionId: 'x', boundAction: 'code.implement', createdAt: 0, updatedAt: 0, ...over,
    });
    const j = (s: unknown): JobRecord => ({ id: 'j1', source: 'manual', title: 't', description: '', state: 'executing', steps: [s as never], createdAt: 0, updatedAt: 0 });
    q.emit(j(orch({})));
    q.emit(j(orch({ pr: { ciState: 'failure', headRefOid: 'h' } })));
    expect(store.listByAction('code.implement')[0]!.links).toEqual([{ kind: 'ciFailed', at: expect.any(Number), headSha: 'h' }]);
  });
});

describe('ledger snapshots on mid-turn rounds', () => {
  it('stamps a draft round that opens mid-turn with the snapshot its session launched under', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const store = new ActionRunsStore(join(dir, 'runs.jsonl'));
    const ledger = new ActionRunLedger({ store, skillFor: () => 'SKILL' });
    const q = fakeQueue();
    ledger.attach(q as never);
    q.emit(job(step()));
    ledger.attachSnapshot('x', { envelopeRef: 'e1' });
    q.emit(job(step({ state: 'gate_pending_approval', drafts: [draft] })));
    expect(store.listByAction('write.linear-comment').find((r) => r.round === 'draft')).toMatchObject({
      envelopeRef: 'e1', skillSha: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
