import { randomUUID } from 'node:crypto';

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
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
  onResolve: (id: string, d: Decision) => void = () => {};

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
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    this.onResolve(id, decision);
  }
}
