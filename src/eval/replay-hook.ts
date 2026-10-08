import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatedMatch } from '../permissions/allowlist.js';
import { denyResp, type HookInput, type HookResponse } from '../permissions/hook-handler.js';
import { readInputKey, recordableRead } from '../permissions/read-recording.js';
import { splitShellClauses, stripLeadingAssignments } from '../permissions/shell-split.js';
import type { ActionAllowlist } from '../actions/types.js';
import type { EvalSession } from './eval-sessions.js';

const MAX_REPLAYED_TEXT = 50_000;

const NETWORK_BINARIES = new Set([
  'curl', 'wget', 'gh', 'kubectl', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'http', 'https',
  'aws', 'gcloud', 'az', 'doctl', 'psql', 'mysql', 'redis-cli', 'mongosh', 'grpcurl', 'lk', 'livekit-cli',
]);
const NETWORK_GIT = /^git\s+(?:-C\s+\S+\s+)?(fetch|pull|push|clone|ls-remote|remote\s+update|submodule\s+update)\b/;
const URL_LIKE = /:\/\/|\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0)\b|\$\{?OUTPOST_API_URL/;

// A replay must be hermetic: anything that can reach a server either comes from a recording or doesn't run.
function reachesNetwork(command: string): boolean {
  if (URL_LIKE.test(command)) return true;
  const clauses = splitShellClauses(command.trim());
  if (!clauses) return /\b(curl|wget|gh|kubectl|ssh|git)\b/.test(command);
  return clauses.some((c) => {
    const text = stripLeadingAssignments(c.text.trim());
    return NETWORK_BINARIES.has(text.split(/\s+/)[0] ?? '') || NETWORK_GIT.test(text);
  });
}

export interface ReplayHookDeps {
  allows: (tool: string, input: unknown, action: string, worktree: string | undefined, sessionId: string) => boolean;
  gated: (action: string) => ActionAllowlist | undefined;
  pullPatterns: readonly string[];
  blob: (ref: string) => string | undefined;
}

function allow(updatedInput?: unknown): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(updatedInput !== undefined ? { updatedInput } : {}),
    },
  };
}

function recordedJson(s: EvalSession, toolName: string, input: unknown, deps: ReplayHookDeps): unknown {
  const read = s.reads.get(readInputKey(toolName, input));
  const raw = read ? deps.blob(read.responseRef) : undefined;
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function bashText(resp: unknown): string | undefined {
  const r = resp as { stdout?: unknown; stderr?: unknown } | null;
  if (!r || typeof r.stdout !== 'string') return undefined;
  return typeof r.stderr === 'string' && r.stderr ? `${r.stdout}${r.stderr}` : r.stdout;
}

function webText(resp: unknown): string | undefined {
  if (typeof resp === 'string') return resp;
  const r = resp as { result?: unknown } | null;
  if (r && typeof r.result === 'string') return r.result;
  return resp === undefined || resp === null ? undefined : JSON.stringify(resp);
}

function miss(s: EvalSession): HookResponse {
  s.misses += 1;
  return denyResp('Not available in replay: this exact read was not recorded. Work from what you already have.');
}

// PreToolUse for an eval session: recorded reads are served, writes never happen, local work runs
// in the throwaway worktree under the action's own allowlist.
export function replayPreTool(input: HookInput, s: EvalSession, deps: ReplayHookDeps): HookResponse {
  const { tool_name: tool, tool_input: toolInput } = input;
  const gated = deps.gated(s.action);
  if (gated && gatedMatch(gated, tool, toolInput)) {
    return denyResp('External writes are not available in replay — draft them with mcp__outpost__submit_write_draft instead.');
  }
  if (tool.startsWith('mcp__outpost__')) return allow();
  if (recordableRead(tool, toolInput, deps.pullPatterns)) {
    if (tool.startsWith('mcp__')) {
      return deps.allows(tool, toolInput, s.action, s.worktree, s.sessionId) ? allow() : denyResp('Not permitted for this action.');
    }
    const resp = recordedJson(s, tool, toolInput, deps);
    if (tool === 'Bash') {
      const text = bashText(resp);
      if (text === undefined) return miss(s);
      const dir = join(s.scratchDir, 'reads');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${createHash('sha256').update(readInputKey(tool, toolInput)).digest('hex').slice(0, 16)}.txt`);
      writeFileSync(file, text);
      return allow({ ...(toolInput as object), command: `cat '${file}'` });
    }
    const text = webText(resp);
    if (text === undefined) return miss(s);
    return denyResp(`Replayed response (recorded earlier; treat it as this call's result):\n${text.slice(0, MAX_REPLAYED_TEXT)}`);
  }
  if (tool === 'Bash' && reachesNetwork(String((toolInput as { command?: unknown })?.command ?? ''))) return miss(s);
  if (deps.allows(tool, toolInput, s.action, s.worktree, s.sessionId)) return allow();
  return denyResp(`Not in action \`${s.action}\` allowlist.`);
}
