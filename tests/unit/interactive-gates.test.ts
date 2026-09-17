import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { InteractiveStore } from '../../src/session/interactive-store.js';
import { orchestratedHandler } from '../../src/steps/orchestrated.js';
import type { OrchestratedStep, ProposedStep } from '../../src/work/work-types.js';

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'interactive-gates-'));
  const queue = new JobQueue(dir);
  const interactive = new InteractiveStore();
  const resumed: Array<{ sessionId: string; content: string }> = [];
  const sessionManager = {
    spawnDetached() {},
    send() {},
    isWorking() { return false; },
    interrupt() {},
    sendOrResume(sessionId: string, _cwd: string, msg: { message: { content: string } }) {
      resumed.push({ sessionId, content: msg.message.content });
    },
  } as never;
  const engine = new WorkEngine({
    queue,
    sessionManager,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    interactive,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
  });
  return { engine, queue, interactive, resumed };
}

function addOrchestratedStep(engine: WorkEngine, jobId: string): OrchestratedStep {
  const proposed: ProposedStep = {
    type: 'orchestrated',
    controller: 'code.orchestrate-pr',
    title: 't',
    description: 'd',
    goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
  };
  return engine.addStepManually(jobId, proposed) as OrchestratedStep;
}

// Gives the step a session and registers the role the same way a spawn would, without
// running the spawn path.
function attachSession(engine: WorkEngine, jobId: string, stepId: string, sessionId: string) {
  engine.adoptStepSessionForTest(jobId, stepId, sessionId);
}

describe('WorkEngine.interactiveTarget', () => {
  it('is undefined for a session the daemon does not own', () => {
    const { engine } = makeEngine();
    expect(engine.interactiveTarget('stranger')).toBeUndefined();
  });

  it('resolves a live step session to its job and step', () => {
    const { engine } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    expect(engine.interactiveTarget('sess-1')).toEqual({ jobId: job.id, stepId });
  });

  it('refuses a terminal step — nothing will ever resume it', () => {
    const { engine } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    engine.onStepFailed(job.id, stepId, 'boom', { journal: false });
    expect(engine.interactiveTarget('sess-1')).toBeUndefined();
  });
});

describe('WorkEngine.interactiveRefusal', () => {
  it('is undefined while the step runs on autopilot', () => {
    const { engine } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    expect(engine.interactiveRefusal(job.id, stepId)).toBeUndefined();
  });

  it('refuses, and tells the model not to retry, while the user drives', () => {
    const { engine, interactive } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    interactive.set('sess-1', true);
    const reason = engine.interactiveRefusal(job.id, stepId);
    expect(reason).toContain('taken the wheel');
    expect(reason).toContain('Do not retry');
  });
});

describe('the pause gates', () => {
  it('does not arm the unresolved-step failure while the user drives', () => {
    const { engine, interactive } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    expect(engine.armUnresolvedCheck('sess-1', 'no submit')).toBe(true);
    interactive.set('sess-1', true);
    expect(engine.armUnresolvedCheck('sess-1', 'no submit')).toBe(false);
  });

  // decide() is pure, so this drives it directly rather than through the engine — going via
  // the engine would have its own tick deliver (and drain) the inbox before the assertion.
  it('holds inbox delivery while the user drives, and releases it after', () => {
    const step = {
      id: 'st1',
      type: 'orchestrated',
      controller: 'code.orchestrate-pr',
      title: 't',
      description: 'd',
      goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
      state: 'running',
      sessionId: 'sess-1',
      dispatches: [],
      inbox: [{ id: 'i1', at: 1, kind: 'user-message', body: 'hi' }],
      roundsSpent: 1,
      consecutiveSelfRounds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const job = { id: 'job1', steps: [step] };
    const ctx = { jobsDir: '/tmp', newId: () => 'x', now: () => 2 };

    const driving = orchestratedHandler.decide(step as never, job as never, {
      ...ctx, isInteractive: () => true,
    });
    expect(driving).toBeNull();

    const handedBack = orchestratedHandler.decide(step as never, job as never, {
      ...ctx, isInteractive: () => false,
    });
    expect(handedBack).toEqual({ kind: 'deliver-inbox', jobId: 'job1', stepId: 'st1' });
  });

  it('retry clears the flag — it means start over, not keep my conversation', () => {
    const { engine, interactive } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    interactive.set('sess-1', true);
    engine.onStepRetry(job.id, stepId);
    expect(interactive.isInteractive('sess-1')).toBe(false);
  });

  it('keeps a driven step attached across a daemon restart', () => {
    const { engine, queue, interactive } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    interactive.set('sess-1', true);
    engine.reconcileInterruptedSteps();
    expect(queue.get(job.id)!.steps.find((s) => s.id === stepId)!.sessionId).toBe('sess-1');
  });

  it("still drops an autopilot step's dead session across a restart", () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    engine.reconcileInterruptedSteps();
    expect(queue.get(job.id)!.steps.find((s) => s.id === stepId)!.sessionId).toBeUndefined();
  });
});

describe('resuming a driven session', () => {
  it('does not re-invoke the skill — that would restart it and drop the conversation', async () => {
    const { engine, interactive, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');
    interactive.set('sess-1', true);

    await engine.resumeControllerRoundForTest(job.id, stepId, 'code.merge-pr', undefined);

    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.content).not.toContain('/code.merge-pr');
    expect(resumed[0]!.content).toContain('Autopilot is paused');
  });

  it('still re-invokes the skill on autopilot', async () => {
    const { engine, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    attachSession(engine, job.id, stepId, 'sess-1');

    await engine.resumeControllerRoundForTest(job.id, stepId, 'code.merge-pr', undefined);

    expect(resumed[0]!.content).toBe('/code.merge-pr');
  });
});
