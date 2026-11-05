import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { evalChildEnv, replayRun, sweepEvalScratch, type ReplayDeps } from '../../src/eval/replay-runner.js';
import { EvalSessions } from '../../src/eval/eval-sessions.js';
import type { RunClaudeOnce } from '../../src/runtime/claude/once.js';
import type { ActionRunRecord } from '../../src/storage/action-runs-store.js';

const result = (over: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, ...over }) as unknown as SDKResultMessage;

function fixture(runClaude: RunClaudeOnce, over: Partial<ActionRunRecord> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'replay-runner-'));
  const actionDir = join(root, 'action');
  mkdirSync(actionDir);
  writeFileSync(join(actionDir, 'SKILL.md'), 'live body');
  writeFileSync(join(actionDir, 'allowlist.json'), '{}');
  const blobs: Record<string, string> = { env: JSON.stringify({ worktreePath: '/live/wt', goal: 'x' }) };
  const gitCalls: string[][] = [];
  const sessions = new EvalSessions();
  const deps: ReplayDeps = {
    sessions,
    blob: (r) => blobs[r],
    actionDir: () => actionDir,
    hookPort: 1234,
    secret: 'eval-sek',
    scratchRoot: join(root, 'scratch'),
    preTool: { allows: () => true, gated: () => undefined, pullPatterns: [], blob: () => undefined },
    runClaude,
    git: async (args) => {
      gitCalls.push(args);
      const i = args.indexOf('add');
      if (i >= 0) mkdirSync(args[i + 2]!, { recursive: true });
    },
    diff: async () => '+changed',
  };
  const run: ActionRunRecord = {
    id: 'r1', action: 'code.reply-pr-comments', round: 'draft', attempt: 1, jobId: 'j', stepId: 's', startedAt: 1,
    envelopeRef: 'env', outputRef: 'o', skillSha: 'x', baseSha: 'abc', gitDir: '/repo/.git', worktreePath: '/live/wt',
    ...over,
  };
  return { deps, run, gitCalls, sessions, root };
}

