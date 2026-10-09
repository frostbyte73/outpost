import { randomUUID } from 'node:crypto';
import { DEFAULT_TOKEN_CEILING, NO_AUTO_APPLY } from '../actions/improvement-pack.js';
import { approxTokens } from '../actions/tokens.js';
import type { ActionProposal } from '../storage/action-edits-store.js';
import type { ActionRevisionsStore } from '../storage/action-revisions-store.js';
import type { ActionRunRecord } from '../storage/action-runs-store.js';
import { BaselineCache, type EvalProposal, type EvalRecord, type EvalReplayRecord, type EvalStore } from './eval-store.js';
import { DEFAULT_EVAL_CAP_USD, evalVerdict, type Comparison } from './eval-verdict.js';
import { judgePair, type JudgeOnce } from './judge.js';
import { answerKeyFor, buildReplaySet } from './replay-set.js';
import type { ReplayResult } from './replay-runner.js';
import { renderOutputs } from './run-output.js';

export interface RunEvalDeps {
  runs: (action: string) => ActionRunRecord[];
  spent: (action: string) => ReadonlySet<string>;
  blob: (ref: string) => string | undefined;
  replay: (run: ActionRunRecord, skillMd: string, evalId: string, budgetUsd: number, signal?: AbortSignal) => Promise<ReplayResult>;
  judge: JudgeOnce;
  store: EvalStore;
  baselines?: Pick<BaselineCache, 'get' | 'put'>;
  revisions: Pick<ActionRevisionsStore, 'record'>;
  capUsd?: number;
  now?: () => number;
}

// Held back from each replay's budget for the two judge calls that follow it.
const JUDGE_RESERVE_USD = 0.6;
// Below this a replay can't get past reading its envelope; stopping beats a guaranteed invalid run.
const MIN_REPLAY_BUDGET_USD = 0.25;
// A replay may cost a few times what the live round did, never the whole cap on one runaway.
const LIVE_COST_HEADROOM = 3;
const MIN_REPLAY_CEILING_USD = 1;

export const SUPERSEDED_REASON = 'superseded by a newer proposal before it finished';

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

function replayCeiling(run: ActionRunRecord): number {
  return run.costUsd ? Math.max(MIN_REPLAY_CEILING_USD, run.costUsd * LIVE_COST_HEADROOM) : Infinity;
}

function rendered(r: Pick<ReplayResult, 'output' | 'stopped'>): string {
  const body = renderOutputs(r.output);
  return r.stopped ? `${body}\n\n(This run hit its replay limit — ${r.stopped} — before it finished.)` : body;
}

// Replays one run under both bodies, so the judge compares like with like: two fresh runs, same
// model, same recorded reads, same budget — never a fresh run against the verbatim original.
async function replayPair(
  run: ActionRunRecord,
  kind: 'target' | 'regression',
  proposal: EvalProposal,
  record: EvalRecord,
  budget: number,
  deps: RunEvalDeps,
  signal: AbortSignal | undefined,
): Promise<{ entry: EvalReplayRecord; costUsd: number }> {
  const key = BaselineCache.key(run.id, proposal.skillMdBefore, run.model);
  const cachedOutput = deps.baselines?.get(key);
  const base: EvalReplayRecord = { runId: run.id, kind, valid: false, misses: 0, costUsd: 0 };
  let baseline: ReplayResult;
  if (cachedOutput) {
    baseline = { valid: true, misses: 0, costUsd: 0, output: cachedOutput };
    base.baselineCached = true;
  } else {
    baseline = await deps.replay(run, proposal.skillMdBefore, record.id, budget, signal);
    base.costUsd = baseline.costUsd;
    if (!baseline.valid) return { entry: { ...base, misses: baseline.misses, error: `current body: ${baseline.error ?? `${baseline.misses} unrecorded reads`}` }, costUsd: baseline.costUsd };
    // A stopped run's output depends on the budget it happened to get, so it isn't a reusable baseline.
    if (!baseline.stopped) deps.baselines?.put(key, baseline.output);
  }
  if (signal?.aborted) return { entry: { ...base, error: SUPERSEDED_REASON }, costUsd: base.costUsd };

  const candidate = await deps.replay(run, proposal.skillMdAfter, record.id, budget, signal);
  const entry: EvalReplayRecord = {
    ...base, valid: candidate.valid, misses: candidate.misses, costUsd: base.costUsd + candidate.costUsd,
    ...(candidate.error ? { error: candidate.error } : {}),
  };
  let costUsd = entry.costUsd;
  if (!candidate.valid) return { entry, costUsd };
  if (baseline.stopped && candidate.stopped) {
    return { entry: { ...entry, valid: false, error: 'both bodies hit the replay limit before finishing' }, costUsd };
  }
  try {
    const verdict = await judgePair(deps.judge, {
      context: deps.blob(run.envelopeRef!) ?? '',
      answerKey: answerKeyFor(run, deps.blob, kind),
      before: rendered(baseline),
      after: rendered(candidate),
    });
    entry.result = verdict.result;
    entry.judgeReasons = verdict.reasons;
    costUsd += verdict.costUsd;
  } catch (e) {
    entry.valid = false;
    entry.error = `judge failed: ${(e as Error).message}`;
  }
  return { entry, costUsd };
}

export interface EvalSignals {
  // The proposal was redrafted: settle inconclusive, nothing left to grade.
  supersede?: AbortSignal;
  // The daemon is going down: leave the record pending so the next start re-runs it.
  halt?: AbortSignal;
}

// Replays, judges and grades one improver proposal, from scratch even if a previous attempt was cut short.
export async function runEval(start: EvalRecord, deps: RunEvalDeps, signals: EvalSignals = {}): Promise<EvalRecord> {
  const { supersede, halt } = signals;
  const live = [supersede, halt].filter((x): x is AbortSignal => !!x);
  const signal = live.length ? AbortSignal.any(live) : undefined;
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
    if (signal?.aborted) break;
    const sides = deps.baselines?.get(BaselineCache.key(run.id, proposal.skillMdBefore, run.model)) ? 1 : 2;
    const budget = Math.min((cap - record.spentUsd - JUDGE_RESERVE_USD) / sides, replayCeiling(run));
    if (budget < MIN_REPLAY_BUDGET_USD) break;
    const { entry, costUsd } = await replayPair(run, kind, proposal, record, budget, deps, signal);
    if (halt?.aborted) return record;
    record = deps.store.save({ ...record, spentUsd: record.spentUsd + costUsd, replays: [...record.replays, entry] });
  }

  if (halt?.aborted) return record;
  if (supersede?.aborted) {
    record = deps.store.save({ ...record, outcome: 'inconclusive', reasons: [SUPERSEDED_REASON], endedAt: now() });
    return record;
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
  private queued = 0;

  start(): void { this.open(); }

  get pending(): number { return this.queued; }

  enqueue(job: () => Promise<void>): void {
    this.queued++;
    this.tail = this.tail.then(job).catch((e) => console.warn(`[eval] ${(e as Error).message}`))
      .finally(() => { this.queued--; });
  }
}
