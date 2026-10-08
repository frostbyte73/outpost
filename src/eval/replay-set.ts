import type { ActionRunRecord, RunLink } from '../storage/action-runs-store.js';
import { CODE_ROUND_ACTIONS } from '../work/action-run-links.js';
import { renderOutputs, type RunOutput } from './run-output.js';

const MAX_TARGETS = 4;
const MAX_REGRESSION = 3;

// What the user (or the PR) ruled on with nobody's gate in between — the same bar verbatimRate uses.
const RULED_OUTCOMES = new Set(['accepted', 'edited', 'revised', 'denied']);

// A round that ran in a worktree replays only from its git snapshot; without one it would run against nothing.
export function isReplayable(r: ActionRunRecord): boolean {
  if (!r.envelopeRef || !r.outputRef || !r.skillSha) return false;
  if (r.worktreePath || r.baseSha || CODE_ROUND_ACTIONS.has(r.action)) return !!r.baseSha && !!r.gitDir && !!r.worktreePath;
  return true;
}

function isCodeRound(r: ActionRunRecord): boolean {
  return CODE_ROUND_ACTIONS.has(r.action);
}

export function isTargetEligible(r: ActionRunRecord): boolean {
  if (!isReplayable(r) || !r.outcome || r.outcome === 'superseded') return false;
  if (r.outcome === 'failed' || r.outcome === 'gave_up') return true;
  if (isCodeRound(r) && (r.links?.length ?? 0) > 0) return true;
  return r.verdictAt !== undefined && RULED_OUTCOMES.has(r.outcome);
}

export function isRegressionEligible(r: ActionRunRecord): boolean {
  if (!isReplayable(r) || r.outcome !== 'accepted') return false;
  if (isCodeRound(r)) return !!r.links?.some((l) => l.kind === 'merged');
  return r.verdictAt !== undefined;
}

export interface ReplaySet {
  targets: ActionRunRecord[];
  regression: ActionRunRecord[];
  regressionAvailable: number;
}

export function buildReplaySet(input: {
  citedRunIds: string[];
  cutOnly: boolean;
  runs: ActionRunRecord[];
  spent: ReadonlySet<string>;
}): ReplaySet {
  const byId = new Map(input.runs.map((r) => [r.id, r]));
  const targets = input.cutOnly ? [] : input.citedRunIds
    .map((id) => byId.get(id))
    .filter((r): r is ActionRunRecord => !!r && !input.spent.has(r.id) && isTargetEligible(r))
    .slice(0, MAX_TARGETS);
  const taken = new Set(targets.map((r) => r.id));
  const pool = input.runs
    .filter((r) => !taken.has(r.id) && isRegressionEligible(r))
    .sort((a, b) => b.startedAt - a.startedAt);
  const firstPerRound = new Map<string, ActionRunRecord>();
  for (const r of pool) if (!firstPerRound.has(r.round)) firstPerRound.set(r.round, r);
  const distinct = [...firstPerRound.values()];
  const rest = pool.filter((r) => !distinct.includes(r));
  const regression = [...distinct, ...rest].slice(0, MAX_REGRESSION);
  return { targets, regression, regressionAvailable: regression.length };
}

export function outputsOf(r: ActionRunRecord, blob: (ref: string) => string | undefined): RunOutput[] {
  const raw = r.outputRef ? blob(r.outputRef) : undefined;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as RunOutput[] : [];
  } catch { return []; }
}

function linkLine(l: RunLink, blob: (ref: string) => string | undefined): string {
  switch (l.kind) {
    case 'reviewFindings': return `A fresh-context review of this code found:\n${blob(l.ref) ?? '(review text unavailable)'}`;
    case 'prComments': return `Reviewers then left ${l.comments.length} PR comment(s) (authors: ${[...new Set(l.comments.map((c) => c.author))].join(', ')}).`;
    case 'ciFailed': return `CI then failed${l.headSha ? ` on ${l.headSha.slice(0, 8)}` : ''}.`;
    case 'merged': return `The PR merged: ${l.prUrl}`;
  }
}

const ORIGINAL_CAP = 30_000;

// What the user actually wanted from this run, in words a judge can grade two fresh replays against.
// Quotes the original output, since that's what the user's edit, note or approval was about.
export function answerKeyFor(r: ActionRunRecord, blob: (ref: string) => string | undefined, kind: 'target' | 'regression'): string {
  const original = renderOutputs(outputsOf(r, blob)).slice(0, ORIGINAL_CAP);
  if (kind === 'regression') {
    return `The user approved the original run's output unchanged:\n\n${original}\n\nPrefer whichever of A and B still delivers what the user approved.`;
  }
  const head = `The original run produced:\n\n${original}\n\n`;
  if (r.outcome === 'edited') {
    const diff = r.editDiffRef ? blob(r.editDiffRef) : undefined;
    return `${head}The user approved it only after editing it. Their edit (drafted → approved):\n\n${diff ?? '(diff unavailable)'}`;
  }
  if (r.outcome === 'revised') return `${head}The user sent it back with this note:\n\n${r.feedbackText ?? '(no note)'}`;
  if (r.outcome === 'denied') return `${head}The user denied it with this reason:\n\n${r.feedbackText ?? '(no reason given)'}`;
  if (r.outcome === 'failed' || r.outcome === 'gave_up') return `${head}The round failed: ${r.failureReason ?? '(no reason recorded)'}`;
  if (isCodeRound(r) && r.links?.length) {
    return `${head}What happened to this code afterwards:\n\n${r.links.map((l) => linkLine(l, blob)).join('\n\n')}`;
  }
  return `${head}The user accepted it as drafted.`;
}
