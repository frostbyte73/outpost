import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { rekeyRead } from '../permissions/read-recording.js';
import { resolveClaudeBin } from '../session/claude-proc.js';
import { writeEvalMcpConfig, writeEvalSettings } from '../settings-gen.js';
import type { ActionRunRecord } from '../storage/action-runs-store.js';
import { CODE_ROUND_ACTIONS } from '../work/action-run-links.js';
import { replayServerNames } from './eval-mcp.js';
import type { EvalSessions } from './eval-sessions.js';
import { diffSince, type RunOutput } from './run-output.js';

export const EVAL_PLUGIN = 'outpost-eval';
const MAX_MISSES = 2;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export type SpawnClaude = (
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; code: number | null }>;

export type GitRunner = (args: string[]) => Promise<void>;

export interface ReplayDeps {
  sessions: EvalSessions;
  blob: (ref: string) => string | undefined;
  actionDir: (action: string) => string;
  hookPort: number;
  // Accepted only by the PreToolUse gate and the eval MCP routes — never the daemon's real secret.
  secret: string;
  scratchRoot: string;
  spawnClaude?: SpawnClaude;
  git?: GitRunner;
  diff?: (dir: string, base: string) => Promise<string>;
  timeoutMs?: number;
}

export interface ReplayResult {
  valid: boolean;
  misses: number;
  output: RunOutput[];
  costUsd: number;
  // Hit the replay's budget or turn limit: the output is whatever it submitted before that.
  stopped?: string;
  error?: string;
}

// The daemon's own loopback URL and secret would let a replay write to live state, so they never reach it.
const LIVE_DAEMON_ENV = ['OUTPOST_API_URL', 'OUTPOST_HOOK_PORT', 'DAEMON_AUTH', 'DAEMON_HOST'];

export function evalChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !LIVE_DAEMON_ENV.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

// Eval and judge children aren't SessionManager sessions, so the daemon's shutdown kills them through this.
const liveChildren = new Set<ChildProcess>();

export function killEvalChildren(): number {
  const n = liveChildren.size;
  for (const c of liveChildren) c.kill('SIGKILL');
  liveChildren.clear();
  return n;
}

