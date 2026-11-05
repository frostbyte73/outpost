import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../../permissions/permission-groups-loader.js';
import { ACP_AGENT_ID } from '../types.js';

export interface AcpAgentConfig {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  // Regex with named groups `server` and `tool`, tested against a tool call's title to name an MCP call.
  mcpTitlePattern?: string;
  shellCommandField: string;
}

// Seeded once; the launch flags and MCP title shapes are best guesses until checked against the real agent.
const SEEDED: AcpAgentConfig[] = [
  {
    id: 'gemini',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: {},
    mcpTitlePattern: '^(?<tool>[\\w-]+) \\((?<server>[\\w-]+) MCP Server\\)$',
    shellCommandField: 'command',
  },
  {
    id: 'opencode',
    command: 'opencode',
    args: ['acp'],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } }) },
    mcpTitlePattern: '^(?<server>[a-zA-Z0-9-]+)_(?<tool>.+)$',
    shellCommandField: 'command',
  },
];

// The configured ACP agents, seeding the file with known agents the first time; a bad entry is skipped, never fatal.
export function loadAcpAgents(path: string): AcpAgentConfig[] {
  if (!existsSync(path)) {
    try { writeJsonAtomic(path, { agents: SEEDED }); } catch (e) {
      console.error(`[acp] could not write ${path}; using the built-in agents for this run: ${(e as Error).message}`);
    }
    return SEEDED;
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    console.error(`[acp] ${path} is not valid JSON, so no ACP agents are configured: ${(e as Error).message}`);
    return [];
  }
  const entries = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(entries)) {
    console.error(`[acp] ${path} has no "agents" array, so no ACP agents are configured`);
    return [];
  }
  const out: AcpAgentConfig[] = [];
  entries.forEach((e, i) => {
    const agent = parseAgent(e, out);
    if (typeof agent === 'string') console.error(`[acp] skipping agent ${i}: ${agent}`);
    else out.push(agent);
  });
  return out;
}

function parseAgent(e: unknown, seen: AcpAgentConfig[]): AcpAgentConfig | string {
  if (!e || typeof e !== 'object') return 'not an object';
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ACP_AGENT_ID.test(o.id)) return 'id must match [a-z0-9][a-z0-9-]*';
  if (seen.some((a) => a.id === o.id)) return `duplicate id ${o.id}`;
  if (typeof o.command !== 'string' || !o.command) return 'command must be a non-empty string';
  const args = o.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return 'args must be a string[]';
  const env = o.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((v) => typeof v === 'string')) {
    return 'env must map names to strings';
  }
  if (o.mcpTitlePattern !== undefined) {
    if (typeof o.mcpTitlePattern !== 'string') return 'mcpTitlePattern must be a string';
    try { new RegExp(o.mcpTitlePattern); } catch { return 'mcpTitlePattern is not a valid regex'; }
    if (!o.mcpTitlePattern.includes('(?<server>') || !o.mcpTitlePattern.includes('(?<tool>')) {
      return 'mcpTitlePattern needs named groups server and tool';
    }
  }
  const shell = o.shellCommandField ?? 'command';
  if (typeof shell !== 'string' || !shell) return 'shellCommandField must be a non-empty string';
  return {
    id: o.id,
    command: o.command,
    args: args as string[],
    env: env as Record<string, string>,
    ...(o.mcpTitlePattern !== undefined ? { mcpTitlePattern: o.mcpTitlePattern } : {}),
    shellCommandField: shell,
  };
}
