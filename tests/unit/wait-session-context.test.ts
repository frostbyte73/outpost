import { describe, it, expect } from 'vitest';
import { waitSessionContext } from '../../src/work/wait-session-context.js';
import type { ActionStep, JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

function action(id: string, extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id, type: 'action', title: `title ${id}`, description: '', goal: `goal ${id}`,
    action: 'read.investigate', state: 'resolved', workspace: { kind: 'none' },
    createdAt: 0, updatedAt: 0, ...extra,
  };
}

function job(steps: JobRecord['steps']): JobRecord {
  return { id: 'J', source: 'manual', title: 'Ship egress fix', description: 'Roll out the fix', state: 'executing', steps } as JobRecord;
}

const prStep: OrchestratedStep = {
  id: 'pr', type: 'orchestrated', title: 'Open the PR', description: '', goal: 'fix egress',
  controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, state: 'resolved',
  dispatches: [], inbox: [], roundsSpent: 3, consecutiveSelfRounds: 0,
  pr: { prUrl: 'https://github.com/livekit/cloud-egress/pull/7', prState: 'merged' },
  createdAt: 0, updatedAt: 0,
};

describe('waitSessionContext', () => {
  it('carries the job, the wait reason and preview, and earlier steps', () => {
    const text = waitSessionContext(job([
      prStep,
      action('inv', { output: 'all healthy' }),
      action('w', { action: 'meta.wait', state: 'waiting', title: 'Hold for prod deploy', inputs: { reason: 'Milos deploys', preview: { ring: 'prod' } } }),
      action('after', { title: 'later step' }),
    ]), 'w');

    expect(text).toContain('# Job: Ship egress fix');
    expect(text).toContain('Roll out the fix');
    expect(text).toContain('# Wait step: Hold for prod deploy');
    expect(text).toContain('Milos deploys');
    expect(text).toContain('"ring": "prod"');
    expect(text).toContain('PR: https://github.com/livekit/cloud-egress/pull/7 (merged)');
    expect(text).toContain('all healthy');
    expect(text).not.toContain('later step');
    expect(text).toContain('Outpost PWA');
  });

  it('truncates long earlier output', () => {
    const text = waitSessionContext(job([
      action('inv', { output: 'x'.repeat(5000) }),
      action('w', { action: 'meta.wait', state: 'waiting' }),
    ]), 'w');
    expect(text).toContain(`${'x'.repeat(2000)}… [truncated]`);
    expect(text).not.toContain('x'.repeat(2001));
  });

  it('tells a meta.session how to report back, and a wait that there is nothing to submit', () => {
    const steps = [action('s', { action: 'meta.session', state: 'waiting' }), action('w', { action: 'meta.wait', state: 'waiting' })];
    const session = waitSessionContext(job(steps), 's');
    expect(session).toContain('job `J`, step `s`');
    expect(session).toContain('mcp__outpost__submit_session_report');
    expect(session).not.toContain('nothing to submit');
    expect(waitSessionContext(job(steps), 'w')).toContain('nothing to submit');
  });

  it('builds for a first-step wait with no reason or preview', () => {
    const text = waitSessionContext(job([action('w', { action: 'meta.wait', state: 'waiting' })]), 'w');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('# Earlier steps');
    expect(text).not.toContain('## Preview');
  });
});
