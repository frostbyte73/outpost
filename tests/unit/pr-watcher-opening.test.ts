import { describe, it, expect, vi } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';
import type { JobRecord, OrchestratedStep, PrFacts } from '../../src/work/work-types.js';

// The PWA's squash-and-open-PR button pushes the branch and THEN runs `gh pr create`. For the
// seconds in between, origin has the branch and GitHub has no PR on it — and that is exactly
// what row 8 of code.orchestrate-pr reads as "implemented, pushed, open the PR". A sweep
// landing in that window used to wake the controller with `head-moved` and "no PR yet", which
// is how a `gh pr create` draft reached the user for a PR the daemon was already creating.

function stepWith(pr: PrFacts | undefined): OrchestratedStep {
  return {
    id: 's1', type: 'orchestrated', title: 'ship it', description: '',
    controller: 'code.orchestrate-pr', goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'fix/thing' },
    boundAction: 'code.orchestrate-pr', dispatches: [], inbox: [],
    roundsSpent: 4, consecutiveSelfRounds: 0,
    state: 'running', sessionId: 'sess1', createdAt: 0, updatedAt: 0, pr,
  };
}

function watcherFor(step: OrchestratedStep) {
  const job: JobRecord = {
    id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
    orchestratorAction: 'meta.orchestrate', steps: [step], createdAt: 0, updatedAt: 0,
  };
  const applyPrFacts = vi.fn();
  const pushStepInbox = vi.fn();
  const watcher = new PrWatcher({
    queue: { list: () => [job], get: (id: string) => (id === 'j1' ? job : undefined) },
    engine: { applyPrFacts, pushStepInbox },
    // No PR on this branch yet — the whole point of the window under test.
    runGh: async () => '[]',
    remoteHead: async () => 'a'.repeat(40),
  } as unknown as ConstructorParameters<typeof PrWatcher>[0]);
  return { watcher, applyPrFacts, pushStepInbox };
}

describe('the branch-head poll while the daemon is opening the PR', () => {
  it('records the head but does not wake the controller', async () => {
    const h = watcherFor(stepWith({ isOpeningPr: true }));

    await h.watcher.syncJob('j1');

    expect(h.applyPrFacts).toHaveBeenCalledWith('j1', 's1', { branchHeadOid: 'a'.repeat(40) });
    expect(h.pushStepInbox).not.toHaveBeenCalled();
  });

  it('still wakes it for a push the user made themselves', async () => {
    const h = watcherFor(stepWith(undefined));

    await h.watcher.syncJob('j1');

    expect(h.pushStepInbox).toHaveBeenCalledTimes(1);
    expect(h.pushStepInbox.mock.calls[0]![2]).toMatchObject({ events: ['head-moved'] });
  });
});
