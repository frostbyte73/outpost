import { toCanonicalItem, type CodexItem } from './items.js';
import type { CanonicalEvent } from '../types.js';

interface TokenBreakdown { inputTokens: number; cachedInputTokens: number; outputTokens: number }

const TURN_STATES = { completed: 'completed', failed: 'failed', interrupted: 'interrupted' } as const;

// Codex app-server notifications as canonical events; `model` labels the context window it reports.
export function mapCodexNotification(method: string, params: unknown, model: string | undefined): CanonicalEvent[] {
  const p = params as Record<string, unknown>;
  switch (method) {
    case 'turn/started':
      return [{ type: 'turn.started' }];
    case 'turn/completed': {
      const turn = p.turn as { status: string; error?: { message?: string } | null };
      const state = TURN_STATES[turn.status as keyof typeof TURN_STATES] ?? 'failed';
      return [{ type: 'turn.completed', state, ...(turn.error?.message ? { stopReason: turn.error.message } : {}) }];
    }
    case 'item/started':
    case 'item/completed': {
      const item = toCanonicalItem(p.item as CodexItem);
      if (!item) return [];
      return [{ type: method === 'item/started' ? 'item.started' : 'item.completed', item }];
    }
    case 'item/agentMessage/delta':
      return [{ type: 'content.delta', stream: 'assistant_text', text: String(p.delta ?? '') }];
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return [{ type: 'content.delta', stream: 'reasoning', text: String(p.delta ?? '') }];
    case 'thread/tokenUsage/updated': {
      const usage = p.tokenUsage as { last: TokenBreakdown; modelContextWindow: number | null };
      return [{
        type: 'usage.updated',
        usage: {
          ...(model ? { model } : {}),
          response: {
            inputTokens: usage.last.inputTokens,
            outputTokens: usage.last.outputTokens,
            cacheReadTokens: usage.last.cachedInputTokens,
            cacheCreationTokens: 0,
          },
          ...(model && usage.modelContextWindow ? { contextWindows: { [model]: usage.modelContextWindow } } : {}),
        },
      }];
    }
    default:
      return [];
  }
}
