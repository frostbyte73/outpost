import { execFile } from 'node:child_process';
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

// A round's starting state as an unreferenced commit on top of HEAD; git gc reclaims it after its prune window.
export async function snapshotWorktree(dir: string): Promise<{ commit: string; gitDir: string }> {
  const tree = await workingTree(dir);
  const identity = { GIT_AUTHOR_NAME: 'outpost', GIT_AUTHOR_EMAIL: 'outpost@localhost', GIT_COMMITTER_NAME: 'outpost', GIT_COMMITTER_EMAIL: 'outpost@localhost' };
  const { stdout: commit } = await run('git', ['-C', dir, 'commit-tree', tree, '-p', 'HEAD', '-m', 'outpost round snapshot'], { env: { ...process.env, ...identity } });
  const { stdout: gitDir } = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { commit: commit.trim(), gitDir: gitDir.trim() };
}

// What a round changed: everything in the working tree now that differs from its starting snapshot.
export async function diffSince(dir: string, base: string): Promise<string> {
  const tree = await workingTree(dir);
  const { stdout } = await run('git', ['-C', dir, 'diff', base, tree], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.slice(0, MAX_DIFF_BYTES);
}
