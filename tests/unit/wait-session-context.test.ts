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

const session = (id: string, extra: Partial<ActionStep> = {}) => action(id, { action: 'meta.session', state: 'waiting', ...extra });

describe('waitSessionContext', () => {
  it('carries the job, the step reason, earlier steps, and how to report back', () => {
    const text = waitSessionContext(job([
      prStep,
      action('inv', { output: 'all healthy' }),
      session('s', { title: 'Promote prod?', inputs: { reason: 'Milos deploys' } }),
      action('after', { title: 'later step' }),
    ]), 's');

    expect(text).toContain('# Job: Ship egress fix');
    expect(text).toContain('Roll out the fix');
    expect(text).toContain('# Step: Promote prod?');
    expect(text).toContain('Milos deploys');
    expect(text).toContain('PR: https://github.com/livekit/cloud-egress/pull/7 (merged)');
    expect(text).toContain('all healthy');
    expect(text).not.toContain('later step');
    expect(text).toContain('job `J`, step `s`');
    expect(text).toContain('mcp__outpost__submit_session_report');
  });

  it('truncates long earlier output', () => {
    const text = waitSessionContext(job([action('inv', { output: 'x'.repeat(5000) }), session('s')]), 's');
    expect(text).toContain(`${'x'.repeat(2000)}… [truncated]`);
    expect(text).not.toContain('x'.repeat(2001));
  });

  it('builds for a first step with no reason', () => {
    const text = waitSessionContext(job([session('s')]), 's');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('# Earlier steps');
  });
});
