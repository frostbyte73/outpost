import { describe, it, expect } from 'vitest';
import { RuntimeRegistry, unenforceableGroups } from '../../src/runtime/registry.js';
import type { AgentRuntime, RuntimeCapabilities } from '../../src/runtime/types.js';

const FULL: RuntimeCapabilities = {
  sessions: { supportsResume: true },
  streaming: { streamsAssistantText: true },
  tools: { supportsMcpTools: true, gatesMcpTools: true, gatesFileChanges: true, gatesAllCalls: true },
  subagents: { enabled: true },
  approvals: {
    supportsCommandApproval: true, supportsFileChangeApproval: true,
    approvalsCanOriginateFromSubagents: true, approvalCallbacksAreLiveOnly: true,
  },
  runtimePolicy: { enforcement: 'client-boundary' },
};

const rt = (id: string, over: { available?: boolean; caps?: Partial<RuntimeCapabilities> } = {}) =>
  ({ id, available: over.available ?? true, capabilities: { ...FULL, ...over.caps } }) as AgentRuntime;

const GROUPS = ['core', 'read', 'push'];

// A push action admitted onto a runtime whose pins don't hold is a write that never meets its approval.
describe('unenforceableGroups', () => {
  it('holds every group on a runtime that gates every call', () => {
    expect(unenforceableGroups(rt('claude'), GROUPS)).toEqual([]);
  });

  it('refuses push when subagent calls bypass the gate, and admits it once subagents are off', () => {
    const subagentLeak = { approvals: { ...FULL.approvals, approvalsCanOriginateFromSubagents: false } };
    expect(unenforceableGroups(rt('codex', { caps: subagentLeak }), GROUPS)).toEqual(['push']);
    expect(unenforceableGroups(rt('codex', { caps: { ...subagentLeak, subagents: { enabled: false } } }), GROUPS)).toEqual([]);
  });

  it('refuses push when some tool reaches no gate', () => {
    expect(unenforceableGroups(rt('codex', { caps: { tools: { ...FULL.tools, gatesAllCalls: false } } }), GROUPS)).toEqual(['push']);
  });

  it('refuses every group on a runtime that polices itself or is not installed', () => {
    expect(unenforceableGroups(rt('acp', { caps: { runtimePolicy: { enforcement: 'native' } } }), GROUPS)).toEqual(GROUPS);
    expect(unenforceableGroups(rt('codex', { available: false }), GROUPS)).toEqual(GROUPS);
  });
});

describe('RuntimeRegistry.refusal', () => {
  it('names a runtime that is not installed rather than blaming the groups', () => {
    const reg = new RuntimeRegistry(rt('claude'), [rt('codex', { available: false })]);
    expect(reg.refusal('codex', 'read.investigate', ['core', 'read'])).toMatch(/isn't installed/);
    expect(reg.refusal('codex', 'meta.note', [])).toMatch(/isn't installed/);
    expect(reg.refusal('claude', 'read.investigate', ['core', 'read'])).toBeUndefined();
  });
});
