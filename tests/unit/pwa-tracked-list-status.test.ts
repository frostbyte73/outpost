// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTrackedList } from '../../src/pwa/components/tracked/list.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { work } from '../../src/pwa/state/work.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { jobStepStatus } from '../../src/pwa/vm/tracked.js';

// A parked job's row says what it is parked on, from the step's facts, in the icon slot and
// beside the step dots — not a generic half-circle that sends the user into the detail to find
// out the PR is ready to merge.

const READY = { prUrl: 'https://github.com/o/r/pull/2029', prState: 'open', ciState: 'success', reviewState: 'approved' };

function step(o: Record<string, unknown> = {}) {
  return {
    id: 'st1', type: 'orchestrated', title: 'Ship it', controller: 'code.orchestrate-pr',
    phase: 'pr_open', state: 'waiting', waitingOn: { reason: 'PR #2029 is ready to merge.' },
    sessionId: 'sess-1', cancelled: false, createdAt: 1, updatedAt: 100,
    dispatches: [], inbox: [], drafts: [], artifacts: {},
    workspace: { kind: 'writable', repoCwd: '/repo', branch: 'feat/x' },
    pr: READY, ...o,
  };
}

function job(id: string, o: Record<string, unknown> = {}, s: Record<string, unknown> = {}) {
  return {
    id, title: `Job ${id}`, state: 'executing', source: 'manual', createdAt: 1, updatedAt: 100, events: [],
    steps: [step(s)], live: { orchestrator: false, stepIds: [], sessionIds: [] }, ...o,
  };
}

describe('jobStepStatus', () => {
  it('reads the parked controller', () => {
    expect(jobStepStatus(job('a'))).toMatchObject({ glyph: '→', tone: 'ok', text: 'Ready to merge' });
  });

  it('a stalled session speaks for the job', () => {
    const stalls = [{ sessionId: 'sess-1', error: 'server_error', at: 1, stepId: 'st1' }];
    expect(jobStepStatus(job('a', { stalls }, { state: 'running' })))
      .toMatchObject({ glyph: '!', tone: 'warn', text: 'Stopped on an API error (server error)' });
  });

  it('nothing for a step mid-resume, a settled step, or an action step', () => {
    expect(jobStepStatus(job('a', {}, { state: 'running' }))).toBeNull();
    expect(jobStepStatus(job('a', {}, { state: 'resolved' }))).toBeNull();
    expect(jobStepStatus(job('a', {}, { type: 'action' }))).toBeNull();
  });
});

describe('tracked list rows', () => {
  let root: HTMLElement;
  const row = (id: string) => root.querySelector(`.lr-row[data-job-id="${id}"]`)!;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  it('a parked job shows its step status as the icon and beside the dots', () => {
    work.applyWsEvent({ jobId: 'r1', job: job('r1') });
    renderTrackedList(root);
    const icon = row('r1').querySelector('.o-row-icon')!;
    expect(icon.textContent).toBe('→');
    expect(icon.classList.contains('ok')).toBe(true);
    const label = row('r1').querySelector('.tracked-step-status')!;
    expect(label.textContent).toBe('Ready to merge');
    expect(label.getAttribute('title')).toBe('PR #2029 is ready to merge.');
  });

  it('a running job keeps its pulse and shows no step label', () => {
    work.applyWsEvent({
      jobId: 'r2',
      job: job('r2', { live: { orchestrator: false, stepIds: ['st1'], sessionIds: ['sess-1'] } }),
    });
    renderTrackedList(root);
    expect(row('r2').querySelector('.o-row-icon')!.getAttribute('data-status')).toBe('running');
    expect(row('r2').querySelector('.o-row-icon')!.textContent).toBe('●');
    expect(row('r2').querySelector('.tracked-step-status')).toBeNull();
  });
});
