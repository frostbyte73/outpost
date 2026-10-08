import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
  opts: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number },
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
  error?: string;
}

// The daemon's own loopback URL and secret would let a replay write to live state, so they never reach it.
const LIVE_DAEMON_ENV = ['OUTPOST_API_URL', 'OUTPOST_HOOK_PORT', 'DAEMON_AUTH', 'DAEMON_HOST'];

export function evalChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !LIVE_DAEMON_ENV.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

export const spawnClaudeOnce: SpawnClaude = (args, opts) => new Promise((resolve, reject) => {
  const child = spawn(resolveClaudeBin(), args, { cwd: opts.cwd, env: evalChildEnv(process.env, opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', () => { /* drained so a chatty child can't block on a full pipe */ });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, code }); });
  child.stdin.end(opts.stdin);
});

const runGit: GitRunner = async (args) => { await promisify(execFile)('git', args); };

// A result line means the session ran, even to a budget stop; without one it never did, or was killed.
function resultOf(stdout: string): { costUsd: number } | undefined {
  let parsed: { type?: unknown; total_cost_usd?: unknown };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { return undefined; }
  if (parsed?.type !== 'result') return undefined;
  const c = parsed.total_cost_usd;
  return { costUsd: typeof c === 'number' && Number.isFinite(c) ? c : 0 };
}

// Re-runs one recorded round under a candidate SKILL.md. Never touches the live skill, worktree or job.
export async function replayRun(
  run: ActionRunRecord,
  candidateSkillMd: string,
  evalId: string,
  budgetUsd: number,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const git = deps.git ?? runGit;
  const sessionId = randomUUID();
  const scratch = join(deps.scratchRoot, evalId, run.id);
  const wt = run.baseSha && run.gitDir ? join(scratch, 'wt') : undefined;
  let worktreeAdded = false;
  try {
    const skillDir = join(scratch, 'plugin', 'skills', run.action);
    mkdirSync(join(scratch, 'plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(join(scratch, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: EVAL_PLUGIN, version: '0.0.0' }));
    cpSync(deps.actionDir(run.action), skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), candidateSkillMd);

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
      reads: new Map((run.reads ?? []).map((r) => [r.inputKey, r])),
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
    });
    const result = resultOf(stdout);
    // Charged in full: a killed session's spend is unknown, and undercounting it would let the next replay overspend.
    if (!result) return { valid: false, misses: session.misses, output: [], costUsd: budgetUsd, error: `claude produced no result (exit ${code})` };
    const output = [...session.captured];
    if (wt && CODE_ROUND_ACTIONS.has(run.action)) {
      output.push({ tool: 'worktree-diff', args: { diff: await (deps.diff ?? diffSince)(wt, run.baseSha!) } });
    }
    return { valid: session.misses <= MAX_MISSES, misses: session.misses, output, costUsd: result.costUsd };
  } catch (e) {
    const s = deps.sessions.get(sessionId);
    return { valid: false, misses: s?.misses ?? 0, output: [], costUsd: 0, error: (e as Error).message };
  } finally {
    deps.sessions.drop(sessionId);
    if (worktreeAdded) await git(['--git-dir', run.gitDir!, 'worktree', 'remove', '--force', wt!]).catch(() => { /* best-effort */ });
    rmSync(scratch, { recursive: true, force: true });
  }
}
