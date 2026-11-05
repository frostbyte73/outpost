import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { codexCanonicalTool } from './tools.js';
import type { GateDecision, GateRequest } from '../types.js';

export interface CodexPreToolPayload {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  cwd: string;
  agent_id?: string;
  agent_type?: string;
}

export interface PatchTarget {
  tool: 'file_write' | 'file_edit';
  file_path: string;
}

const UNPARSEABLE_PATCH = 'Outpost could not read which files this patch touches, so it was not applied.';
const FOREIGN_WORKDIR = 'Outpost gates shell commands against the session directory only. Run this without a different '
  + 'working directory, using paths relative to the session directory or absolute paths.';

// Every file an apply_patch envelope writes, deletes or moves to; null when it names none.
export function patchTargets(patch: string, cwd: string): PatchTarget[] | null {
  if (!/^\*\*\* Begin Patch\s*$/m.test(patch)) return null;
  const at = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const targets: PatchTarget[] = [];
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line);
    if (!m) continue;
    const kind = m[1]!;
    targets.push({ tool: kind === 'Add File' || kind === 'Move to' ? 'file_write' : 'file_edit', file_path: at(m[2]!) });
  }
  return targets.length > 0 ? targets : null;
}

// The gate's answer to one Codex PreToolUse call, decomposing a multi-file patch into per-file checks.
export async function decideCodexPreTool(
  p: CodexPreToolPayload,
  sessionFor: (threadId: string) => { sessionId: string; cwd: string } | undefined,
  gate: (req: GateRequest) => Promise<GateDecision>,
): Promise<GateDecision> {
  const session = sessionFor(p.session_id);
  if (!session) return { allow: false, reason: 'This Codex thread is not one Outpost started, so the call was not run.' };
  // The gate reads a command's relative paths against the session directory, so it can't judge one run elsewhere.
  if (p.tool_name === 'Bash' && !sameDir(p.cwd, session.cwd)) return { allow: false, reason: FOREIGN_WORKDIR };
  const subagent = p.agent_id ? { agentId: p.agent_id, ...(p.agent_type ? { agentType: p.agent_type } : {}) } : undefined;
  const base = { sessionId: session.sessionId, toolUseId: p.tool_use_id, ...(subagent ? { subagent } : {}) };
  if (p.tool_name === 'view_image') {
    const path = (p.tool_input as { path?: unknown } | null)?.path;
    if (typeof path !== 'string') return { allow: false, reason: 'view_image needs a path.' };
    return gate({ ...base, tool: 'file_read', rawName: p.tool_name, input: { file_path: resolve(p.cwd, path) } });
  }
  if (p.tool_name !== 'apply_patch') {
    return gate({ ...base, tool: codexCanonicalTool(p.tool_name), rawName: p.tool_name, input: p.tool_input });
  }
  const patch = typeof p.tool_input === 'string' ? p.tool_input : (p.tool_input as { command?: unknown } | null)?.command;
  const targets = typeof patch === 'string' ? patchTargets(patch, p.cwd) : null;
  if (!targets) return { allow: false, reason: UNPARSEABLE_PATCH };
  for (const t of targets) {
    const d = await gate({ ...base, tool: t.tool, rawName: 'apply_patch', input: { file_path: t.file_path } });
    if (!d.allow) return d;
  }
  return { allow: true };
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}
