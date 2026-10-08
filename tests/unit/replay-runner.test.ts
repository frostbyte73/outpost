import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evalChildEnv, replayRun, sweepEvalScratch, type ReplayDeps, type SpawnClaude } from '../../src/eval/replay-runner.js';
import { EvalSessions } from '../../src/eval/eval-sessions.js';
import type { ActionRunRecord } from '../../src/storage/action-runs-store.js';

function fixture(spawnClaude: SpawnClaude, over: Partial<ActionRunRecord> = {}) {
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
    spawnClaude,
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
    let seen: { args: string[]; cwd: string; env: Record<string, string>; stdin: string } | undefined;
    let plugin = '';
    let envelope = '';
    const spawn: SpawnClaude = async (args, opts) => {
      seen = { args, ...opts };
      plugin = args[args.indexOf('--plugin-dir') + 1]!;
      envelope = readFileSync(opts.env.OUTPOST_ENVELOPE!, 'utf8');
      expect(readFileSync(join(plugin, 'skills', 'code.reply-pr-comments', 'SKILL.md'), 'utf8')).toBe('candidate body');
      expect(existsSync(join(plugin, 'skills', 'code.reply-pr-comments', 'allowlist.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('outpost-eval');
      const sid = args[args.indexOf('--session-id') + 1]!;
      f.sessions.get(sid)!.captured.push({ tool: 'submit_write_draft', args: { summary: 'x' } });
      return { stdout: JSON.stringify({ type: 'result', total_cost_usd: 0.42 }), code: 0 };
    };
    const f = fixture(spawn);
    const r = await replayRun(f.run, 'candidate body', 'e1', 3, f.deps);
    expect(seen!.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--max-budget-usd', '3.00', '--print']));
    expect(seen!.stdin).toBe('/outpost-eval:code.reply-pr-comments');
    expect(seen!.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(seen!.cwd).toContain(join('scratch', 'e1'));
    expect(envelope).toContain(seen!.cwd);
    expect(envelope).not.toContain('/live/wt');
    expect(r).toMatchObject({ valid: true, misses: 0, costUsd: 0.42, output: [{ tool: 'submit_write_draft', args: { summary: 'x' } }] });
    expect(f.gitCalls.map((a) => a.find((x) => ['add', 'restore', 'remove'].includes(x)))).toEqual(['add', 'restore', 'remove']);
    expect(f.gitCalls[0]).toContain('abc^');
    expect(f.gitCalls[1]).toEqual(expect.arrayContaining(['restore', '--source=abc', '--worktree']));
    expect(existsSync(seen!.cwd)).toBe(false);
    expect(f.sessions.get(seen!.args[seen!.args.indexOf('--session-id') + 1]!)).toBeUndefined();
  });

  it('appends the worktree diff for a code round', async () => {
    const f = fixture(async () => ({ stdout: '{"type":"result"}', code: 0 }), { action: 'code.implement' });
    const r = await replayRun(f.run, 'c', 'e2', 3, f.deps);
    expect(r.output).toEqual([{ tool: 'worktree-diff', args: { diff: '+changed' } }]);
  });

  it('marks a replay with more than two misses invalid', async () => {
    const f = fixture(async (args) => {
      f.sessions.get(args[args.indexOf('--session-id') + 1]!)!.misses = 3;
      return { stdout: '{"type":"result"}', code: 0 };
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
    const f = fixture(async () => ({ stdout: 'not json', code: null }));
    const r = await replayRun(f.run, 'c', 'e5', 3, f.deps);
    expect(r).toMatchObject({ valid: false, costUsd: 3, error: expect.stringMatching(/no result/) });
  });

  it('flags a replay that hit its budget, keeping what it submitted', async () => {
    const f = fixture(async () => ({ stdout: JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2.9 }), code: 1 }));
    const r = await replayRun(f.run, 'c', 'e7', 3, f.deps);
    expect(r).toMatchObject({ valid: true, stopped: 'error_max_budget_usd', costUsd: 2.9, output: [] });
  });

  it('is invalid when the session ended in an execution error', async () => {
    const f = fixture(async () => ({ stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.3 }), code: 1 }));
    const r = await replayRun(f.run, 'c', 'e8', 3, f.deps);
    expect(r).toMatchObject({ valid: false, costUsd: 0.3, error: expect.stringMatching(/error_during_execution/) });
  });

  it('runs on the model the original session used', async () => {
    let args: string[] = [];
    const f = fixture(async (a) => { args = a; return { stdout: '{"type":"result"}', code: 0 }; }, { model: 'claude-sonnet-5-5' });
    await replayRun(f.run, 'c', 'e9', 3, f.deps);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-sonnet-5-5']);
  });

  it('runs without a worktree when the original had none', async () => {
    const f = fixture(async () => ({ stdout: '{}', code: 0 }), { baseSha: undefined, gitDir: undefined, worktreePath: undefined });
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
