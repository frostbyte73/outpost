import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPrHandler } from '../../src/steps/open-pr.js';
import type { JobRecord, OpenPrStep } from '../../src/work/work-types.js';
import type { HandlerCtx } from '../../src/steps/types.js';

function ctx(): HandlerCtx {
  return { jobsDir: mkdtempSync(join(tmpdir(), 'orch-conflict-')), newId: () => 'id', now: () => 1 };
}

function step(state: OpenPrStep['state'], overrides: Partial<OpenPrStep> = {}): OpenPrStep {
  return {
    id: 's1', title: 't', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    goal: 'g', approach: 'a', state, createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function job(s: OpenPrStep): JobRecord {
  return { id: 'j1', source: 'manual', title: 't', description: 'd', state: 'executing', steps: [s], createdAt: 0, updatedAt: 0 };
}

describe('openPrHandler.decide conflict handling', () => {
  it('requests approval when a conflict is detected and no round is running', () => {
    const s = step('conflicting');
    const a = openPrHandler.decide(s, job(s), ctx());
    expect(a).toEqual({ kind: 'request-conflict-approval', jobId: 'j1', stepId: 's1' });
  });

  it('is idle while a resolve round is in flight', () => {
    const s = step('conflicting', { conflictResolving: true });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('is idle in conflict_unresolved (waits for the human)', () => {
    const s = step('conflict_unresolved');
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });
});
