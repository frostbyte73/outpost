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

export function readInputKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(canonical(input))}`;
}
