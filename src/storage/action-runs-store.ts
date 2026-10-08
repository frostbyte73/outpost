import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Per-action, per-round run ledger — the objective counterpart to JournalStore's
// self-reported lessons. One record per round of one action (code.spec attempt 2,
// the ci-fix round, the orchestrator's replan), carrying what actually happened
// rather than what the session claimed.
//
// Written as two line kinds so a record can be completed long after it is opened:
// the full record lands at round *open* (durable across a daemon bounce — an
// unclosed row reconciles to `interrupted` at boot), then `patch` lines fold onto
// it by id when the round closes and again when a gate finally rules on it. Gate
// verdicts can arrive days later, which is why this can't be a single append.
//
// Separate from runs.jsonl on purpose: that ledger is one row per job with a CSV
// export and live PWA consumers, and per-round rows are an order of magnitude more
// numerous. Mixing granularities would force every existing consumer to filter.

export type ActionRunOutcome =
  | 'submitted'
  | 'accepted'
  // Approved by a user pre-approval, not by the user looking at it — never a success or a denial.
  | 'auto-accepted'
  | 'revised'
  | 'denied'
  | 'merged'
  | 'abandoned'
  | 'failed'
  | 'gave_up'
  | 'interrupted'
  // Approved, but only after the user changed the payload.
  | 'edited'
  // Ruled on after the world moved under the draft — evidence neither way.
  | 'superseded';

// Outcomes a gate (or the PR) has actually ruled on. A run still sitting at
// `submitted` is pending, and stays out of every rate's denominator.
export const ADJUDICATED_OUTCOMES: ReadonlySet<ActionRunOutcome> = new Set<ActionRunOutcome>([
  'accepted', 'edited', 'revised', 'denied', 'merged', 'abandoned', 'failed', 'gave_up',
]);

export interface RecordedRead { tool: string; inputKey: string; responseRef: string }

export type RunLink =
  | { kind: 'reviewFindings'; at: number; ref: string }
  | { kind: 'prComments'; at: number; comments: Array<{ id: string; author: string }> }
  | { kind: 'ciFailed'; at: number; headSha?: string }
  | { kind: 'merged'; at: number; prUrl: string };

export interface ActionRunRecord {
  id: string;
  action: string;
  round: string;
  attempt: number;
  jobId: string;
  stepId?: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  costUsd?: number;
  outcome?: ActionRunOutcome;
  verdictAt?: number;
  feedbackChars?: number;
  failureReason?: string;
  denials?: number;
  feedbackText?: string;
  editChars?: number;
  editDiffRef?: string;
  // Replay snapshot: blob refs (see BlobStore), the worktree HEAD, and the SKILL.md it ran under.
  envelopeRef?: string;
  baseSha?: string;
  skillSha?: string;
  worktreePath?: string;
  gitDir?: string;
  reads?: RecordedRead[];
  links?: RunLink[];
  // Everything the round submitted (see RunOutput) — what the user actually ruled on.
  outputRef?: string;
  // The model id the session reported; a replay runs on the same one.
  model?: string;
}

type Line =
  | ({ t: 'run' } & ActionRunRecord)
  | ({ t: 'patch'; id: string } & Partial<ActionRunRecord>);

const MAX_RUN_ENTRIES = 50_000;
const MAX_RUN_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function appendJsonLine(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 });
}

export class ActionRunsStore {
  private byId = new Map<string, ActionRunRecord>();
  private index: ActionRunRecord[] = []; // newest-first

