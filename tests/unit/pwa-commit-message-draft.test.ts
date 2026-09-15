import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { commitMessageCandidates, draftCommitMessage } from '../../src/pwa/utils/commit-message.js';

function ctx(step: Record<string, unknown>, job: Record<string, unknown> = {}) {
  return { job: { id: 'j1', ...job }, step: { id: 's1', type: 'orchestrated', title: 'Land the thing', goal: 'Ship it.', ...step } };
}

describe('commit-message draft', () => {
  // The bug: title/goal are fixed at plan time and `output` doesn't exist on an orchestrated
  // step, so every round of a PR drafted the same message. Only artifacts.commitMessage moves.
  it('leads with the round-authored message over the static template', () => {
    const round1 = ctx({ artifacts: { commitMessage: 'Cap tailscale CLI calls' } });
    const round2 = ctx({ artifacts: { commitMessage: 'Stop retrying a dead repo' } });
    expect(draftCommitMessage(round1, 0)).toBe('Cap tailscale CLI calls');
    expect(draftCommitMessage(round2, 0)).toBe('Stop retrying a dead repo');
    expect(draftCommitMessage(round1, 0)).not.toBe(draftCommitMessage(round2, 0));
  });

  it('falls back to the title template when no round authored one', () => {
    expect(draftCommitMessage(ctx({}), 0)).toBe('Land the thing\n\nShip it.');
    expect(draftCommitMessage(ctx({ artifacts: {} }), 0)).toBe('Land the thing\n\nShip it.');
  });

  it('every ⌘R press lands on a different message', () => {
    const c = commitMessageCandidates(ctx({ artifacts: { commitMessage: 'Do the thing' } }));
    expect(new Set(c).size).toBe(c.length);
    // Without a `verdict` the first and last templates are byte-identical, so the raw
    // 4-template list must collapse to 3.
    expect(c).toEqual(['Do the thing', 'Land the thing\n\nShip it.', 'Fix: Land the thing\n\nShip it.']);
  });

  // A PR-shaped step is usually one of several on the ticket, so the trailer claimed a close
  // that wasn't happening — on the first commit and on every one after it.
  it('never adds a Closes trailer, even for a Linear-sourced job', () => {
    const ref = { externalRef: { issueIdentifier: 'CS-1608' } };
    expect(draftCommitMessage(ctx({ artifacts: { commitMessage: 'Do it' } }, ref), 0)).toBe('Do it');
    expect(commitMessageCandidates(ctx({}, ref)).join('\n')).not.toContain('CS-1608');
  });

  it('still reads output on a plain action step', () => {
    const c = ctx({ type: 'action', output: 'Bumped protocol to v1.51.0' });
    expect(draftCommitMessage(c, 0)).toBe('Land the thing\n\nBumped protocol to v1.51.0');
  });

  it('survives a missing step or job', () => {
    expect(draftCommitMessage(null, 0)).toBe('');
    expect(draftCommitMessage({ job: null, step: null }, 3)).toBe('');
  });
});
