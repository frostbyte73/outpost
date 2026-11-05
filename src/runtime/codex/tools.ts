import { canonicalToolName } from '../tools.js';

const CODEX_TOOLS: Record<string, string> = {
  spawn_agent: 'subagent',
  update_plan: 'todo_write',
  view_image: 'file_read',
};

// Codex's hook payloads already spell shell `Bash` and MCP tools `mcp__<server>__<tool>`.
export function codexCanonicalTool(name: string): string {
  return CODEX_TOOLS[name] ?? canonicalToolName(name);
}
