import type { ToolKind } from './types.js';

// Must stay one-to-one: merging two Claude tools onto one canonical name widens every rule naming either.
const CLAUDE_TOOLS: ReadonlyArray<readonly [claude: string, canonical: string, kind: ToolKind]> = [
  ['Bash', 'shell', 'command_execution'],
  ['Read', 'file_read', 'file_read'],
  ['Glob', 'file_glob', 'file_read'],
  ['Grep', 'file_grep', 'file_read'],
  ['LS', 'file_list', 'file_read'],
  ['NotebookRead', 'notebook_read', 'file_read'],
  ['Write', 'file_write', 'file_change'],
  ['Edit', 'file_edit', 'file_change'],
  ['MultiEdit', 'file_multi_edit', 'file_change'],
  ['NotebookEdit', 'notebook_edit', 'file_change'],
  ['WebFetch', 'web_fetch', 'web_fetch'],
  ['WebSearch', 'web_search', 'web_search'],
  ['Agent', 'subagent', 'collab_agent_tool_call'],
  ['AskUserQuestion', 'ask_user', 'dynamic_tool_call'],
  ['SendMessage', 'send_message', 'dynamic_tool_call'],
  ['TaskCreate', 'task_create', 'dynamic_tool_call'],
  ['TaskUpdate', 'task_update', 'dynamic_tool_call'],
  ['TaskList', 'task_list', 'dynamic_tool_call'],
  ['TaskGet', 'task_get', 'dynamic_tool_call'],
  ['TodoWrite', 'todo_write', 'dynamic_tool_call'],
  ['ToolSearch', 'tool_search', 'dynamic_tool_call'],
  ['Skill', 'skill', 'dynamic_tool_call'],
  ['ExitPlanMode', 'exit_plan_mode', 'dynamic_tool_call'],
];

const FROM_CLAUDE = new Map(CLAUDE_TOOLS.map(([c, n]) => [c, n]));
const TO_CLAUDE = new Map(CLAUDE_TOOLS.map(([c, n]) => [n, c]));
const KINDS = new Map(CLAUDE_TOOLS.map(([, n, k]) => [n, k]));

export const CLAUDE_TOOL_NAMES: ReadonlyArray<readonly [claude: string, canonical: string]> =
  CLAUDE_TOOLS.map(([c, n]) => [c, n] as const);

export function isMcpTool(tool: string): boolean {
  return tool.startsWith('mcp:');
}

// Maps a Claude spelling to its canonical name; canonical, `mcp:` and `native:` names pass through.
export function canonicalToolName(name: string): string {
  const mapped = FROM_CLAUDE.get(name);
  if (mapped) return mapped;
  if (TO_CLAUDE.has(name) || isMcpTool(name) || name.startsWith('native:')) return name;
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0 && sep < rest.length - 2) return `mcp:${rest.slice(0, sep)}/${rest.slice(sep + 2)}`;
  }
  return `native:${name}`;
}

// Maps a rule's tool name; rules only ever matched Claude spellings, so a canonical one maps to a name no call carries.
export function fromRuleSpelling(name: string): string {
  if (FROM_CLAUDE.has(name)) return FROM_CLAUDE.get(name)!;
  if (TO_CLAUDE.has(name) || isMcpTool(name) || name.startsWith('native:')) return `rule:${name}`;
  return canonicalToolName(name);
}

export function toolKind(tool: string): ToolKind {
  if (isMcpTool(tool)) return 'mcp_tool_call';
  return KINDS.get(tool) ?? 'dynamic_tool_call';
}

// MCP rules are regexes written against `mcp__<server>__<tool>`, so that is the spelling they test.
export function legacyMcpSpelling(tool: string): string {
  if (!isMcpTool(tool)) return tool;
  const body = tool.slice('mcp:'.length);
  const slash = body.indexOf('/');
  return `mcp__${body.slice(0, slash)}__${body.slice(slash + 1)}`;
}

// The spelling persisted rules and user-facing messages use for a canonical tool.
export function ruleSpelling(tool: string): string {
  if (isMcpTool(tool)) return legacyMcpSpelling(tool);
  if (tool.startsWith('native:')) return tool.slice('native:'.length);
  return TO_CLAUDE.get(tool) ?? tool;
}
