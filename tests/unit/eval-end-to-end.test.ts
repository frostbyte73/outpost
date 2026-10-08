import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSessions } from '../../src/eval/eval-sessions.js';
import { replayPreTool } from '../../src/eval/replay-hook.js';
import { handleEvalMcp } from '../../src/eval/eval-mcp.js';
import { replayRun, type SpawnClaude } from '../../src/eval/replay-runner.js';
import { newEvalRecord, runEval } from '../../src/eval/run-eval.js';
import { EvalStore } from '../../src/eval/eval-store.js';
import { BlobStore } from '../../src/storage/blob-store.js';
import { readInputKey } from '../../src/permissions/read-recording.js';
import type { ActionRunRecord } from '../../src/storage/action-runs-store.js';
import type { ActionAllowlist } from '../../src/actions/types.js';
import type { JudgeOnce } from '../../src/eval/judge.js';

describe('an eval end to end with a stub claude', () => {
  it('serves recorded reads, denies the gated write, captures the draft and grades it — touching no job', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-e2e-'));
    const blobs = new BlobStore(join(root, 'blobs'));
    const actionDir = join(root, 'action');
    mkdirSync(actionDir);
    writeFileSync(join(actionDir, 'SKILL.md'), 'live');

    const view = { command: 'gh pr view 7' };
    const r = (id: string, over: Partial<ActionRunRecord>): ActionRunRecord => ({
      id, action: 'code.reply-pr-comments', round: 'draft', attempt: 1, jobId: 'j', stepId: 's', startedAt: 1,
      envelopeRef: blobs.put('{"goal":"reply to the review"}'),
      outputRef: blobs.put(JSON.stringify([{ tool: 'submit_write_draft', args: { summary: 'OLD', calls: [{ bash: 'gh pr comment 7 --body OLD' }] } }])),
      skillSha: 'sha', verdictAt: 2,
      reads: [{ tool: 'Bash', inputKey: readInputKey('Bash', view), responseRef: blobs.put(JSON.stringify({ stdout: 'PR 7: open' }))! }],
      ...over,
    });
    const runs = [r('t1', { outcome: 'revised', feedbackText: 'say NEW, not OLD' }), r('a1', { outcome: 'accepted' })];

    const engine = { onWriteDraftReady: vi.fn(), onStepProgress: vi.fn(), pinFor: vi.fn() };
    const sessions = new EvalSessions();
    const gated: ActionAllowlist = { alwaysAllow: [], alwaysAllowBashPatterns: ['^gh pr comment(\\s|$)'], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] };
    const hookDeps = {
      allows: () => true,
      gated: () => gated,
      pullPatterns: ['^gh pr view(\\s|$)'],
      blob: (ref: string) => blobs.get(ref),
    };
    const decisions: string[] = [];
    const stubClaude: SpawnClaude = async (args) => {
      const sid = args[args.indexOf('--session-id') + 1]!;
      const s = sessions.get(sid)!;
      const body = readFileSync(join(args[args.indexOf('--plugin-dir') + 1]!, 'skills', 'code.reply-pr-comments', 'SKILL.md'), 'utf8');
      const tag = body.length === 90 ? 'NEW' : 'OLD';
      const read = replayPreTool({ tool_name: 'Bash', tool_input: view, session_id: sid }, s, hookDeps);
      const cat = (read.hookSpecificOutput.updatedInput as { command: string }).command;
      decisions.push(`read:${read.hookSpecificOutput.permissionDecision}:${readFileSync(cat.match(/'(.+)'/)![1]!, 'utf8')}`);
      const write = replayPreTool({ tool_name: 'Bash', tool_input: { command: `gh pr comment 7 --body ${tag}` }, session_id: sid }, s, hookDeps);
      decisions.push(`write:${write.hookSpecificOutput.permissionDecision}`);
      await handleEvalMcp(`/mcp/eval/${sid}`, JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'submit_write_draft', arguments: { jobId: 'j', stepId: 's', summary: tag, calls: [{ bash: `gh pr comment 7 --body ${tag}` }] } },
      }), { sessions, blob: (ref) => blobs.get(ref) });
      return { stdout: JSON.stringify({ type: 'result', total_cost_usd: 0.2 }), code: 0 };
    };
    const judge: JudgeOnce = async ({ answerKey, a, b }) => {
      const newSlot = a.includes('NEW') ? 'A' : 'B';
      if (answerKey.startsWith('The user approved the original run')) return { winner: 'tie', reason: 'equivalent', costUsd: 0.05 };
      return { winner: newSlot, reason: 'matches the note', costUsd: 0.05 };
    };
    const recorded: unknown[] = [];
    const store = new EvalStore(join(root, 'evals'));

    const rec = await runEval(store.save(newEvalRecord({
      action: 'code.reply-pr-comments',
      editSessionId: 'edit-1',
      proposal: { summary: 's', skillMdBefore: 'x'.repeat(100), skillMdAfter: 'x'.repeat(90), allowlistAdds: [], postedAt: 5, citedRunIds: ['t1'] },
    })), {
      runs: () => runs,
      spent: () => new Set(),
      blob: (ref) => blobs.get(ref),
      replay: (run, candidate, evalId, budget) => replayRun(run, candidate, evalId, budget, {
        sessions, blob: (ref) => blobs.get(ref), actionDir: () => actionDir, hookPort: 1, secret: 's',
        scratchRoot: join(root, 'scratch'), spawnClaude: stubClaude,
      }),
      judge,
      store,
      revisions: { record: (i) => { recorded.push(i); return {} as never; } },
    });

    // Each run replays twice: once under the current body, once under the candidate.
    expect(decisions).toEqual(Array(4).fill(['read:allow:PR 7: open', 'write:deny']).flat());
    expect(rec).toMatchObject({ outcome: 'pass' });
    expect(rec.replays.map((x) => [x.runId, x.result])).toEqual([['t1', 'after'], ['a1', 'tie']]);
    expect(store.get(rec.id)?.outcome).toBe('pass');
    expect(recorded).toHaveLength(1);
    expect(engine.onWriteDraftReady).not.toHaveBeenCalled();
    expect(engine.onStepProgress).not.toHaveBeenCalled();
    expect(engine.pinFor).not.toHaveBeenCalled();
  });
});
