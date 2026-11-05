import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveClaudeBin } from '../runtime/claude/bin.js';
import { stripAnsi } from './cli-login.js';

// claude.ai connectors are account-level: nothing in `mcpServers` names them, so
// mergeMcpServers cannot see them and neither could the MCP panel. They are not optional
// extras here — this repo's own permission groups grant against `mcp__claude_ai_Linear__`,
// `mcp__claude_ai_Slack__` and `mcp__claude_ai_Datadog__`, so a lapsed connector breaks
// actions exactly the way a lapsed local server does.
//
// `claude mcp list` is the only enumeration available and it health-checks every row, costing
// ~7-11s. Hence the persisted list: the panel paints the last known one instantly and
// revalidates behind it, including across daemon restarts.
//
// The CLI also drops a connector from its enumeration entirely once it has needed auth for a
// while (`claude mcp get` then answers "No MCP server named …"), so a connector the user relies
// on would silently disappear. A relevant one absent from the latest list is kept as `missing`.

const LIST_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;
const CONNECTOR_PREFIX = 'claude.ai ';

export type ConnectorStatus = 'connected' | 'needs-auth' | 'pending' | 'error' | 'missing';

export interface McpConnector {
  name: string;
  target: string;
  status: ConnectorStatus;
  // Connected now, or in ~/.claude.json's `claudeAiMcpEverConnected`. The panel leads with
  // these: the ~20 a user has never touched are noise next to the ones they actually rely on.
  relevant: boolean;
  lastSeenAt?: number;
}

export interface ConnectorSnapshot {
  connectors: McpConnector[];
  // null until the first `claude mcp list` has ever succeeded.
  fetchedAt: number | null;
  stale: boolean;
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

// Folds a fresh `claude mcp list` into the previous list. Only relevant connectors survive
// being unlisted — a never-touched one leaving the catalog is not news.
export function mergeConnectors(
  listed: { name: string; target: string; status: ConnectorStatus }[],
  previous: McpConnector[],
  ever: Set<string>,
  now: number,
): McpConnector[] {
  const prevByName = new Map(previous.map((c) => [c.name, c]));
  const merged: McpConnector[] = listed
    .filter((r) => r.name.startsWith(CONNECTOR_PREFIX))
    .map((r) => ({
      ...r,
      relevant: r.status === 'connected' || ever.has(r.name) || !!prevByName.get(r.name)?.relevant,
      lastSeenAt: now,
    }));
  const seen = new Set(merged.map((c) => c.name));
  const keep = new Set([...ever, ...previous.filter((c) => c.relevant).map((c) => c.name)]);
  for (const name of keep) {
    if (seen.has(name) || !name.startsWith(CONNECTOR_PREFIX)) continue;
    const prev = prevByName.get(name);
    merged.push({ name, target: prev?.target ?? '', status: 'missing', relevant: true, lastSeenAt: prev?.lastSeenAt });
  }
  return merged.sort((a, b) => Number(b.relevant) - Number(a.relevant)
    || Number(a.status === 'missing') - Number(b.status === 'missing')
    || a.name.localeCompare(b.name));
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class McpConnectorList {
  private connectors: McpConnector[] = [];
  private fetchedAt: number | null = null;
  private inFlight: Promise<ConnectorSnapshot> | null = null;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt?: unknown; connectors?: unknown };
      if (Array.isArray(parsed.connectors)) this.connectors = parsed.connectors as McpConnector[];
      if (typeof parsed.fetchedAt === 'number') this.fetchedAt = parsed.fetchedAt;
    } catch (e) {
      console.warn(`[mcp-connectors] ignoring unreadable ${path}: ${(e as Error).message}`);
    }
  }

  snapshot(): ConnectorSnapshot {
    return {
      connectors: this.connectors,
      fetchedAt: this.fetchedAt,
      stale: this.fetchedAt === null || Date.now() - this.fetchedAt >= CACHE_TTL_MS,
    };
  }

  // Coalesced: two panels mounting at once must not pay the health check twice.
  async refresh(force = false): Promise<ConnectorSnapshot> {
    if (!force && !this.snapshot().stale) return this.snapshot();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetch().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetch(): Promise<ConnectorSnapshot> {
    let raw: string;
    try {
      const { stdout, stderr } = await execFileAsync(resolveClaudeBin(), ['mcp', 'list'],
        { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      raw = `${stdout}\n${stderr}`;
    } catch (e) {
      // A stale list beats none — a health check timing out says nothing about which
      // connectors exist.
      if (this.fetchedAt !== null) return this.snapshot();
      throw new Error(`could not list MCP servers: ${(e as Error).message}`);
    }
    const now = Date.now();
    this.connectors = mergeConnectors(parseListOutput(raw), this.connectors, everConnected(), now);
    this.fetchedAt = now;
    try {
      atomicWrite(this.path, JSON.stringify({ fetchedAt: now, connectors: this.connectors }, null, 2) + '\n');
    } catch (e) {
      console.warn(`[mcp-connectors] could not persist ${this.path}: ${(e as Error).message}`);
    }
    return this.snapshot();
  }
}
