import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Comparison } from './eval-verdict.js';
import { runClaudeOnce, type RunClaudeOnce } from '../runtime/claude/once.js';
import { evalChildEnv } from './replay-runner.js';

const CONTEXT_CAP = 8000;
const OUTPUT_CAP = 30_000;
const TIMEOUT_MS = 5 * 60 * 1000;

export type JudgeOnce = (input: { context: string; answerKey: string; a: string; b: string }) =>
  Promise<{ winner: 'A' | 'B' | 'tie'; reason: string; costUsd: number }>;

const SYSTEM_PROMPT = [
  'You compare two outputs an automated assistant produced for the same task and decide which one the user would rather have received.',
  'You are given the task context, an answer key describing what the user actually wanted (their edit, their send-back note, the failure, or what happened downstream), and outputs A and B.',
  'The answer key quotes the output of an earlier, original run and what became of it. A and B are both new runs of the same task; neither is that original.',
  'Judge only against the answer key and the task. Ignore length, tone and formatting unless the answer key is about them. Do not prefer an output for its position.',
  'Answer "tie" when neither is clearly closer to what the user wanted.',
].join('\n');

const SCHEMA = {
  type: 'object',
  required: ['winner', 'reason'],
  additionalProperties: false,
  properties: { winner: { enum: ['A', 'B', 'tie'] }, reason: { type: 'string' } },
};

let emptyCwd: string | undefined;

export function claudeJudge(run: RunClaudeOnce = runClaudeOnce): JudgeOnce {
  return async ({ context, answerKey, a, b }) => {
    emptyCwd ??= mkdtempSync(join(tmpdir(), 'outpost-judge-'));
    const prompt = [
      `# Task context (truncated)\n${context.slice(0, CONTEXT_CAP)}`,
      `# Answer key\n${answerKey}`,
      `# Output A\n${a.slice(0, OUTPUT_CAP)}`,
      `# Output B\n${b.slice(0, OUTPUT_CAP)}`,
    ].join('\n\n');
    const res = await run(prompt, {
      cwd: emptyCwd,
      env: evalChildEnv(process.env, {}),
      model: 'opus',
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      extraArgs: { 'disable-slash-commands': null },
      systemPrompt: SYSTEM_PROMPT,
      outputFormat: { type: 'json_schema', schema: SCHEMA },
    }, { timeoutMs: TIMEOUT_MS });
    const out = (res?.subtype === 'success' ? res.structured_output : undefined) as { winner?: unknown; reason?: unknown } | undefined;
    const w = out?.winner;
    // Thrown, not tied: an outage read as a tie would fail the proposal it was meant to grade.
    if (w !== 'A' && w !== 'B' && w !== 'tie') throw new Error(`judge gave no usable verdict: ${JSON.stringify(res ?? null).slice(0, 200)}`);
    return { winner: w, reason: String(out?.reason ?? ''), costUsd: res?.total_cost_usd ?? 0 };
  };
}

// Judged twice with the slots swapped; a verdict that flips with the order is position bias, so a tie.
export async function judgePair(
  judge: JudgeOnce,
  input: { context: string; answerKey: string; before: string; after: string },
): Promise<{ result: Comparison; reasons: string[]; costUsd: number }> {
  const first = await judge({ context: input.context, answerKey: input.answerKey, a: input.before, b: input.after });
  const second = await judge({ context: input.context, answerKey: input.answerKey, a: input.after, b: input.before });
  const asVersion = (w: 'A' | 'B' | 'tie', afterSlot: 'A' | 'B'): Comparison =>
    w === 'tie' ? 'tie' : w === afterSlot ? 'after' : 'before';
  const one = asVersion(first.winner, 'B');
  const two = asVersion(second.winner, 'A');
  return {
    result: one === two ? one : 'tie',
    reasons: [first.reason, second.reason],
    costUsd: first.costUsd + second.costUsd,
  };
}
