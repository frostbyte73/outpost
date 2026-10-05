import { describe, it, expect, vi } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

const PR_URL = 'https://github.com/acme/example/pull/16';

function reviewStep(sessionId?: string) {
  return {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-review',
    title: 'review', description: '', goal: 'review',
    state: 'running', cancelled: false, ...(sessionId ? { sessionId } : {}),
    workspace: { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/16/head' },
    inputs: { prUrl: PR_URL },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    createdAt: 0, updatedAt: 0,
  };
}

async function ghCallsFor(state: string, sessionId?: string): Promise<number> {
  const job = { id: 'j1', state, steps: [reviewStep(sessionId)] };
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
  const runGh = vi.fn(async () => JSON.stringify({ number: 16, url: PR_URL, state: 'OPEN', reviews: [], comments: [] }));
  await new PrWatcher({ queue, engine: engine as never, runGh }).syncJob('j1');
  return runGh.mock.calls.length;
}

describe('PrWatcher job state', () => {
  it('does not poll a plan nobody has approved yet', async () => {
    expect(await ghCallsFor('plan_pending_review')).toBe(0);
  });

  it('does not poll an abandoned job', async () => {
    expect(await ghCallsFor('abandoned', 'sess1')).toBe(0);
  });

  it('keeps polling a live step during a replan of an executing plan', async () => {
    expect(await ghCallsFor('plan_pending_review', 'sess1')).toBeGreaterThan(0);
  });

  it('polls an executing job', async () => {
    expect(await ghCallsFor('executing')).toBeGreaterThan(0);
  });
});
