import type { EvalOutcome } from '../eval/eval-verdict.js';
import type { ActionAuthor } from '../storage/action-revisions-store.js';
import { NO_AUTO_APPLY } from './improvement-pack.js';

export function autoApplies(autoApply: boolean, author: ActionAuthor | undefined, action: string): boolean {
  return autoApply && author === 'improver' && !NO_AUTO_APPLY.has(action);
}

export type Settlement = 'apply' | 'drop' | 'card' | 'stale';

// `stale` leaves the card too: the pass was earned against a body that is no longer installed
export function evalSettlement(input: {
  autoApply: boolean;
  author?: ActionAuthor;
  action: string;
  outcome: EvalOutcome;
  installedBody: string;
  proposedOver: string;
}): Settlement {
  if (!autoApplies(input.autoApply, input.author, input.action)) return 'card';
  if (input.outcome !== 'pass') return 'drop';
  return input.installedBody === input.proposedOver ? 'apply' : 'stale';
}
