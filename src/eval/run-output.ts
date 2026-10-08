import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderDraftCalls, renderValue } from '../work/draft-verdict.js';
import type { PinnedCall } from '../work/write-draft.js';

const run = promisify(execFile);
const MAX_DIFF_BYTES = 200 * 1024;

// One thing a round handed back: an `outpost` submit tool and its arguments, or a code round's diff.
export interface RunOutput { tool: string; args: unknown }

export function renderOutputs(outs: RunOutput[]): string {
  if (outs.length === 0) return '(no output)';
  return outs.map((o) => {
    const args = (o.args ?? {}) as Record<string, unknown>;
    if (o.tool === 'worktree-diff') return `# worktree diff\n${String(args.diff ?? '')}`;
    if (o.tool === 'submit_write_draft' && Array.isArray(args.calls)) {
      return `# write draft: ${String(args.summary ?? '')}\n${renderDraftCalls(args.calls as PinnedCall[])}`;
    }
    const { jobId: _j, stepId: _s, ...rest } = args;
    return `# ${o.tool}\n${renderValue(rest).join('\n')}`;
  }).join('\n\n');
}

// The full working tree — uncommitted and untracked files too — as a tree object, built in a copy of the
// index so the session's own staging is never touched.
async function workingTree(dir: string): Promise<string> {
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    run('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) });
  const { stdout: indexPath } = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const tmpIndex = join(tmpdir(), `outpost-index-${randomUUID()}`);
  try {
    try { await copyFile(indexPath.trim(), tmpIndex); } catch { /* no index yet — add -A builds one */ }
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    await git(['add', '-A'], env);
    const { stdout: tree } = await git(['write-tree'], env);
    return tree.trim();
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

// Unreferenced, a snapshot is gc'd in about two weeks, long before its run stops being replayable.
const SNAPSHOT_REFS = 'refs/outpost/snapshots/';
// Younger than this, a pinned snapshot may belong to a run the reconciling caller hasn't seen yet.
const UNCLAIMED_GRACE_S = 24 * 60 * 60;

// A round's starting state as a commit on top of HEAD, pinned under refs/outpost/snapshots/ until
// reconcileSnapshotRefs finds no retained run that still needs it.
export async function snapshotWorktree(dir: string): Promise<{ commit: string; gitDir: string }> {
  const tree = await workingTree(dir);
  const identity = { GIT_AUTHOR_NAME: 'outpost', GIT_AUTHOR_EMAIL: 'outpost@localhost', GIT_COMMITTER_NAME: 'outpost', GIT_COMMITTER_EMAIL: 'outpost@localhost' };
  const { stdout: commit } = await run('git', ['-C', dir, 'commit-tree', tree, '-p', 'HEAD', '-m', 'outpost round snapshot'], { env: { ...process.env, ...identity } });
  const sha = commit.trim();
  await run('git', ['-C', dir, 'update-ref', `${SNAPSHOT_REFS}${sha}`, sha]);
  const { stdout: gitDir } = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { commit: sha, gitDir: gitDir.trim() };
}

function gitWithInput(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `git exited ${code}`))));
    child.stdin.end(input);
  });
}

// Pins every snapshot a retained run still needs (including ones taken before pinning existed), unpins
// the rest, and reports the ones git already lost so their runs stop being offered for replay.
export async function reconcileSnapshotRefs(gitDir: string, keep: ReadonlySet<string>, nowS = Math.floor(Date.now() / 1000)): Promise<{ missing: string[] }> {
  const { stdout } = await run('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname) %(committerdate:unix)', SNAPSHOT_REFS], { maxBuffer: 16 * 1024 * 1024 });
  const pinned = new Map(stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, at] = l.split(' ');
    return [sha!, Number(at)] as const;
  }));
  const wanted = [...keep];
  const exists = new Set<string>();
  if (wanted.length) {
    const check = await gitWithInput(['--git-dir', gitDir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], wanted.join('\n') + '\n');
    for (const line of check.split('\n')) {
      const [sha, type] = line.split(' ');
      if (sha && type === 'commit') exists.add(sha);
    }
  }
  const ops: string[] = [];
  for (const sha of exists) if (!pinned.has(sha)) ops.push(`create ${SNAPSHOT_REFS}${sha} ${sha}`);
  for (const [sha, at] of pinned) {
    if (!keep.has(sha) && nowS - at > UNCLAIMED_GRACE_S) ops.push(`delete ${SNAPSHOT_REFS}${sha}`);
  }
  if (ops.length) await gitWithInput(['--git-dir', gitDir, 'update-ref', '--stdin'], ops.join('\n') + '\n');
  return { missing: wanted.filter((sha) => !exists.has(sha)) };
}

// What a round changed: everything in the working tree now that differs from its starting snapshot.
export async function diffSince(dir: string, base: string): Promise<string> {
  const tree = await workingTree(dir);
  const { stdout } = await run('git', ['-C', dir, 'diff', base, tree], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.slice(0, MAX_DIFF_BYTES);
}