  constructor(
    private readonly path: string,
    private readonly newId: () => string = () => randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries: number = MAX_RUN_ENTRIES,
    private readonly maxAgeMs: number = MAX_RUN_AGE_MS,
  ) {
    if (!existsSync(path)) return;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      if (!raw) continue;
      let line: Line;
      try { line = JSON.parse(raw) as Line; } catch { continue; }
      if (line.t === 'run') {
        const { t: _t, ...rec } = line;
        this.byId.set(rec.id, rec);
      } else if (line.t === 'patch') {
        const cur = this.byId.get(line.id);
        // A patch whose base was trimmed by a past retention pass has nothing to
        // fold onto — drop it rather than resurrecting a partial record.
        if (!cur) continue;
        const { t: _t, id: _id, ...fields } = line;
        Object.assign(cur, fields);
      }
    }
    this.reindex();
  }

  private reindex(): void {
    const rows = [...this.byId.values()].sort((a, b) => b.startedAt - a.startedAt);
    const cutoff = this.now() - this.maxAgeMs;
    this.index = rows.filter((r) => r.startedAt >= cutoff).slice(0, this.maxEntries);
    const kept = new Set(this.index.map((r) => r.id));
    for (const id of this.byId.keys()) if (!kept.has(id)) this.byId.delete(id);
  }

  open(input: Omit<ActionRunRecord, 'id'> & { id?: string }): ActionRunRecord {
    const record: ActionRunRecord = { ...input, id: input.id ?? this.newId() };
    appendJsonLine(this.path, { t: 'run', ...record });
    this.byId.set(record.id, record);
    this.reindex();
    return record;
  }

  patch(id: string, fields: Partial<ActionRunRecord>): ActionRunRecord | undefined {
    const cur = this.byId.get(id);
    if (!cur) return undefined;
    appendJsonLine(this.path, { t: 'patch', id, ...fields });
    Object.assign(cur, fields);
    return cur;
  }

  get(id: string): ActionRunRecord | undefined { return this.byId.get(id); }

  listByAction(action: string, opts: { sinceMs?: number; limit?: number } = {}): ActionRunRecord[] {
    let rows = this.index.filter((r) => r.action === action);
    if (opts.sinceMs !== undefined) rows = rows.filter((r) => r.startedAt >= opts.sinceMs!);
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  // Runs already recorded for a (step-or-job, round) pair. The ledger adds one to
  // get the next attempt number, which is what makes "approved first try" countable.
  attemptsFor(scopeId: string, round: string): number {
    return this.index.filter((r) => (r.stepId ?? r.jobId) === scopeId && r.round === round).length;
  }

  // `round` omitted resolves the scope's newest run whatever its round — the
  // orchestrator's round name varies (initial/replan/step-review) and a plan gate
  // rules on whichever one posted the plan.
  latestFor(scopeId: string, round?: string): ActionRunRecord | undefined {
    return this.index.find((r) => (r.stepId ?? r.jobId) === scopeId && (round === undefined || r.round === round));
  }

  // Newest first.
  runsForStep(jobId: string, stepId: string): ActionRunRecord[] {
    return this.index.filter((r) => r.jobId === jobId && r.stepId === stepId);
  }

  referencedBlobs(): Set<string> {
    const refs = new Set<string>();
    for (const r of this.index) {
      if (r.envelopeRef) refs.add(r.envelopeRef);
      if (r.editDiffRef) refs.add(r.editDiffRef);
      if (r.outputRef) refs.add(r.outputRef);
      for (const read of r.reads ?? []) refs.add(read.responseRef);
      for (const l of r.links ?? []) if (l.kind === 'reviewFindings') refs.add(l.ref);
    }
    return refs;
  }

  // Retained runs' worktree snapshots, grouped by the repo that holds them.
  snapshotsByRepo(): Map<string, Set<string>> {
    const byRepo = new Map<string, Set<string>>();
    for (const r of this.index) {
      if (!r.baseSha || !r.gitDir) continue;
      const shas = byRepo.get(r.gitDir) ?? new Set<string>();
      shas.add(r.baseSha);
      byRepo.set(r.gitDir, shas);
    }
    return byRepo;
  }

  // The snapshot is gone from git, so the run can no longer be replayed — isReplayable reads an empty baseSha that way.
  forgetSnapshots(gitDir: string, shas: ReadonlySet<string>): number {
    const lost = this.index.filter((r) => r.gitDir === gitDir && r.baseSha && shas.has(r.baseSha));
    for (const r of lost) this.patch(r.id, { baseSha: '' });
    return lost.length;
  }

  openRuns(): ActionRunRecord[] {
    return this.index.filter((r) => r.endedAt === undefined);
  }
}
