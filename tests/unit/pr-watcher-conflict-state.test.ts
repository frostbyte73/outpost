import { describe, it, expect } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

function makeStep(over: Record<string, unknown> = {}) {
  return {
    id: 's1', type: 'open-pr', cancelled: false,
    state: 'pr_open', prState: 'open',
    prUrl: 'https://github.com/acme/example/pull/15282',
    workspace: { repoCwd: '/tmp/repo', branch: 'feat/x' },
    comments: [],
    ...over,
  };
}

function harness(step: ReturnType<typeof makeStep>, viewOver: Record<string, unknown> = {}, inline: unknown[] = []) {
  const job = { id: 'JOB-1', steps: [step] };
  const patches: Array<Record<string, unknown>> = [];
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyOpenPrPatch: (_j: string, _s: string, patch: Record<string, unknown>) => patches.push(patch),
    dropOrphanIterations: () => {},
  } as never;
  const view = JSON.stringify({
    number: 15282, url: 'x', state: 'OPEN', reviews: [], comments: [],
    statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }],
    ...viewOver,
  });
  const runGh = async (_cwd: string, args: string[]) => (args[0] === 'api' ? JSON.stringify(inline) : view);
  const watcher = new PrWatcher({ queue, engine, runGh });
  return { watcher, patches };
}

const stateOf = (patches: Array<Record<string, unknown>>) =>
  patches.find((p) => 'state' in p)?.state;

describe('PrWatcher conflict state', () => {
  it('flips pr_open → conflicting on a conflict', async () => {
    const { watcher, patches } = harness(makeStep(), { mergeable: 'CONFLICTING' });
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBe('conflicting');
  });

  it('conflicts win over pending comments (conflicts-first)', async () => {
    const inline = [{ id: 1, user: { login: 'devin' }, body: 'fix this', path: 'a.ts', line: 2, created_at: '2026-01-01T00:00:00Z' }];
    const { watcher, patches } = harness(makeStep(), { mergeable: 'CONFLICTING' }, inline);
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBe('conflicting');
  });

  it('recovers conflict_unresolved → pr_open when the conflict clears', async () => {
    const { watcher, patches } = harness(makeStep({ state: 'conflict_unresolved', mergeable: 'conflicting' }), { mergeable: 'MERGEABLE' });
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBe('pr_open');
  });

  it('does not touch state while a resolve round is in flight', async () => {
    const { watcher, patches } = harness(makeStep({ conflictResolving: true }), { mergeable: 'CONFLICTING' });
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBeUndefined();
  });
});
