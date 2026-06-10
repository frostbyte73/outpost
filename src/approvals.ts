import { randomUUID } from 'node:crypto';

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  // Claude's stream-json id for the tool_use block this approval is gating. Forwarded
  // to the PWA so an Approve decision can be linked to the subsequent tool_use entry
  // (e.g. to track which tool calls the user explicitly approved vs auto-allowed).
  toolUseId?: string;
  // Claude Code's PreToolUse hook sets agent_id + agent_type when the tool call comes
  // from a subagent (Agent-tool invocations like Explore / general-purpose / etc.). The
  // parent session's own tool calls don't carry these. Plumbing them through here lets
  // the PWA route subagent approvals into a separate UI bucket instead of dumping them
  // into the parent's feed.
  agentId?: string;
  agentType?: string;
}

export interface Decision {
  allow: boolean;
  reason?: string;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  enqueuedAt: number;
}

interface PendingInternal {
  request: PendingApproval;
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalQueue {
  private pending = new Map<string, PendingInternal>();
  private readonly timeoutMs: number;
  onEnqueue: (a: PendingApproval) => void = () => {};
  // Fires for every resolution — user decide AND server timeout. Receives the full
  // approval so the daemon can notify clients about subagent approvals (agentId), surface
  // the correct sessionId, etc., even though the queue has already removed the entry.
  onResolve: (a: PendingApproval, d: Decision) => void = () => {};

  constructor(opts: { timeoutMs: number }) {
    this.timeoutMs = opts.timeoutMs;
  }

  enqueue(req: ApprovalRequest): Promise<Decision> {
    const id = randomUUID();
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveInternal(id, { allow: false, reason: 'Approval timed out — re-prompt to retry' });
      }, this.timeoutMs);
      const approval: PendingApproval = { id, enqueuedAt: Date.now(), ...req };
      this.pending.set(id, { request: approval, resolve, timer });
      this.onEnqueue(approval);
    });
  }

  decide(id: string, decision: Decision): void {
    this.resolveInternal(id, decision);
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  private resolveInternal(id: string, decision: Decision): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    const approval = entry.request;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    this.onResolve(approval, decision);
  }
}
