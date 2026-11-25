import { GATED_GROUPS } from '../actions/registry.js';
import type { ActionDef } from '../actions/types.js';
import { isRuntimeId, type AgentRuntime, type RuntimeId } from './types.js';

export function runtimeLabel(id: RuntimeId): string {
  if (id === 'claude') return 'Claude';
  if (id === 'codex') return 'Codex';
  if (id === 'cursor') return 'Cursor';
  return id.startsWith('acp:') ? id.slice('acp:'.length) : id;
}

// The harnesses this daemon can run sessions on; Claude is always present.
export class RuntimeRegistry {
  private readonly byId: Map<string, AgentRuntime>;

  constructor(readonly claude: AgentRuntime, others: AgentRuntime[] = []) {
    this.byId = new Map([claude, ...others].map((r) => [r.id, r]));
  }

  get(id: string): AgentRuntime | undefined {
    return this.byId.get(id);
  }

  listAvailable(): { id: RuntimeId; label: string }[] {
    return [...this.byId.values()].flatMap((r) => r.available && isRuntimeId(r.id)
      ? [{ id: r.id, label: r.label ?? runtimeLabel(r.id) }]
      : []);
  }

  // The refusal for running `action` (whose resolved groups are `groups`) on `rtId`, if it can't be enforced there.
  refusal(rtId: RuntimeId, action: string, groups: string[]): string | undefined {
    const rt = this.byId.get(rtId);
    if (!rt?.available) return `${action} is set to run on ${rtId}, which isn't installed on this machine`;
    const bad = unenforceableGroups(rt, groups);
    return bad.length > 0 ? `${action} needs ${bad.join(', ')}, which runtime ${rtId} can't enforce` : undefined;
  }
}

export function resolveRuntime(action: ActionDef | undefined, job: { runtime?: RuntimeId } | undefined): RuntimeId {
  return action?.frontmatter.outpost.runtime ?? job?.runtime ?? 'claude';
}

// The groups whose grants `rt` cannot hold a session to; an unavailable runtime holds none.
export function unenforceableGroups(rt: AgentRuntime, groups: string[]): string[] {
  if (!rt.available) return groups;
  const { tools, approvals, subagents, runtimePolicy } = rt.capabilities;
  if (runtimePolicy.enforcement !== 'client-boundary') return groups;
  const pinsHold = tools.gatesMcpTools && tools.gatesFileChanges && tools.gatesAllCalls
    && (approvals.approvalsCanOriginateFromSubagents || !subagents.enabled);
  return pinsHold ? [] : groups.filter((g) => GATED_GROUPS.has(g));
}
