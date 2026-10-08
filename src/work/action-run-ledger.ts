import { createHash } from 'node:crypto';
import type { JobQueue } from './work-queue.js';
import type { JobRecord } from './work-types.js';
import { deriveRunEvents, type RunEvent, type RunKey } from './action-run-derive.js';
import type { ActionRunOutcome, ActionRunRecord, ActionRunsStore, RecordedRead } from '../storage/action-runs-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import { CODE_ROUND_ACTIONS, deriveLinkEvents, type LinkEvent } from './action-run-links.js';
import { resolveVerdictOutcome, type DraftVerdictDetail } from './draft-verdict.js';
import type { RunOutput } from '../eval/run-output.js';

// Observes the job queue and records one run per action round. Wiring is a single
// subscribe in daemon.ts: JobQueue.upsert already broadcasts the full record on every
// engine mutation, so the ledger reads round boundaries out of the state diff rather
// than needing a call at each of the engine's ~20 spawn/settle seams.
//
// Cost and denials accumulate in memory on the open run and are written once, in the
// close patch — a JSONL line per statusline turn would be far too chatty. Losing them
// to a crash is fine: that run reconciles to `interrupted` anyway.

export interface ActionRunLedgerDeps {
  store: ActionRunsStore;
  blobs?: BlobStore;
  skillFor?: (action: string) => string;
  now?: () => number;
  onSettled?: (action: string) => void;
}

const MAX_SNAPSHOT_SESSIONS = 200;

export type RoundSnapshot = Pick<ActionRunRecord, 'envelopeRef' | 'baseSha' | 'worktreePath' | 'gitDir'>;

function keyOf(k: RunKey): string { return `${k.jobId}:${k.stepId ?? '-'}`; }

export class ActionRunLedger {
  private readonly prevByJob = new Map<string, JobRecord>();
  private readonly openByKey = new Map<string, ActionRunRecord>();
  private readonly openBySession = new Map<string, string>();
  private readonly lastCostBySession = new Map<string, number>();
  // Detail for the verdict the very next job mutation derives; never outlives that mutation.
  private readonly verdictStash = new Map<string, DraftVerdictDetail>();
  // A session's latest launch: a round opened mid-turn (a draft) ran under the same envelope
  // and the same SKILL.md, even if the file has changed on disk since. `runIds` are the runs
  // stamped from it, which a git snapshot completing after them still has to reach.
  private readonly lastSnapshot = new Map<string, RoundSnapshot & { skill?: { action: string; sha: string }; seq: number; runIds: string[] }>();
  private launchSeq = 0;
  private readonly modelBySession = new Map<string, string>();
  // Written once in the close patch, like cost — a line per read would be far too chatty.
  private readonly readsByRun = new Map<string, RecordedRead[]>();
  private readonly outputsByRun = new Map<string, RunOutput[]>();
  private readonly now: () => number;

