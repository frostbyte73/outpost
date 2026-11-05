import { describe, it, expect } from 'vitest';
import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeJudge, judgePair, type JudgeOnce } from '../../src/eval/judge.js';

const input = { context: 'ctx', answerKey: 'key', before: 'OLD', after: 'NEW' };

// Picks whichever slot holds the named output, so the result is independent of the order.
const prefers = (text: string, cost = 0.1): JudgeOnce => async ({ a, b }) => ({
  winner: a === text ? 'A' : b === text ? 'B' : 'tie', reason: `liked ${text}`, costUsd: cost,
});

describe('judgePair', () => {
  it('maps a consistent preference back to the version', async () => {
    expect((await judgePair(prefers('NEW'), input)).result).toBe('after');
    expect((await judgePair(prefers('OLD'), input)).result).toBe('before');
  });

  it('calls a position-biased judge a tie', async () => {
    const alwaysA: JudgeOnce = async () => ({ winner: 'A', reason: 'first', costUsd: 0 });
    expect((await judgePair(alwaysA, input)).result).toBe('tie');
  });

  it('keeps a double tie a tie and sums the cost of both calls', async () => {
    const tie: JudgeOnce = async () => ({ winner: 'tie', reason: 'same', costUsd: 0.25 });
    const r = await judgePair(tie, input);
    expect(r).toMatchObject({ result: 'tie', costUsd: 0.5 });
    expect(r.reasons).toHaveLength(2);
  });
});

const result = (over: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, ...over }) as unknown as SDKResultMessage;

describe('claudeJudge', () => {
  it('sends a blind prompt and reads the structured verdict', async () => {
    let prompt = '';
    let options: Options = {};
    const judge = claudeJudge(async (p, o) => {
      prompt = p;
      options = o;
      return result({ structured_output: { winner: 'B', reason: 'closer' }, total_cost_usd: 0.3 });
    });
    const r = await judge({ context: 'x'.repeat(9000), answerKey: 'the user wanted brevity', a: 'long', b: 'short' });
    expect(r).toEqual({ winner: 'B', reason: 'closer', costUsd: 0.3 });
    expect(options).toMatchObject({ strictMcpConfig: true, tools: [], outputFormat: { type: 'json_schema' } });
    expect(prompt).toContain('the user wanted brevity');
    expect(prompt).not.toContain('x'.repeat(8001));
  });

  it('throws on an unusable answer, so an outage can never read as a tie', async () => {
    const judge = claudeJudge(async () => undefined);
    await expect(judge({ context: '', answerKey: '', a: '', b: '' })).rejects.toThrow(/no usable verdict/);
    const empty = claudeJudge(async () => result({ subtype: 'error_during_execution', is_error: true, errors: [] }));
    await expect(empty({ context: '', answerKey: '', a: '', b: '' })).rejects.toThrow(/no usable verdict/);
  });
});
