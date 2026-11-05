import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { sdkExecutable } from './bin.js';

export type RunClaudeOnce = (
  prompt: string,
  options: Options,
  limits: { timeoutMs: number; signal?: AbortSignal },
) => Promise<SDKResultMessage | undefined>;

// Eval, judge and PR-draft runs aren't SessionManager sessions, so the daemon's shutdown aborts them through this.
const live = new Set<AbortController>();

export function killOneShots(): number {
  const n = live.size;
  for (const c of live) c.abort();
  live.clear();
  return n;
}

const STDERR_TAIL_CHARS = 300;

// One prompt to its result frame; undefined when it was aborted or timed out before producing one.
export const runClaudeOnce: RunClaudeOnce = async (prompt, options, { timeoutMs, signal }) => {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  live.add(abortController);
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let result: SDKResultMessage | undefined;
  let stderr = '';
  const stderrTail = (d: string) => { stderr = (stderr + d).slice(-STDERR_TAIL_CHARS); };
  try {
    for await (const msg of query({ prompt, options: { ...sdkExecutable(), stderr: stderrTail, ...options, abortController } })) {
      if (msg.type === 'result') result = msg;
    }
    return result;
  } catch (e) {
    if (abortController.signal.aborted) return result;
    throw stderr.trim() ? new Error(`${(e as Error).message} (${stderr.trim()})`) : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    live.delete(abortController);
  }
};
