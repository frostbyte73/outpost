import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { RuntimeRegistry } from '../../src/runtime/registry.js';
import type { AgentRuntime, RuntimeCapabilities } from '../../src/runtime/types.js';
import type { OrchestratedStep } from '../../src/work/work-types.js';

const CAPS: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true, gatesMcpTools: true, gatesFileChanges: true, gatesAllCalls: true },
  subagents: { enabled: false },
  approvals: {
    supportsCommandApproval: true, supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: true, approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

const claude = { id: 'claude', available: true, capabilities: CAPS } as AgentRuntime;
const leakyCodex = { id: 'codex', available: true, capabilities: { ...CAPS, tools: { ...CAPS.tools, gatesAllCalls: false } } } as AgentRuntime;

// A self-round runs on the controller's own session, so a push action rebound there must be judged
// by that session's runtime — not by where a fresh child of the same action would run.
describe('WorkEngine runtime refusal for controller moves', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'engine-runtime-refusal-'));
    const queue = new JobQueue(dir);
    const engine = new WorkEngine({
      queue,
      sessionManager: {
        spawnDetached() {}, sendTurn() {}, sendOrResume() {}, isWorking() { return false; }, close: async () => {},
        runtimeOf: (sid: string) => (sid === 'ctrl-sess' ? 'codex' : 'claude'),
      } as never,
      worktreeManager: { provision: async () => ({ path: null }), get: () => undefined, archive: async () => {} } as never,
      linearWriter: { setState: async () => undefined } as never,
      actionRegistry: {
        getAction: (name: string) => ({ name, frontmatter: { outpost: { side_effects: 'external-write' } } }),
        inheritedGroups: () => ['core', 'push'],
        gatedFor: () => undefined,
      } as never,
      runtimes: new RuntimeRegistry(claude, [leakyCodex]),
      jobsDir: join(dir, 'jobs'), now: () => 1,
    });
    const step: OrchestratedStep = {
      id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: 'ctrl-sess',
    };
    queue.upsert({ id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing', steps: [step], createdAt: 1, updatedAt: 1 });
    const struck = () => !!(queue.get('job-1')!.steps[0] as OrchestratedStep).pendingPolicyStrike;
    return { engine, struck };
  }

  it('refuses a self-round onto a push action the controller session runtime cannot enforce', () => {
    const { engine, struck } = setup();
    engine.onStepProgress('job-1', 'step-1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    expect(struck()).toBe(true);
  });

  it('admits the same action as a dispatch, whose child resolves to Claude', () => {
    const { engine, struck } = setup();
    engine.onStepProgress('job-1', 'step-1', { next: { kind: 'dispatch', dispatches: [{ action: 'code.merge-pr', brief: 'b' }] } });
    expect(struck()).toBe(false);
  });
});