export const spawnClaudeOnce: SpawnClaude = (args, opts) => new Promise((resolve, reject) => {
  const child = spawn(resolveClaudeBin(), args, { cwd: opts.cwd, env: evalChildEnv(process.env, opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
  liveChildren.add(child);
  let stdout = '';
  const kill = () => child.kill('SIGKILL');
  const timer = setTimeout(kill, opts.timeoutMs);
  opts.signal?.addEventListener('abort', kill, { once: true });
  const done = () => { clearTimeout(timer); liveChildren.delete(child); opts.signal?.removeEventListener('abort', kill); };
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', () => { /* drained so a chatty child can't block on a full pipe */ });
  child.stdin.on('error', () => { /* a child that died first; 'close' reports it */ });
  child.on('error', (e) => { done(); reject(e); });
  child.on('close', (code) => { done(); resolve({ stdout, code }); });
  if (opts.signal?.aborted) kill();
  child.stdin.end(opts.stdin);
});

const runGit: GitRunner = async (args) => { await promisify(execFile)('git', args); };

// Limits the replay itself imposed: under an equal budget for both sides, running into one is a result.
const LIMIT_STOPS = new Set(['error_max_budget_usd', 'error_max_turns']);

// A result line means the session ran; without one it never did, or was killed.
function resultOf(stdout: string): { costUsd: number; subtype?: string; isError: boolean } | undefined {
  let parsed: { type?: unknown; subtype?: unknown; is_error?: unknown; total_cost_usd?: unknown };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { return undefined; }
  if (parsed?.type !== 'result') return undefined;
  const c = parsed.total_cost_usd;
  return {
    costUsd: typeof c === 'number' && Number.isFinite(c) ? c : 0,
    ...(typeof parsed.subtype === 'string' ? { subtype: parsed.subtype } : {}),
    isError: parsed.is_error === true,
  };
}

// Re-runs one recorded round under the given SKILL.md. Never touches the live skill, worktree or job.
export async function replayRun(
  run: ActionRunRecord,
  skillMd: string,
  evalId: string,
  budgetUsd: number,
  deps: ReplayDeps,
  signal?: AbortSignal,
): Promise<ReplayResult> {
  const git = deps.git ?? runGit;
  const sessionId = randomUUID();
  // Unique per attempt: a resumed eval reuses its id, and a crashed attempt's directory may still be there.
  const scratch = join(deps.scratchRoot, evalId, sessionId);
  const wt = run.baseSha && run.gitDir ? join(scratch, 'wt') : undefined;
  let worktreeAdded = false;
  try {
    const skillDir = join(scratch, 'plugin', 'skills', run.action);
    mkdirSync(join(scratch, 'plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(join(scratch, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: EVAL_PLUGIN, version: '0.0.0' }));
    cpSync(deps.actionDir(run.action), skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd);

    if (wt) {
      // HEAD at the snapshot's parent with the snapshot laid over the working tree: the round's
      // uncommitted starting state, seen by `git status` exactly as the original session saw it.
      await git(['--git-dir', run.gitDir!, 'worktree', 'add', '--detach', wt, `${run.baseSha}^`]);
      worktreeAdded = true;
      await git(['-C', wt, 'restore', `--source=${run.baseSha}`, '--worktree', '--', '.']);
    }
    const cwd = wt ?? scratch;
    let envelope = deps.blob(run.envelopeRef!) ?? '{}';
    if (run.worktreePath && wt) envelope = envelope.split(run.worktreePath).join(wt);
    const envelopePath = join(scratch, 'envelope.json');
    writeFileSync(envelopePath, envelope);

    const session = {
      sessionId, evalId, action: run.action, scratchDir: scratch, misses: 0, captured: [] as RunOutput[],
      reads: new Map((run.reads ?? []).map(rekeyRead).map((r) => [r.inputKey, r])),
      ...(wt ? { worktree: wt } : {}),
    };
    const settingsPath = join(scratch, 'settings.json');
    const mcpPath = join(scratch, 'mcp.json');
    writeEvalSettings(settingsPath, deps.hookPort);
    writeEvalMcpConfig({ outPath: mcpPath, hookPort: deps.hookPort, daemonAuthSecret: deps.secret, sessionId, replayServers: replayServerNames(session) });
    deps.sessions.register(session);

    const { stdout, code } = await (deps.spawnClaude ?? spawnClaudeOnce)([
      '--print', '--output-format', 'json',
      '--session-id', sessionId, '--no-session-persistence',
      '--permission-mode', 'default',
      '--settings', settingsPath,
      '--strict-mcp-config', '--mcp-config', mcpPath,
      '--plugin-dir', join(scratch, 'plugin'),
      '--max-budget-usd', budgetUsd.toFixed(2),
      ...(run.model ? ['--model', run.model] : []),
    ], {
      cwd,
      env: {
        OUTPOST_ENVELOPE: envelopePath,
        JOB_ID: run.jobId,
        ...(run.stepId ? { STEP_ID: run.stepId } : {}),
        DAEMON_AUTH: deps.secret,
        OUTPOST_EVAL_ID: evalId,
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      },
      stdin: `/${EVAL_PLUGIN}:${run.action}`,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const result = resultOf(stdout);
    // Charged in full: a killed session's spend is unknown, and undercounting it would let the next replay overspend.
    if (!result) return { valid: false, misses: session.misses, output: [], costUsd: budgetUsd, error: `claude produced no result (exit ${code})` };
    const stopped = result.subtype && LIMIT_STOPS.has(result.subtype) ? result.subtype : undefined;
    if (!stopped && (result.isError || (result.subtype && result.subtype !== 'success'))) {
      return { valid: false, misses: session.misses, output: [], costUsd: result.costUsd, error: `replay ended in ${result.subtype ?? 'an error'}` };
    }
    const output = [...session.captured];
    if (wt && CODE_ROUND_ACTIONS.has(run.action)) {
      output.push({ tool: 'worktree-diff', args: { diff: await (deps.diff ?? diffSince)(wt, run.baseSha!) } });
    }
    return { valid: session.misses <= MAX_MISSES, misses: session.misses, output, costUsd: result.costUsd, ...(stopped ? { stopped } : {}) };
  } catch (e) {
    const s = deps.sessions.get(sessionId);
    return { valid: false, misses: s?.misses ?? 0, output: [], costUsd: 0, error: (e as Error).message };
  } finally {
    deps.sessions.drop(sessionId);
    if (worktreeAdded) await git(['--git-dir', run.gitDir!, 'worktree', 'remove', '--force', wt!]).catch(() => { /* best-effort */ });
    rmSync(scratch, { recursive: true, force: true });
    try { rmdirSync(join(deps.scratchRoot, evalId)); } catch { /* not empty, or already gone */ }
  }
}

// Clears what a replay killed mid-flight left behind — its scratch dir and the worktree it registered
// in the project's repo. Run before any eval starts, since a resumed eval's replays would collide.
export async function sweepEvalScratch(scratchRoot: string, git: GitRunner = runGit): Promise<number> {
  let evalDirs: string[];
  try { evalDirs = readdirSync(scratchRoot); } catch { return 0; }
  const repos = new Set<string>();
  let swept = 0;
  for (const evalDir of evalDirs) {
    const evalPath = join(scratchRoot, evalDir);
    let attempts: string[] = [];
    try { attempts = readdirSync(evalPath); } catch { /* a stray file */ }
    for (const attempt of attempts) {
      try {
        const m = readFileSync(join(evalPath, attempt, 'wt', '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
        // <common>/worktrees/<name> — prune needs the common dir, which outlives the worktree's own.
        if (m) repos.add(dirname(dirname(m[1]!.trim())));
      } catch { /* no worktree in this attempt */ }
      swept += 1;
    }
    rmSync(evalPath, { recursive: true, force: true });
  }
  for (const repo of repos) await git(['--git-dir', repo, 'worktree', 'prune']).catch(() => { /* repo gone */ });
  return swept;
}
