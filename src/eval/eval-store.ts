import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionProposal } from '../storage/action-edits-store.js';
import type { Comparison, EvalOutcome } from './eval-verdict.js';

export type UserVerdict = 'approved' | 'rejected';

export interface EvalReplayRecord {
  runId: string;
  kind: 'target' | 'regression';
  valid: boolean;
  misses: number;
  costUsd: number;
  result?: Comparison;
  judgeReasons?: string[];
  error?: string;
}

export type EvalProposal = Pick<ActionProposal, 'skillMdBefore' | 'skillMdAfter' | 'citedRunIds' | 'cutOnly' | 'postedAt'>;

export interface EvalRecord {
  id: string;
  action: string;
  editSessionId: string;
  postedAt: number;
  // Kept so an eval interrupted by a restart can resume after its review card is gone.
  proposal: EvalProposal;
  startedAt: number;
  endedAt?: number;
  outcome?: EvalOutcome;
  reasons: string[];
  spentUsd: number;
  tokensBefore: number;
  tokensAfter: number;
  replays: EvalReplayRecord[];
  // Shadow mode: did the eval agree with the user who reviewed the same proposal?
  userVerdict?: UserVerdict;
  agreed?: boolean;
}

function scored(r: EvalRecord): EvalRecord {
  if (!r.outcome || !r.userVerdict) return r;
  return { ...r, agreed: (r.outcome === 'pass') === (r.userVerdict === 'approved') };
}

// One file per eval under <runtime>/evals, written by atomic rename like every other index here.
export class EvalStore {
  private readonly byId = new Map<string, EvalRecord>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as EvalRecord;
        if (r?.id) this.byId.set(r.id, r);
      } catch { /* a torn file is one lost eval, not a failed boot */ }
    }
  }

  // The user's verdict is only ever written by noteUserVerdict, so a caller's stale copy can't drop it.
  save(record: EvalRecord): EvalRecord {
    const userVerdict = record.userVerdict ?? this.byId.get(record.id)?.userVerdict;
    const next = scored(userVerdict ? { ...record, userVerdict } : record);
    const path = join(this.dir, `${next.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    this.byId.set(next.id, next);
    return next;
  }

  get(id: string): EvalRecord | undefined { return this.byId.get(id); }

  forEdit(editSessionId: string, postedAt: number): EvalRecord | undefined {
    return [...this.byId.values()].find((r) => r.editSessionId === editSessionId && r.postedAt === postedAt);
  }

  noteUserVerdict(editSessionId: string, postedAt: number, verdict: UserVerdict): EvalRecord | undefined {
    const r = this.forEdit(editSessionId, postedAt);
    return r ? this.save({ ...r, userVerdict: verdict }) : undefined;
  }

  pending(): EvalRecord[] {
    return [...this.byId.values()].filter((r) => !r.outcome);
  }

  all(): EvalRecord[] {
    return [...this.byId.values()];
  }

  list(action: string): EvalRecord[] {
    return [...this.byId.values()].filter((r) => r.action === action).sort((a, b) => b.startedAt - a.startedAt);
  }
}
