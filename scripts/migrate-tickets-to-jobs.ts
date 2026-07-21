// One-off migration. Reads the legacy TicketRecord[] from `~/.outpost/work/queue.json`
// and writes one JobRecord file per ticket under `~/.outpost/jobs/<id>.json`. Idempotent:
// skips a ticket if the destination already exists. Leaves the source queue.json in place.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JobRecord, JobState, OpenPrStep, Step } from '../src/work-types.js';

const STATE_MAP: Record<string, JobState> = {
  merged: 'done',
  abandoned: 'abandoned',
  investigation_failed: 'failed',
};

function stepId(ticketId: string, projectCwd: string): string {
  return createHash('sha256').update(`${ticketId}::${projectCwd}`).digest('hex').slice(0, 8);
}

interface LegacyTicket {
  ticketId: string;
  linearUuid: string;
  url: string;
  title: string;
  state: string;
  repos: Record<string, LegacyRepo>;
  investigatorSessionId?: string;
  planIterations?: Array<{ id: string; plan: Array<{ projectCwd: string; goal: string; approach: string; risks?: string }>; feedback: string; rejectedAt: number }>;
  linearCommentId?: string;
  linearStateMarked?: { inProgress?: boolean; inReview?: boolean; done?: boolean };
  events?: Array<{ id: string; at: number; kind: string; who: string; body?: string; projectCwd?: string }>;
  planApprovedAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface LegacyRepo {
  projectCwd: string;
  goal: string;
  approach: string;
  risks?: string;
  state: string;
  sessionId?: string;
  branch?: string;
  prUrl?: string;
  prState?: 'open' | 'merged' | 'closed';
  ciState?: 'pending' | 'success' | 'failure';
  reviewState?: 'approved' | 'changes_requested' | 'review_required';
  comments?: unknown[];
  iterations?: unknown[];
  reviewComments?: unknown[];
  draftedReplies?: unknown[];
  editQueue?: unknown[];
  threadHash?: string;
  failure?: { reason: string; at: number };
  updatedAt: number;
}

export function migrateTicket(t: LegacyTicket): JobRecord {
  const steps: Step[] = Object.values(t.repos ?? {}).map((r): OpenPrStep => ({
    id: stepId(t.ticketId, r.projectCwd),
    type: 'open-pr',
    title: `${r.projectCwd.split('/').slice(-2).join('/')} — ${t.title}`,
    description: '',
    workspace: { kind: 'writable', repoCwd: r.projectCwd, branch: r.branch ?? '' },
    goal: r.goal ?? '',
    approach: r.approach ?? '',
    ...(r.risks ? { risks: r.risks } : {}),
    state: (r.state as OpenPrStep['state']) ?? 'implementing',
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    ...(r.prState ? { prState: r.prState } : {}),
    ...(r.ciState ? { ciState: r.ciState } : {}),
    ...(r.reviewState ? { reviewState: r.reviewState } : {}),
    ...(r.comments ? { comments: r.comments as never } : {}),
    ...(r.iterations ? { iterations: r.iterations as never } : {}),
    ...(r.reviewComments ? { reviewComments: r.reviewComments as never } : {}),
    ...(r.draftedReplies ? { draftedReplies: r.draftedReplies as never } : {}),
    ...(r.editQueue ? { editQueue: r.editQueue as never } : {}),
    ...(r.threadHash ? { threadHash: r.threadHash } : {}),
    ...(r.failure ? { failure: r.failure } : {}),
    createdAt: t.createdAt,
    updatedAt: r.updatedAt ?? t.updatedAt,
  }));

  const job: JobRecord = {
    id: t.ticketId,
    source: 'linear',
    title: t.title ?? '',
    description: '',
    externalRef: { url: t.url, issueIdentifier: t.ticketId, linearUuid: t.linearUuid },
    state: STATE_MAP[t.state] ?? 'executing',
    steps,
    ...(t.investigatorSessionId ? { plannerSessionId: t.investigatorSessionId } : {}),
    ...(t.linearCommentId ? { linearCommentId: t.linearCommentId } : {}),
    ...(t.linearStateMarked ? { linearStateMarked: t.linearStateMarked } : {}),
    events: [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  return job;
}

function main() {
  const root = process.env.OUTPOST_RUNTIME_DIR ?? join(homedir(), '.outpost');
  const src = join(root, 'work', 'queue.json');
  const jobsDir = join(root, 'jobs');
  if (!existsSync(src)) {
    console.error(`source not found: ${src}`);
    process.exit(1);
  }
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const raw = readFileSync(src, 'utf8');
  const parsed = JSON.parse(raw) as { tickets?: LegacyTicket[] };
  const tickets = Array.isArray(parsed?.tickets) ? parsed.tickets : [];

  let migrated = 0, skipped = 0;
  for (const t of tickets) {
    const dest = join(jobsDir, `${t.ticketId}.json`);
    if (existsSync(dest)) { skipped++; continue; }
    const job = migrateTicket(t);
    const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
    migrated++;
  }
  console.log(`migrated=${migrated} skipped=${skipped} (source: ${src})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
