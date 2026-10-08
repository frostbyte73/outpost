import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayPreTool, type ReplayHookDeps } from '../../src/eval/replay-hook.js';
import { EvalSessions, type EvalSession } from '../../src/eval/eval-sessions.js';
import { readInputKey } from '../../src/permissions/read-recording.js';
import type { ActionAllowlist } from '../../src/actions/types.js';

const PULL = ['^gh pr view(\\s|$)'];
const empty: ActionAllowlist = { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] } as unknown as ActionAllowlist;
const gated: ActionAllowlist = { ...empty, alwaysAllowBashPatterns: ['^gh pr comment(\\s|$)'] } as ActionAllowlist;

function session(blobs: Record<string, string>): { s: EvalSession; deps: ReplayHookDeps } {
  const s: EvalSession = {
    sessionId: 'sid', evalId: 'e1', action: 'code.reply-pr-comments', worktree: '/wt',
    scratchDir: mkdtempSync(join(tmpdir(), 'replay-hook-')), reads: new Map(), misses: 0, captured: [],
  };
  const put = (tool: string, input: unknown, ref: string) =>
    s.reads.set(readInputKey(tool, input), { tool, inputKey: readInputKey(tool, input), responseRef: ref });
  put('Bash', { command: 'gh pr view 1' }, 'view');
  put('Bash', { command: 'gh pr view 2' }, 'garbage');
  put('WebFetch', { url: 'https://x.dev', prompt: 'p' }, 'web');
  const deps: ReplayHookDeps = {
    allows: (tool, input) => tool === 'Edit' || (tool === 'Bash' && /^gh pr (view|comment)/.test((input as { command: string }).command)),
    gated: () => gated,
    pullPatterns: PULL,
    blob: (ref) => blobs[ref],
  };
  return { s, deps };
}

const call = (tool_name: string, tool_input: unknown) => ({ tool_name, tool_input, session_id: 'sid' });

describe('replayPreTool', () => {
  const blobs = {
    view: JSON.stringify({ stdout: 'PR #1 open', stderr: '', interrupted: false }),
    garbage: 'not json',
    web: JSON.stringify({ result: 'page text' }),
  };

  it('serves a recorded Bash read by rewriting it to cat the recorded stdout', () => {
    const { s, deps } = session(blobs);
    const r = replayPreTool(call('Bash', { command: 'gh pr view 1' }), s, deps);
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
    const cmd = (r.hookSpecificOutput.updatedInput as { command: string }).command;
    const file = cmd.match(/^cat '(.+)'$/)![1]!;
    expect(readFileSync(file, 'utf8')).toBe('PR #1 open');
    expect(s.misses).toBe(0);
  });

  it('denies and counts a read the run never made', () => {
    const { s, deps } = session(blobs);
    const r = replayPreTool(call('Bash', { command: 'gh pr view 9' }), s, deps);
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(s.misses).toBe(1);
  });

  it('treats an unparseable recording as a miss', () => {
    const { s, deps } = session(blobs);
    expect(replayPreTool(call('Bash', { command: 'gh pr view 2' }), s, deps).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(s.misses).toBe(1);
  });

  it('denies a gated write even when the allowlist would pass it', () => {
    const { s, deps } = session(blobs);
    const r = replayPreTool(call('Bash', { command: 'gh pr comment 1 --body hi' }), s, deps);
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/submit_write_draft/);
  });

  it('serves a recorded WebFetch inside the deny reason', () => {
    const { s, deps } = session(blobs);
    const r = replayPreTool(call('WebFetch', { url: 'https://x.dev', prompt: 'p' }), s, deps);
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('page text');
    expect(s.misses).toBe(0);
  });

  it('lets local work through the action allowlist', () => {
    const { s, deps } = session(blobs);
    expect(replayPreTool(call('Edit', { file_path: '/wt/a.ts' }), s, deps).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(replayPreTool(call('Write', { file_path: '/etc/x' }), s, deps).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it.each([
    ['a piped network read', 'gh pr view 1 --json title | jq .title'],
    ['a write to the live daemon an action allowlist grants', 'curl -fsS -X POST "$OUTPOST_API_URL/api/projects" -d x'],
    ['a fetch into the shared repo', 'git fetch origin'],
    ['a loopback URL', 'wget -qO- http://127.0.0.1:8443/api/jobs'],
  ])('denies and counts %s that no recording serves', (_label, command) => {
    const { s, deps } = session(blobs);
    const r = replayPreTool(call('Bash', { command }), s, { ...deps, allows: () => true, gated: () => empty });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(s.misses).toBe(1);
  });

  it('runs local shell work the allowlist grants', () => {
    const { s, deps } = session(blobs);
    const r = replayPreTool(call('Bash', { command: 'npm test -- foo && ls -la' }), s, { ...deps, allows: () => true });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('always lets the outpost submit tools through', () => {
    const { s, deps } = session(blobs);
    expect(replayPreTool(call('mcp__outpost__submit_write_draft', {}), s, deps).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('EvalSessions', () => {
  it('registers, looks up and drops', () => {
    const reg = new EvalSessions();
    const { s } = session({});
    reg.register(s);
    expect(reg.get('sid')).toBe(s);
    reg.drop('sid');
    expect(reg.get('sid')).toBeUndefined();
  });
});
