import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Comparison } from './eval-verdict.js';
import { spawnClaudeOnce, type SpawnClaude } from './replay-runner.js';

const CONTEXT_CAP = 8000;
const OUTPUT_CAP = 30_000;
const TIMEOUT_MS = 5 * 60 * 1000;

export type JudgeOnce = (input: { context: string; answerKey: string; a: string; b: string }) =>
  Promise<{ winner: 'A' | 'B' | 'tie'; reason: string; costUsd: number }>;

const SYSTEM_PROMPT = [
  'You compare two outputs an automated assistant produced for the same task and decide which one the user would rather have received.',
  'You are given the task context, an answer key describing what the user actually wanted (their edit, their send-back note, the failure, or what happened downstream), and outputs A and B.',
  'Judge only against the answer key and the task. Ignore length, tone and formatting unless the answer key is about them. Do not prefer an output for its position.',
  'Answer "tie" when neither is clearly closer to what the user wanted.',
].join('\n');

const SCHEMA = JSON.stringify({
  type: 'object',
  required: ['winner', 'reason'],
  additionalProperties: false,
  properties: { winner: { enum: ['A', 'B', 'tie'] }, reason: { type: 'string' } },
});

let emptyCwd: string | undefined;

export function claudeJudge(spawn: SpawnClaude = spawnClaudeOnce): JudgeOnce {
  return async ({ context, answerKey, a, b }) => {
    emptyCwd ??= mkdtempSync(join(tmpdir(), 'outpost-judge-'));
    const stdin = [
      `# Task context (truncated)\n${context.slice(0, CONTEXT_CAP)}`,
      `# Answer key\n${answerKey}`,
      `# Output A\n${a.slice(0, OUTPUT_CAP)}`,
      `# Output B\n${b.slice(0, OUTPUT_CAP)}`,
    ].join('\n\n');
    const { stdout } = await spawn([
      '--print', '--output-format', 'json', '--model', 'opus',
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence', '--disable-slash-commands',
      '--system-prompt', SYSTEM_PROMPT, '--json-schema', SCHEMA,
    ], { cwd: emptyCwd, env: {}, stdin, timeoutMs: TIMEOUT_MS });
    let res: { structured_output?: { winner?: unknown; reason?: unknown }; total_cost_usd?: unknown } = {};
    try { res = JSON.parse(stdout) as typeof res; } catch { /* unusable — thrown below */ }
    const w = res.structured_output?.winner;
    // Thrown, not tied: an outage read as a tie would fail the proposal it was meant to grade.
    if (w !== 'A' && w !== 'B' && w !== 'tie') throw new Error(`judge gave no usable verdict: ${stdout.slice(0, 200)}`);
    const costUsd = typeof res.total_cost_usd === 'number' ? res.total_cost_usd : 0;
    return { winner: w, reason: String(res.structured_output?.reason ?? ''), costUsd };
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