describe('replayRun', () => {
  it('runs the candidate skill from a plugin dir against a rewritten envelope in a throwaway worktree', async () => {
    let seen: { prompt: string; options: Options } | undefined;
    let envelope = '';
    const run: RunClaudeOnce = async (prompt, options) => {
      seen = { prompt, options };
      const plugin = options.plugins![0]!.path;
      envelope = readFileSync(options.env!.OUTPOST_ENVELOPE!, 'utf8');
      expect(readFileSync(join(plugin, 'skills', 'code.reply-pr-comments', 'SKILL.md'), 'utf8')).toBe('candidate body');
      expect(existsSync(join(plugin, 'skills', 'code.reply-pr-comments', 'allowlist.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('outpost-eval');
      f.sessions.get(options.sessionId!)!.captured.push({ tool: 'submit_write_draft', args: { summary: 'x' } });
      return result({ total_cost_usd: 0.42 });
    };
    const f = fixture(run);
    const r = await replayRun(f.run, 'candidate body', 'e1', 3, f.deps);
    const o = seen!.options;
    expect(o).toMatchObject({ strictMcpConfig: true, maxBudgetUsd: 3, persistSession: false });
    expect(Object.keys(o.mcpServers!)).toEqual(['outpost']);
    expect(seen!.prompt).toBe('/outpost-eval:code.reply-pr-comments');
    expect(o.env!.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(o.cwd).toContain(join('scratch', 'e1'));
    expect(envelope).toContain(o.cwd);
    expect(envelope).not.toContain('/live/wt');
    expect(r).toMatchObject({ valid: true, misses: 0, costUsd: 0.42, output: [{ tool: 'submit_write_draft', args: { summary: 'x' } }] });
    expect(f.gitCalls.map((a) => a.find((x) => ['add', 'restore', 'remove'].includes(x)))).toEqual(['add', 'restore', 'remove']);
    expect(f.gitCalls[0]).toContain('abc^');
    expect(f.gitCalls[1]).toEqual(expect.arrayContaining(['restore', '--source=abc', '--worktree']));
    expect(existsSync(o.cwd!)).toBe(false);
    expect(f.sessions.get(o.sessionId!)).toBeUndefined();
  });

  it('appends the worktree diff for a code round', async () => {
    const f = fixture(async () => result(), { action: 'code.implement' });
    const r = await replayRun(f.run, 'c', 'e2', 3, f.deps);
    expect(r.output).toEqual([{ tool: 'worktree-diff', args: { diff: '+changed' } }]);
  });

  it('marks a replay with more than two misses invalid', async () => {
    const f = fixture(async (_p, options) => {
      f.sessions.get(options.sessionId!)!.misses = 3;
      return result();
    });
    expect((await replayRun(f.run, 'c', 'e3', 3, f.deps)).valid).toBe(false);
  });

  it('cleans up and reports invalid when the spawn fails', async () => {
    const f = fixture(async () => { throw new Error('ENOENT'); });
    const r = await replayRun(f.run, 'c', 'e4', 3, f.deps);
    expect(r).toMatchObject({ valid: false, error: expect.stringContaining('ENOENT') });
    expect(existsSync(join(f.root, 'scratch', 'e4'))).toBe(false);
  });

  it('is invalid, and charged its whole budget, when claude produced no result', async () => {
    const f = fixture(async () => undefined);
    const r = await replayRun(f.run, 'c', 'e5', 3, f.deps);
    expect(r).toMatchObject({ valid: false, costUsd: 3, error: expect.stringMatching(/no result/) });
  });

  it('flags a replay that hit its budget, keeping what it submitted', async () => {
    const f = fixture(async () => result({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2.9 }));
    const r = await replayRun(f.run, 'c', 'e7', 3, f.deps);
    expect(r).toMatchObject({ valid: true, stopped: 'error_max_budget_usd', costUsd: 2.9, output: [] });
  });

  it('is invalid when the session ended in an execution error', async () => {
    const f = fixture(async () => result({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.3 }));
    const r = await replayRun(f.run, 'c', 'e8', 3, f.deps);
    expect(r).toMatchObject({ valid: false, costUsd: 0.3, error: expect.stringMatching(/error_during_execution/) });
  });

  it('runs on the model the original session used', async () => {
    let model: string | undefined;
    const f = fixture(async (_p, o) => { model = o.model; return result(); }, { model: 'claude-sonnet-5-5' });
    await replayRun(f.run, 'c', 'e9', 3, f.deps);
    expect(model).toBe('claude-sonnet-5-5');
  });

  it('runs without a worktree when the original had none', async () => {
    const f = fixture(async () => result(), { baseSha: undefined, gitDir: undefined, worktreePath: undefined });
    await replayRun(f.run, 'c', 'e6', 3, f.deps);
    expect(f.gitCalls).toEqual([]);
  });
});

describe('evalChildEnv', () => {
  it('drops every way back into the live daemon', () => {
    const env = evalChildEnv(
      { PATH: '/bin', OUTPOST_API_URL: 'http://127.0.0.1:8443', OUTPOST_HOOK_PORT: '8444', DAEMON_AUTH: 'real', HOME: '/h' },
      { DAEMON_AUTH: 'eval-only', OUTPOST_ENVELOPE: '/e' },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', DAEMON_AUTH: 'eval-only', OUTPOST_ENVELOPE: '/e' });
  });
});

describe('sweepEvalScratch', () => {
  it('removes every leftover attempt and prunes the repos their worktrees were registered in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    mkdirSync(join(root, 'ev1', 'a1', 'wt'), { recursive: true });
    writeFileSync(join(root, 'ev1', 'a1', 'wt', '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
    mkdirSync(join(root, 'ev2', 'a2', 'plugin'), { recursive: true });
    const calls: string[][] = [];
    expect(await sweepEvalScratch(root, async (a) => { calls.push(a); })).toBe(2);
    expect(calls).toEqual([['--git-dir', '/repo/.git', 'worktree', 'prune']]);
    expect(existsSync(join(root, 'ev1'))).toBe(false);
    expect(existsSync(join(root, 'ev2'))).toBe(false);
  });

  it('is a no-op when there is no scratch root yet', async () => {
    expect(await sweepEvalScratch(join(tmpdir(), 'nope-does-not-exist'))).toBe(0);
  });
});
