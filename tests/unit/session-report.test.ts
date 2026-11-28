import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { resolveWorkSession } from '../../src/work/work-launch.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'session-report-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, sendTurn() {}, isWorking() { return false; }, sendOrResume() {} } as never,
    worktreeManager: { get: () => undefined } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry: { getAction: () => ({ frontmatter: { outpost: { runner: 'builtin' } } }), listActions: () => [] } as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue };
}

function sessionStep(extra: Partial<ActionStep> = {}): ActionStep {
  return {
    id: 's', type: 'action', title: 'Sign off', description: '', goal: 'g', action: 'meta.session',
    inputs: { prompt: 'Read the brief' }, state: 'waiting', manualSession: { id: 'manual-1', cwd: '/tmp' },
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

function seed(queue: JobQueue, engine: WorkEngine, steps: ActionStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps }));
  return job.id;
}

const stepOf = (queue: JobQueue, jobId: string) => queue.get(jobId)!.steps.find((s) => s.id === 's') as ActionStep;

describe('meta.session settles into a step-review', () => {
  it('a report resolves the step with its fields and owes a review', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [sessionStep()]);

    expect(engine.onSessionReport(jobId, 's', {
      summary: 'Brief needs a smaller scope', report: '## Checked\nbrief.md',
      answers: [{ question: 'Audience?', answer: 'me' }], corrections: ['cut multiplayer'], wantsReplan: true,
    })).toBe(true);

    const step = stepOf(queue, jobId);
    expect(step.state).toBe('resolved');
    expect(step.reviewed).toBeFalsy();
    expect(JSON.parse(step.output!)).toEqual({
      resumed_by: 'report', summary: 'Brief needs a smaller scope', report: '## Checked\nbrief.md',
      answers: [{ question: 'Audience?', answer: 'me' }], corrections: ['cut multiplayer'], wantsReplan: true,
    });
    expect(queue.get(jobId)!.reviewingStepId).toBe('s');
  });

  it.each([
    ['Done', (e: WorkEngine, id: string) => e.resumeSession(id, 's', '  two weekends ')],
    ['the legacy wait gate', (e: WorkEngine, id: string) => e.resumeWait(id, 's', '  two weekends ')],
  ])('%s carries the note and owes a review', (_name, settle) => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [sessionStep()]);

    settle(engine, jobId);

    const step = stepOf(queue, jobId);
    expect(JSON.parse(step.output!)).toEqual({ resumed_by: 'user', note: 'two weekends' });
    expect(step.reviewed).toBeFalsy();
    expect(queue.get(jobId)!.reviewingStepId).toBe('s');
  });

  it('refuses a report once the step is settled', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [sessionStep()]);
    engine.resumeSession(jobId, 's');

    expect(engine.onSessionReport(jobId, 's', { summary: 'late', report: 'late' })).toBe(false);
    expect(JSON.parse(stepOf(queue, jobId).output!)).toEqual({ resumed_by: 'user' });
  });
});

describe('resolveWorkSession', () => {
  const job = (step: ActionStep) => ({ id: 'J', steps: [step] }) as unknown as JobRecord;

  it('resolves a meta.session\'s manual session only for a tool that opts in', () => {
    expect(resolveWorkSession(job(sessionStep()), { stepId: 's', allowManualSession: true })).toBe('manual-1');
    expect(resolveWorkSession(job(sessionStep()), { stepId: 's' })).toBeUndefined();
  });

  it('never resolves a meta.wait\'s manual session', () => {
    expect(resolveWorkSession(job(sessionStep({ action: 'meta.wait' })), { stepId: 's', allowManualSession: true })).toBeUndefined();
  });
});
