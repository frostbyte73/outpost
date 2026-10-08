import { randomUUID } from 'node:crypto';
import { DEFAULT_TOKEN_CEILING, NO_AUTO_APPLY } from '../actions/improvement-pack.js';
import { approxTokens } from '../actions/tokens.js';
import type { ActionProposal } from '../storage/action-edits-store.js';
import type { ActionRevisionsStore } from '../storage/action-revisions-store.js';
import type { ActionRunRecord } from '../storage/action-runs-store.js';
import type { EvalProposal, EvalRecord, EvalReplayRecord, EvalStore } from './eval-store.js';
import { DEFAULT_EVAL_CAP_USD, evalVerdict, type Comparison } from './eval-verdict.js';
import { judgePair, type JudgeOnce } from './judge.js';
import { answerKeyFor, buildReplaySet, outputsOf } from './replay-set.js';
import type { ReplayResult } from './replay-runner.js';
import { renderOutputs } from './run-output.js';

export interface RunEvalDeps {
  runs: (action: string) => ActionRunRecord[];
  spent: (action: string) => ReadonlySet<string>;
  blob: (ref: string) => string | undefined;
  replay: (run: ActionRunRecord, candidateSkillMd: string, evalId: string, budgetUsd: number) => Promise<ReplayResult>;
  judge: JudgeOnce;
  store: EvalStore;
  revisions: Pick<ActionRevisionsStore, 'record'>;
  capUsd?: number;
  now?: () => number;
}

// Held back from each replay's budget for the two judge calls that follow it.
const JUDGE_RESERVE_USD = 0.6;
// Below this a replay can't get past reading its envelope; stopping beats a guaranteed invalid run.
const MIN_REPLAY_BUDGET_USD = 0.25;

export function newEvalRecord(
  input: { action: string; editSessionId: string; proposal: ActionProposal },
  id: string = randomUUID(),
  now: number = Date.now(),
): EvalRecord {
  const { skillMdBefore, skillMdAfter, citedRunIds, cutOnly, postedAt } = input.proposal;
  const proposal: EvalProposal = { skillMdBefore, skillMdAfter, postedAt, ...(citedRunIds ? { citedRunIds } : {}), ...(cutOnly ? { cutOnly } : {}) };
  return {
    id,
    action: input.action,
    editSessionId: input.editSessionId,
    postedAt,
    proposal,
    startedAt: now,
    reasons: [],
    spentUsd: 0,
    tokensBefore: approxTokens(skillMdBefore),
    tokensAfter: approxTokens(skillMdAfter),
    replays: [],
  };
}

// Replays, judges and grades one improver proposal, from scratch even if a previous attempt was cut
// short. Shadow mode: the verdict is recorded, never acted on.
export async function runEval(start: EvalRecord, deps: RunEvalDeps): Promise<EvalRecord> {
  const now = deps.now ?? (() => Date.now());
  const cap = deps.capUsd ?? DEFAULT_EVAL_CAP_USD;
  const { action, proposal } = start;
  const set = buildReplaySet({
    citedRunIds: proposal.citedRunIds ?? [],
    cutOnly: proposal.cutOnly === true,
    runs: deps.runs(action),
    spent: deps.spent(action),
  });
  let record = deps.store.save({ ...start, startedAt: now(), spentUsd: 0, replays: [], reasons: [] });

  const plan = [
    ...set.targets.map((run) => ({ run, kind: 'target' as const })),
    ...set.regression.map((run) => ({ run, kind: 'regression' as const })),
  ];
  for (const { run, kind } of plan) {
    const budget = cap - record.spentUsd - JUDGE_RESERVE_USD;
    if (budget < MIN_REPLAY_BUDGET_USD) break;
    const r = await deps.replay(run, proposal.skillMdAfter, record.id, budget);
    const entry: EvalReplayRecord = {
      runId: run.id, kind, valid: r.valid, misses: r.misses, costUsd: r.costUsd, ...(r.error ? { error: r.error } : {}),
    };
    let spent = record.spentUsd + r.costUsd;
    if (r.valid) {
      try {
        const verdict = await judgePair(deps.judge, {
          context: deps.blob(run.envelopeRef!) ?? '',
          answerKey: answerKeyFor(run, deps.blob, kind),
          before: renderOutputs(outputsOf(run, deps.blob)),
          after: renderOutputs(r.output),
        });
        entry.result = verdict.result;
        entry.judgeReasons = verdict.reasons;
        spent += verdict.costUsd;
      } catch (e) {
        entry.valid = false;
        entry.error = `judge failed: ${(e as Error).message}`;
      }
    }
    record = deps.store.save({ ...record, spentUsd: spent, replays: [...record.replays, entry] });
  }

  const judged = (kind: 'target' | 'regression'): Comparison[] =>
    record.replays.filter((r) => r.kind === kind && r.valid && r.result).map((r) => r.result!);
  const verdict = evalVerdict({
    action,
    cutOnly: proposal.cutOnly === true,
    targets: judged('target'),
    regression: judged('regression'),
    regressionAvailable: set.regressionAvailable,
    tokensBefore: record.tokensBefore,
    tokensAfter: record.tokensAfter,
    ceiling: NO_AUTO_APPLY.has(action) ? null : DEFAULT_TOKEN_CEILING,
    spentUsd: record.spentUsd,
    capUsd: cap,
  });
  record = deps.store.save({ ...record, outcome: verdict.outcome, reasons: verdict.reasons, endedAt: now() });
  deps.revisions.record({
    action,
    kind: 'evaluated',
    author: 'system',
    rationale: `${verdict.outcome}: ${verdict.reasons.join('; ')}`,
    sessionId: start.editSessionId,
    evalId: record.id,
  });
  return record;
}

// Evals spend real money and share the scratch root, so they run one at a time — and none before
// start(), since a replay launched before the hook server listens would run its tools ungated.
export class EvalQueue {
  private open!: () => void;
  private tail: Promise<void> = new Promise((resolve) => { this.open = resolve; });

  start(): void { this.open(); }

  enqueue(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch((e) => console.warn(`[eval] ${(e as Error).message}`));
  }
}
