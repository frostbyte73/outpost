import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveClaudeBin } from '../session/claude-proc.js';
import { stripAnsi } from './cli-login.js';

// claude.ai connectors are account-level: nothing in `mcpServers` names them, so
// mergeMcpServers cannot see them and neither could the MCP panel. They are not optional
// extras here — this repo's own permission groups grant against `mcp__claude_ai_Linear__`,
// `mcp__claude_ai_Slack__` and `mcp__claude_ai_DataDog_MCP__`, so a lapsed connector breaks
// actions exactly the way a lapsed local server does.
//
// `claude mcp list` is the only enumeration available and it health-checks every row, costing
// ~11s for 39 servers. Hence the cache: this is fetched on the panel's own schedule, never on
// a path that blocks a paint.

const LIST_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;
const CONNECTOR_PREFIX = 'claude.ai ';

export type ConnectorStatus = 'connected' | 'needs-auth' | 'pending' | 'error';

export interface McpConnector {
  name: string;
  target: string;
  status: ConnectorStatus;
  // Connected now, or in ~/.claude.json's `claudeAiMcpEverConnected`. The panel leads with
  // these: the ~20 a user has never touched are noise next to the ones they actually rely on.
  relevant: boolean;
}

const execFileAsync = promisify(execFile);

function statusOf(text: string): ConnectorStatus {
  if (/Connected/i.test(text)) return 'connected';
  if (/Needs authentication/i.test(text)) return 'needs-auth';
  if (/Pending approval/i.test(text)) return 'pending';
  return 'error';
}

// Rows look like `<name>: <target>[ (HTTP)] - <status>`, where the name can hold spaces and
// dots ("claude.ai DataDog MCP") and a stdio target can hold spaces too. So the status splits
// off the LAST ` - ` and the name off the FIRST `: `.
export function parseListOutput(raw: string): { name: string; target: string; status: ConnectorStatus }[] {
  const rows: { name: string; target: string; status: ConnectorStatus }[] = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    const sep = trimmed.lastIndexOf(' - ');
    if (sep === -1) continue;
    const colon = trimmed.indexOf(': ');
    if (colon === -1 || colon > sep) continue;
    const name = trimmed.slice(0, colon).trim();
    if (!name) continue;
    rows.push({
      name,
      target: trimmed.slice(colon + 2, sep).trim(),
      status: statusOf(trimmed.slice(sep + 3)),
    });
  }
  return rows;
}

function everConnected(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as
      { claudeAiMcpEverConnected?: unknown };
    const list = raw.claudeAiMcpEverConnected;
    return new Set(Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

export class McpConnectorList {
  private cache: { at: number; connectors: McpConnector[] } | null = null;
  private inFlight: Promise<McpConnector[]> | null = null;

  // Coalesced and cached: two panels mounting at once must not pay 11s twice, and a `force`
  // refresh right after an authorization is the one case worth paying it again for.
  async list(force = false): Promise<McpConnector[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.connectors;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetch().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetch(): Promise<McpConnector[]> {
    let raw: string;
    try {
      const { stdout, stderr } = await execFileAsync(resolveClaudeBin(), ['mcp', 'list'],
        { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      raw = `${stdout}\n${stderr}`;
    } catch (e) {
      // A stale list beats none — a health check timing out says nothing about which
      // connectors exist.
      if (this.cache) return this.cache.connectors;
      throw new Error(`could not list MCP servers: ${(e as Error).message}`);
    }
    const ever = everConnected();
    const connectors = parseListOutput(raw)
      .filter((r) => r.name.startsWith(CONNECTOR_PREFIX))
      .map((r) => ({ ...r, relevant: r.status === 'connected' || ever.has(r.name) }))
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.name.localeCompare(b.name));
    this.cache = { at: Date.now(), connectors };
    return connectors;
  }
}