  constructor(private readonly deps: ActionRunLedgerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  attach(queue: JobQueue): void {
    for (const j of queue.list()) this.prevByJob.set(j.id, j);
    queue.subscribe((ev) => {
      try {
        if (ev.kind === 'delete') { this.prevByJob.delete(ev.jobId); return; }
        const prev = this.prevByJob.get(ev.jobId);
        this.prevByJob.set(ev.jobId, ev.job);
        const opts = { now: this.now() };
        for (const e of deriveRunEvents(prev, ev.job, opts)) this.apply(e);
        for (const l of deriveLinkEvents(prev, ev.job, opts.now)) this.applyLink(ev.jobId, l);
        for (const k of [...this.verdictStash.keys()]) if (k.startsWith(`${ev.jobId}:`)) this.verdictStash.delete(k);
      } catch (e) {
        // JobQueue iterates subscribers unguarded — instrumentation must never be
        // able to fail a job.
        console.warn(`[action-runs] observer: ${(e as Error).message}`);
      }
    });
  }

  // Adopts or retires runs left open by a daemon restart. Call once at boot, before
  // anything can mutate a job.
  reconcileAtBoot(jobs: JobRecord[]): void {
    const byJob = new Map(jobs.map((j) => [j.id, j]));
    for (const run of this.deps.store.openRuns()) {
      const job = byJob.get(run.jobId);
      const live = job ? this.stillRunning(job, run) : false;
      if (live) {
        this.openByKey.set(keyOf({ jobId: run.jobId, stepId: run.stepId }), run);
        if (run.sessionId) this.openBySession.set(run.sessionId, keyOf({ jobId: run.jobId, stepId: run.stepId }));
      } else {
        this.settle(run, { outcome: 'interrupted', endedAt: this.now() });
      }
    }
  }

  private stillRunning(job: JobRecord, run: ActionRunRecord): boolean {
    const opts = { now: this.now() };
    const events = deriveRunEvents(undefined, job, opts);
    return events.some((e) =>
      e.t === 'open' && e.round === run.round && (e.key.stepId ?? e.key.jobId) === (run.stepId ?? run.jobId));
  }

  // Called at launch, before the session can submit anything. A worktree's git snapshot is slow, so
  // it follows via completeLaunch; until then the run carries an empty baseSha and isn't replayable.
  beginLaunch(sessionId: string, snap: RoundSnapshot): number {
    const run = this.runForSession(sessionId);
    const sha = run ? this.skillShaOf(run.action) : undefined;
    const seq = ++this.launchSeq;
    const full: RoundSnapshot = snap.worktreePath
      ? { ...snap, baseSha: snap.baseSha ?? '', gitDir: snap.gitDir ?? '' }
      : snap;
    this.lastSnapshot.delete(sessionId);
    this.lastSnapshot.set(sessionId, {
      ...full, seq, runIds: run ? [run.id] : [],
      ...(run && sha ? { skill: { action: run.action, sha } } : {}),
    });
    if (this.lastSnapshot.size > MAX_SNAPSHOT_SESSIONS) {
      this.lastSnapshot.delete(this.lastSnapshot.keys().next().value!);
    }
    if (!run) return seq;
    // A relaunch of a collapsed round: its output must describe the same launch as its envelope.
    if (run.envelopeRef) {
      this.outputsByRun.delete(run.id);
      this.deps.store.patch(run.id, { outputRef: '' });
    }
    this.stampSnapshot(run, full, sha);
    return seq;
  }

  // A superseded launch's snapshot is dropped: its runs have already been restamped by the newer one.
  completeLaunch(sessionId: string, seq: number, git: Required<Pick<RoundSnapshot, 'baseSha' | 'gitDir'>>): void {
    const held = this.lastSnapshot.get(sessionId);
    if (!held || held.seq !== seq) return;
    Object.assign(held, git);
    for (const id of held.runIds) this.deps.store.patch(id, git);
  }

  noteSessionModel(sessionId: string, model: string): void {
    this.modelBySession.delete(sessionId);
    this.modelBySession.set(sessionId, model);
    if (this.modelBySession.size > MAX_SNAPSHOT_SESSIONS) this.modelBySession.delete(this.modelBySession.keys().next().value!);
    const run = this.runForSession(sessionId);
    if (run && run.model !== model) this.deps.store.patch(run.id, { model });
  }

  private skillShaOf(action: string): string | undefined {
    const skill = this.deps.skillFor?.(action);
    return skill ? createHash('sha256').update(skill).digest('hex') : undefined;
  }

  private stampSnapshot(run: ActionRunRecord, snap: RoundSnapshot, skillSha: string | undefined): void {
    this.deps.store.patch(run.id, { ...snap, ...(skillSha ? { skillSha } : {}) });
  }

  noteRead(sessionId: string, read: RecordedRead): void {
    const run = this.runForSession(sessionId);
    if (!run) return;
    const reads = this.readsByRun.get(run.id) ?? [];
    if (reads.some((r) => r.inputKey === read.inputKey)) return;
    reads.push(read);
    this.readsByRun.set(run.id, reads);
  }

  openRunId(jobId: string, stepId?: string): string | undefined {
    return this.openByKey.get(keyOf({ jobId, stepId }))?.id;
  }

  // Patched on every submit rather than at close: a draft round is ruled on long after it ends.
  noteOutput(runId: string, out: RunOutput): void {
    if (!this.deps.store.get(runId)) return;
    const outs = [...(this.outputsByRun.get(runId) ?? []), out];
    this.outputsByRun.set(runId, outs);
    if (this.outputsByRun.size > MAX_SNAPSHOT_SESSIONS) this.outputsByRun.delete(this.outputsByRun.keys().next().value!);
    const ref = this.deps.blobs?.put(JSON.stringify(outs));
    if (ref) this.deps.store.patch(runId, { outputRef: ref });
  }

  noteVerdict(jobId: string, stepId: string, detail: DraftVerdictDetail): void {
    this.verdictStash.set(keyOf({ jobId, stepId }), detail);
  }

  noteSessionCost(sessionId: string, cumulativeUsd: number): void {
    if (!Number.isFinite(cumulativeUsd)) return;
    const prev = this.lastCostBySession.get(sessionId);
    // A cumulative counter that went backwards means the session id was reused
    // (a /clear, or a respawn) — treat the new value as a fresh baseline.
    const delta = prev !== undefined && cumulativeUsd >= prev ? cumulativeUsd - prev : cumulativeUsd;
    this.lastCostBySession.set(sessionId, cumulativeUsd);
    if (delta <= 0) return;
    const run = this.runForSession(sessionId);
    if (run) run.costUsd = (run.costUsd ?? 0) + delta;
  }

  noteDenial(sessionId: string): string | undefined {
    const run = this.runForSession(sessionId);
    if (!run) return undefined;
    run.denials = (run.denials ?? 0) + 1;
    return run.id;
  }

  // Runs that aren't job-backed — the meta.build-action edit sessions the routes
  // spawn directly, which the queue observer can't see.
  openExternal(input: { action: string; round: string; sessionId: string }): void {
    this.open({
      t: 'open',
      key: { jobId: `action-edit:${input.sessionId}` },
      action: input.action,
      round: input.round,
      sessionId: input.sessionId,
      at: this.now(),
    });
  }

  closeExternal(sessionId: string, outcome: ActionRunOutcome): void {
    const run = this.runForSession(sessionId);
    if (!run) return;
    this.apply({ t: 'close', key: { jobId: run.jobId, stepId: run.stepId }, outcome, at: this.now() });
  }

  verdictExternal(sessionId: string, outcome: ActionRunOutcome): void {
    const key = { jobId: `action-edit:${sessionId}` };
    this.apply({ t: 'verdict', key, outcome, at: this.now() });
  }

  private runForSession(sessionId: string): ActionRunRecord | undefined {
    const key = this.openBySession.get(sessionId);
    return key ? this.openByKey.get(key) : undefined;
  }

  private apply(e: RunEvent): void {
    if (e.t === 'open') { this.open(e); return; }
    if (e.t === 'close') {
      const run = this.openByKey.get(keyOf(e.key));
      if (!run) return;
      this.settle(run, {
        outcome: e.outcome,
        endedAt: e.at,
        durationMs: Math.max(0, e.at - run.startedAt),
        ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
        ...(run.denials !== undefined ? { denials: run.denials } : {}),
        ...(e.failureReason ? { failureReason: e.failureReason } : {}),
        ...(this.readsByRun.get(run.id)?.length ? { reads: this.readsByRun.get(run.id) } : {}),
      });
      return;
    }
    const scopeId = e.key.stepId ?? e.key.jobId;
    const target = this.deps.store.latestFor(scopeId, e.round);
    if (!target) return;
    const detail = this.verdictStash.get(keyOf(e.key));
    this.verdictStash.delete(keyOf(e.key));
    const diffRef = detail?.edit ? this.deps.blobs?.put(detail.edit.diff) : undefined;
    this.deps.store.patch(target.id, {
      outcome: resolveVerdictOutcome(e.outcome, detail),
      verdictAt: e.at,
      ...(e.feedbackChars !== undefined ? { feedbackChars: e.feedbackChars } : {}),
      ...(detail?.feedbackText ? { feedbackText: detail.feedbackText } : {}),
      ...(detail?.edit ? { editChars: detail.edit.chars } : {}),
      ...(diffRef ? { editDiffRef: diffRef } : {}),
    });
    this.deps.onSettled?.(target.action);
  }

  private applyLink(jobId: string, e: LinkEvent): void {
    const rows = this.deps.store.runsForStep(jobId, e.stepId).filter((r) => CODE_ROUND_ACTIONS.has(r.action));
    const link = e.link.kind === 'reviewFindings' ? { ...e.link, ref: this.deps.blobs?.put(e.link.ref) ?? '' } : e.link;
    if (link.kind === 'reviewFindings' && !link.ref) return;
    for (const r of e.all ? rows : rows.slice(0, 1)) this.deps.store.patch(r.id, { links: [...(r.links ?? []), link] });
  }

  private open(e: Extract<RunEvent, { t: 'open' }>): void {
    const key = keyOf(e.key);
    if (this.openByKey.has(key)) return;
    const scopeId = e.key.stepId ?? e.key.jobId;
    const run = this.deps.store.open({
      action: e.action,
      round: e.round,
      attempt: 1 + this.deps.store.attemptsFor(scopeId, e.round),
      jobId: e.key.jobId,
      stepId: e.key.stepId,
      sessionId: e.sessionId,
      startedAt: e.at,
    });
    this.openByKey.set(key, run);
    if (e.sessionId) this.openBySession.set(e.sessionId, key);
    const held = e.sessionId ? this.lastSnapshot.get(e.sessionId) : undefined;
    if (held) {
      const { skill, seq: _seq, runIds, ...snap } = held;
      this.stampSnapshot(run, snap, skill?.action === e.action ? skill.sha : this.skillShaOf(e.action));
      runIds.push(run.id);
    }
    const model = e.sessionId ? this.modelBySession.get(e.sessionId) : undefined;
    if (model) this.deps.store.patch(run.id, { model });
  }

  private settle(run: ActionRunRecord, fields: Partial<ActionRunRecord>): void {
    this.deps.store.patch(run.id, fields);
    const key = keyOf({ jobId: run.jobId, stepId: run.stepId });
    this.openByKey.delete(key);
    this.readsByRun.delete(run.id);
    if (run.sessionId) this.openBySession.delete(run.sessionId);
    this.deps.onSettled?.(run.action);
  }
}
