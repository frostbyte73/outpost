import { isToolItem, type CodexItem } from './items.js';

export interface PinRelease {
  toolUseId: string;
  tool: string;
  input: unknown;
  interrupted: boolean;
}

// Polls of a live process (write_stdin) and the user's own `!` commands never pass through PreToolUse.
const HOOKLESS_SOURCES = new Set(['unifiedExecInteraction', 'userShell']);

// What the gate saw for each call of one Codex session, so items can be checked and released against it.
export class CallTracker {
  private readonly gated = new Map<string, { tool: string; input: unknown }>();
  private readonly denied = new Set<string>();
  private readonly interruptedTurns = new Set<string>();

  noteGated(callId: string, tool: string, input: unknown): void {
    this.gated.set(callId, { tool, input });
  }

  noteDenied(callId: string): void {
    this.denied.add(callId);
  }

  noteInterruptRequested(turnId: string): void {
    this.interruptedTurns.add(turnId);
  }

  // A tool item the gate never saw ran without Outpost's hook: the one thing this session must not do.
  ungatedCall(item: CodexItem): string | undefined {
    if (item.type === 'webSearch') return `webSearch ${item.id}`;
    if (!isToolItem(item)) return undefined;
    if (item.type === 'commandExecution' && item.source && HOOKLESS_SOURCES.has(item.source)) return undefined;
    if (this.gated.has(item.id)) return undefined;
    // Codex reporting a call it blocked is not a run; one it starts or finishes anyway is.
    if (this.denied.has(item.id) && item.status === 'declined') return undefined;
    return `${item.type} ${item.id}`;
  }

  // The pin a finished call should give back: it failed, was declined, or exited non-zero.
  releaseFor(item: CodexItem, turnId: string): PinRelease | undefined {
    if (!isToolItem(item)) return undefined;
    const seen = this.gated.get(item.id);
    if (!seen) return undefined;
    this.gated.delete(item.id);
    const exitedNonZero = item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0;
    if (item.status !== 'failed' && item.status !== 'declined' && !exitedNonZero) return undefined;
    return { toolUseId: item.id, tool: seen.tool, input: seen.input, interrupted: this.interruptedTurns.has(turnId) };
  }
}
