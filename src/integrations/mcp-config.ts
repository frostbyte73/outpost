import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Shared between routes/meta.ts (GET /api/mcp/status, a reachability probe) and
// integrations/mcp-catalog.ts (a real tools/list enumeration) — both read the same
// mcpServers config shape, and routes compose integrations, not the reverse.
export interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  headers?: Record<string, string>;
}

export function readMcpServersFile(path: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

// Discovers configured MCP servers the same way for every route that needs them: the daemon's
// own mcp-config.json first, then `~/.claude.json`'s "mcpServers" filling in anything not
// already named — claude merges the two for every spawned session (no --strict-mcp-config
// flag), first occurrence wins on a name collision, so reads have to agree with that or a
// route would propose/probe a server the daemon doesn't actually pass through to sessions.
export function mergeMcpServers(mcpConfigPath: string): Map<string, McpServerConfig> {
  const merged = new Map<string, McpServerConfig>();
  for (const [name, cfg] of Object.entries(readMcpServersFile(mcpConfigPath))) merged.set(name, cfg);
  for (const [name, cfg] of Object.entries(readMcpServersFile(join(homedir(), '.claude.json')))) {
    if (!merged.has(name)) merged.set(name, cfg);
  }
  return merged;
}

export function transportOf(cfg: McpServerConfig): 'http' | 'sse' | 'stdio' {
  if (cfg.type === 'sse') return 'sse';
  if (cfg.type === 'stdio' || (!cfg.url && !!cfg.command)) return 'stdio';
  return 'http';
}

// How a server proves who it is, which decides whether it has an OAuth grant to renew at all.
// Shared so the status route and the expiry watcher can't disagree: a server authenticating by
// token header can still carry a stale, empty `mcpOAuth` keychain record (github does), and
// reading that as a lapsed credential would raise an alarm about a server that is working fine.
export function authKindOf(cfg: McpServerConfig): 'oauth' | 'header' | 'stdio' {
  if (transportOf(cfg) === 'stdio') return 'stdio';
  return cfg.headers?.Authorization ? 'header' : 'oauth';
}
