import { classifyTool } from './tool-classify.js';
import { splitShellClauses } from './shell-split.js';

// Live reads a replay must serve from a recording; local files come back from the base-sha worktree.
export function recordableRead(toolName: string, input: unknown, pullBashPatterns: readonly string[]): boolean {
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return true;
  if (toolName === 'Bash') {
    const cmd = (input as { command?: unknown })?.command;
    if (typeof cmd !== 'string') return false;
    const clauses = splitShellClauses(cmd.trim());
    if (!clauses || clauses.length !== 1) return false;
    return pullBashPatterns.some((p) => new RegExp(p).test(cmd.trim()));
  }
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__outpost__')) return false;
  return classifyTool(toolName).effect === 'read';
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return typeof v === 'string' ? v.trim() : v;
}

// Fields the model rewrites freely on every call (a Bash `description`, a WebFetch `prompt`) say
// nothing about what the read returns, and would make a replayed read miss its recording.
const KEYED_FIELDS: Record<string, readonly string[]> = {
  Bash: ['command'],
  WebFetch: ['url'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
};

function keyedInput(toolName: string, input: unknown): unknown {
  const fields = KEYED_FIELDS[toolName];
  if (!fields || !input || typeof input !== 'object') return input;
  const src = input as Record<string, unknown>;
  return Object.fromEntries(fields.filter((f) => src[f] !== undefined).map((f) => [f, src[f]]));
}

export function readInputKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(canonical(keyedInput(toolName, input)))}`;
}

// Re-derives a stored key under the current keying, so reads recorded before a keying change still match.
export function rekeyRead<T extends { tool: string; inputKey: string }>(read: T): T {
  const prefix = `${read.tool}:`;
  if (!read.inputKey.startsWith(prefix)) return read;
  try {
    return { ...read, inputKey: readInputKey(read.tool, JSON.parse(read.inputKey.slice(prefix.length))) };
  } catch {
    return read;
  }
}
