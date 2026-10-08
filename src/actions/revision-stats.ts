import { BODY_CHANGING, type ActionEvent } from '../storage/action-revisions-store.js';
import { ADJUDICATED_OUTCOMES, type ActionRunOutcome, type ActionRunRecord } from '../storage/action-runs-store.js';

// Per-revision attribution for an action's SKILL.md. A run belongs to a revision only if it ran
// that exact body (skillSha === bodySha) and started while that revision was head, so a body that
// returns via revert opens a fresh window rather than inheriting its old score.

const REGRESSION_MIN_RUNS = 8;
const BASELINE_MIN_RUNS = 5;
const BASELINE_MAX_RUNS = 20;
const REGRESSION_DROP = 0.15;

// Outcomes where the user looked at a payload and ruled on it; failures say nothing about wording.
const VERBATIM_DENOMINATOR: ReadonlySet<ActionRunOutcome> = new Set<ActionRunOutcome>([
  'accepted', 'edited', 'revised', 'denied',
]);

export interface RevisionWindow {
  event: ActionEvent;
  end: number | null;
  runs: ActionRunRecord[];
}

export interface RevisionStat {
  eventId: string;
  kind: ActionEvent['kind'];
  author: ActionEvent['author'];
  at: number;
  rationale?: string;
  tokens: number | null;
  tokenDelta: number | null;
  runs: number;
  adjudicated: number;
  verbatimRate: number | null;
  failureRate: number | null;
  avgCostUsd: number | null;
}

export type RegressionVerdict =
  | { regressed: false }
  | { regressed: true; restoreEventId: string; regressedEventId: string; before: number; after: number };

function chainOf(events: ActionEvent[]): ActionEvent[] {
  return events.filter((e) => BODY_CHANGING.has(e.kind) && e.bodySha).sort((a, b) => a.at - b.at);
}

export function revisionWindows(events: ActionEvent[], runs: ActionRunRecord[]): RevisionWindow[] {
  const chain = chainOf(events);
  const windows: RevisionWindow[] = [];
  chain.forEach((event, i) => {
    if (event.kind === 'deleted') return;
    const end = chain[i + 1]?.at ?? null;
    // Genesis and drift are stamped at the next write, long after that body started running.
    const start = event.kind === 'created' || event.kind === 'drifted' ? (chain[i - 1]?.at ?? -Infinity) : event.at;
    windows.push({
      event,
      end,
      runs: runs.filter((r) =>
        r.skillSha === event.bodySha && r.startedAt >= start && (end === null || r.startedAt < end)),
    });
  });
  return windows;
}

function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

// verdictAt, not just the outcome: a round with no gate closes `accepted` with nobody having looked.
function verbatimRuns(runs: ActionRunRecord[]): ActionRunRecord[] {
  return runs.filter((r) => r.verdictAt !== undefined && r.outcome && VERBATIM_DENOMINATOR.has(r.outcome));
}

function verbatimRate(runs: ActionRunRecord[]): number | null {
  return rate(runs.filter((r) => r.outcome === 'accepted').length, runs.length);
}

// bodyBytes rather than the body: the store GCs old bodies but keeps their metadata.
function tokensOf(e: ActionEvent): number | null {
  return e.bodyBytes !== undefined ? Math.ceil(e.bodyBytes / 4) : null;
}

export function buildRevisionStats(events: ActionEvent[], runs: ActionRunRecord[]): RevisionStat[] {
  const windows = revisionWindows(events, runs);
  return windows.map((w, i) => {
    const judged = verbatimRuns(w.runs);
    const adjudicated = w.runs.filter((r) => r.outcome && ADJUDICATED_OUTCOMES.has(r.outcome));
    const costs = w.runs.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
    const tokens = tokensOf(w.event);
    const prevTokens = i > 0 ? tokensOf(windows[i - 1]!.event) : null;
    return {
      eventId: w.event.id,
      kind: w.event.kind,
      author: w.event.author,
      at: w.event.at,
      ...(w.event.rationale ? { rationale: w.event.rationale } : {}),
      tokens,
      tokenDelta: tokens !== null && prevTokens !== null ? tokens - prevTokens : null,
      runs: w.runs.length,
      adjudicated: judged.length,
      verbatimRate: verbatimRate(judged),
      failureRate: rate(
        adjudicated.filter((r) => r.outcome === 'failed' || r.outcome === 'gave_up').length, adjudicated.length),
      avgCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
    };
  }).reverse();
}

export function regressionVerdict(events: ActionEvent[], runs: ActionRunRecord[]): RegressionVerdict {
  const windows = revisionWindows(events, runs);
  const head = windows[windows.length - 1];
  const prev = windows[windows.length - 2];
  if (!head || !prev || head.end !== null) return { regressed: false };
  if (head.event.kind !== 'applied' || head.event.author !== 'improver') return { regressed: false };
  // The first N, not a rolling window: once those settle the verdict stops moving.
  const judged = verbatimRuns(head.runs).sort((a, b) => a.startedAt - b.startedAt).slice(0, REGRESSION_MIN_RUNS);
  const baseline = verbatimRuns(prev.runs).sort((a, b) => b.startedAt - a.startedAt).slice(0, BASELINE_MAX_RUNS);
  if (judged.length < REGRESSION_MIN_RUNS || baseline.length < BASELINE_MIN_RUNS) return { regressed: false };
  const after = verbatimRate(judged)!;
  const before = verbatimRate(baseline)!;
  return before - after > REGRESSION_DROP
    ? { regressed: true, restoreEventId: prev.event.id, regressedEventId: head.event.id, before, after }
    : { regressed: false };
}

// Runs an improver revision cited, where that revision was then reverted: that evidence already
// bought one edit that didn't hold.
export function spentRunIds(events: ActionEvent[]): Set<string> {
  const chain = chainOf(events);
  const spent = new Set<string>();
  chain.forEach((e, i) => {
    if (e.author !== 'improver' || e.kind !== 'applied' || chain[i + 1]?.kind !== 'reverted') return;
    for (const id of e.citedRunIds ?? []) spent.add(id);
  });
  return spent;
}
