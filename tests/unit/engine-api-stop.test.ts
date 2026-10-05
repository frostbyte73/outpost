import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { withLiveness } from '../../src/work/job-liveness.js';
import type { OrchestratedStep, ProposedStep } from '../../src/work/work-types.js';

// StopFailure (an API error ended the turn) parks the session instead of failing the step, and a
// resume continues the SAME session through its role's warm path. Harness as engine-turn-end's.
function makeEngine(governor?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-api-stop-'));
  const queue = new JobQueue(dir);
  const resumed: Array<{ sessionId: string; content: string; env?: Record<string, string> }> = [];
  const sessionManager = {
    spawnDetached() {},
    send() {},
    isWorking() { return false; },
    sendOrResume(sessionId: string, _cwd: string, msg: { message: { content: string } }, env?: Record<string, string>) {
      resumed.push({ sessionId, content: msg.message.content, env });
    },
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager,
    worktreeManager: { get: () => undefined, provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
    unresolvedGraceMs: 5,
    ...(governor ? { governor: governor as never } : {}),
  });
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  const proposed: ProposedStep = {
    type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix it', description: 'd', goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
  };
  const stepId = engine.addStepManually(job.id, proposed)!.id;
  queue.mutate(job.id, (j) => ({
    ...j, state: 'executing', orchestratorSessionId: 'orch-1', orchestratorAction: 'meta.orchestrate',
    steps: j.steps.map((s) => s.id === stepId ? { ...s, sessionId: 'sess-1' } as OrchestratedStep : s),
  }));
  engine.rehydrateSessionBindings();
  const live = () => withLiveness(queue.get(job.id)!, () => false).stalls ?? [];
  return { engine, queue, resumed, jobId: job.id, stepId, live };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('WorkEngine — sessions an API error stopped', () => {
  it('parks the step session instead of failing it, and never lets a Stop-armed check fail it', async () => {
    const { engine, queue, jobId, stepId, live } = makeEngine();
    engine.armUnresolvedCheck('sess-1', 'ended without submitting');
    expect(engine.onApiStop('sess-1', 'rate_limit')).toBe(true);
    await flush();
    const step = queue.get(jobId)!.steps.find((s) => s.id === stepId)!;
    expect(step.failure).toBeUndefined();
    expect(live()).toEqual([{ sessionId: 'sess-1', error: 'rate_limit', at: 1, stepId }]);
  });

  it('resumes the same controller session warm, then clears the stall', async () => {
    const { engine, resumed, jobId, live } = makeEngine();
    engine.onApiStop('sess-1', 'overloaded');
    expect(engine.resumeStalls(jobId)).toBe(1);
    await flush();
    expect(resumed).toEqual([expect.objectContaining({ sessionId: 'sess-1', content: '/code.orchestrate-pr' })]);
    expect(live()).toEqual([]);
    expect(engine.resumeStalls(jobId)).toBe(0);
  });

  it('resumes a stalled orchestrator with its own action and envelope', async () => {
    const { engine, resumed, jobId } = makeEngine();
    engine.onApiStop('orch-1', 'authentication_failed');
    engine.resumeStalls(jobId);
    await flush();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ sessionId: 'orch-1', content: '/meta.orchestrate' });
    expect(resumed[0]!.env?.OUTPOST_ENVELOPE).toMatch(new RegExp(`${jobId}/orchestrator/envelope\\.json$`));
  });

  it('a sign-in resumes only the auth stalls; a rate limit waits for the user', async () => {
    const { engine, resumed, live } = makeEngine();
    engine.onApiStop('sess-1', 'rate_limit');
    engine.onApiStop('orch-1', 'authentication_failed');
    expect(engine.resumeAuthStalls()).toBe(1);
    await flush();
    expect(resumed.map((r) => r.sessionId)).toEqual(['orch-1']);
    expect(live().map((s) => s.error)).toEqual(['rate_limit']);
  });

  it('drops a stall once its session is no longer the step\'s (a retry cold-respawns it)', () => {
    const { engine, jobId, stepId, live } = makeEngine();
    engine.onApiStop('sess-1', 'rate_limit');
    engine.onStepRetry(jobId, stepId);
    expect(live()).toEqual([]);
  });

  it('a real Stop on the session clears its stall', () => {
    const { engine, live } = makeEngine();
    engine.onApiStop('sess-1', 'rate_limit');
    engine.clearStall('sess-1');
    expect(live()).toEqual([]);
  });

  it('ignores a session that is not a job\'s', () => {
    const { engine } = makeEngine();
    expect(engine.onApiStop('someone-elses', 'rate_limit')).toBe(false);
  });
});

// A paused queue holds the daemon's own starts. The planner's resume after a sign-in is one of
// those; the user's Resume click is not.
describe('WorkEngine — a stalled planner resumes through the launch governor', () => {
  it('as the user\'s launch on a click, as a queued one after a sign-in', () => {
    const priorities: string[] = [];
    const governor = { submit: (r: { priority: string }) => { priorities.push(r.priority); }, describe: () => ({ state: 'idle' }), turnEnded() {} };
    const { engine, jobId } = makeEngine(governor);
    engine.onApiStop('orch-1', 'authentication_failed');
    engine.resumeAuthStalls();
    engine.onApiStop('orch-1', 'overloaded');
    engine.resumeStalls(jobId);
    expect(priorities).toEqual(['queued', 'user']);
  });
});
