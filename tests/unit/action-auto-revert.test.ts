import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRevisionsStore } from '../../src/storage/action-revisions-store.js';
import { autoRevertIfRegressed, buildRevisionHistory } from '../../src/routes/action-revisions.js';
import type { ActionsStore } from '../../src/storage/actions-store.js';
import type { ActionRunOutcome, ActionRunRecord } from '../../src/storage/action-runs-store.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let dir: string;
let store: ActionRevisionsStore;
let clock: number;
let seq: number;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'auto-revert-'));
  dir = join(root, 'actions', 'code', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'v1');
  clock = 1000;
  seq = 0;
  store = new ActionRevisionsStore(join(root, 'revs'), () => `e${++seq}`, () => (clock += 10));
});

function runsOf(body: string, from: number, outcomes: ActionRunOutcome[]): ActionRunRecord[] {
  return outcomes.map((outcome, i) => ({
    id: `r${from + i}`, action: 'code.x', round: 'r', attempt: 1, jobId: 'j', startedAt: from + i, verdictAt: from + i, skillSha: sha(body), outcome,
  }));
}

function deps(runs: ActionRunRecord[], reverted: string[], removed: string[] = []) {
  return {
    store,
    runsFor: () => runs,
    dirFor: () => dir,
    onReverted: (a: string) => { reverted.push(a); },
    actionsStore: { removeRule: (_a: string, _k: string, v: string) => { removed.push(v); return true; } } as unknown as ActionsStore,
  };
}

function seed(): number {
  store.applyWrite({ action: 'code.x', dir, body: 'v1', author: 'user' });
  const baselineAt = store.listByAction('code.x')[0]!.at;
  store.applyWrite({ action: 'code.x', dir, body: 'v2', author: 'improver' });
  return baselineAt;
}

const many = (o: ActionRunOutcome, n: number): ActionRunOutcome[] => Array<ActionRunOutcome>(n).fill(o);

describe('autoRevertIfRegressed', () => {
  it('restores the previous body as a system revert naming the regression, once', () => {
    const baselineAt = seed();
    const runs = [
      ...runsOf('v1', baselineAt, many('accepted', 10)),
      ...runsOf('v2', clock + 1, [...many('accepted', 4), ...many('edited', 4)]),
    ];
    const reverted: string[] = [];
    const event = autoRevertIfRegressed('code.x', deps(runs, reverted));
    expect(event).toMatchObject({ kind: 'reverted', author: 'system', rationale: 'regression: 100% → 50% verbatim' });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('v1');
    expect(reverted).toEqual(['code.x']);
    expect(autoRevertIfRegressed('code.x', deps(runs, reverted))).toBeUndefined();
  });

  it('leaves a revision alone when its rate holds', () => {
    const baselineAt = seed();
    const runs = [...runsOf('v1', baselineAt, many('accepted', 10)), ...runsOf('v2', clock + 1, many('accepted', 8))];
    expect(autoRevertIfRegressed('code.x', deps(runs, []))).toBeUndefined();
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('revokes the regressed revision\'s rules, not the restored one\'s', () => {
    store.applyWrite({ action: 'code.x', dir, body: 'v1', author: 'user', allowlistAdds: [{ kind: 'bash', value: '^keep' }] });
    const baselineAt = store.listByAction('code.x')[0]!.at;
    store.applyWrite({ action: 'code.x', dir, body: 'v2', author: 'improver', allowlistAdds: [{ kind: 'bash', value: '^drop' }] });
    const runs = [
      ...runsOf('v1', baselineAt, many('accepted', 10)),
      ...runsOf('v2', clock + 1, many('denied', 8)),
    ];
    const removed: string[] = [];
    autoRevertIfRegressed('code.x', deps(runs, [], removed));
    expect(removed).toEqual(['^drop']);
  });

  it('judges the first improver edit against runs that predate the genesis snapshot', () => {
    store.applyWrite({ action: 'code.x', dir, body: 'v2', author: 'improver' });
    const runs = [...runsOf('v1', 0, many('accepted', 10)), ...runsOf('v2', clock + 1, many('denied', 8))];
    expect(autoRevertIfRegressed('code.x', deps(runs, []))).toMatchObject({ kind: 'reverted', author: 'system' });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('v1');
  });

  it('restores the repo copy too when the regressed revision was auto-applied', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'auto-revert-repo-'));
    mkdirSync(join(repoRoot, 'code', 'x'), { recursive: true });
    writeFileSync(join(repoRoot, 'code', 'x', 'SKILL.md'), 'v2');
    store.applyWrite({ action: 'code.x', dir, body: 'v1', author: 'user' });
    const baselineAt = store.listByAction('code.x')[0]!.at;
    store.applyWrite({ action: 'code.x', dir, body: 'v2', author: 'improver', evalId: 'ev1' });
    const runs = [...runsOf('v1', baselineAt, many('accepted', 10)), ...runsOf('v2', clock + 1, many('denied', 8))];
    autoRevertIfRegressed('code.x', { ...deps(runs, []), repoActionsDir: repoRoot });
    expect(readFileSync(join(repoRoot, 'code', 'x', 'SKILL.md'), 'utf8')).toBe('v1');
  });
});

describe('buildRevisionHistory', () => {
  it('offers undo only on an auto-applied revision that is still the head', () => {
    store.applyWrite({ action: 'code.x', dir, body: 'v1', author: 'user' });
    store.applyWrite({ action: 'code.x', dir, body: 'v2', author: 'improver', evalId: 'ev1' });
    expect(buildRevisionHistory(store, 'code.x')[0]).toMatchObject({ kind: 'applied', canUndo: true });
    store.applyWrite({ action: 'code.x', dir, body: 'v3', author: 'user' });
    expect(buildRevisionHistory(store, 'code.x').some((v) => v.canUndo)).toBe(false);
  });
});
