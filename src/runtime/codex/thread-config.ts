import { transportOf, type McpServerConfig } from '../../integrations/mcp-config.js';
import type { HookTrust } from './hook-trust.js';
import { PRETOOL_HOOK_COMMAND } from './pretool-hook.js';

// Each must read back disabled from experimentalFeature/list, or the session is refused.
export const REQUIRED_OFF_FEATURES = ['unified_exec_tty', 'multi_agent'] as const;

const MCP_HEADER_ENV_PREFIX = 'OUTPOST_MCP_HEADER_';

export interface CodexConfigOpts {
  hookTimeoutSec: number;
  trust?: HookTrust;
  mcpServers: Map<string, McpServerConfig>;
}

const toml = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(',')}}`;
};

// `--config` overrides for one `codex app-server` process, plus the env holding MCP header values (argv shows in `ps`).
export function codexConfigArgs(o: CodexConfigOpts): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const set: [string, unknown][] = [
    ['hooks.PreToolUse', [{ hooks: [{ type: 'command', command: PRETOOL_HOOK_COMMAND, timeout: o.hookTimeoutSec }] }]],
    ['web_search', 'disabled'],
    ...REQUIRED_OFF_FEATURES.map((f): [string, unknown] => [`features.${f}`, false]),
    // Codex's shell inherits its env, and these names slip past its default *KEY*/*SECRET*/*TOKEN* filter.
    ['shell_environment_policy.exclude', [`${MCP_HEADER_ENV_PREFIX}*`]],
  ];
  if (o.trust) set.push(['hooks.state', { [o.trust.key]: { trusted_hash: o.trust.hash } }]);
  let n = 0;
  for (const [name, cfg] of o.mcpServers) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const server = codexMcpServer(cfg, (value) => {
      const key = `${MCP_HEADER_ENV_PREFIX}${n++}`;
      env[key] = value;
      return key;
    });
    if (server) set.push([`mcp_servers.${name}`, server]);
  }
  return { args: set.flatMap(([k, v]) => ['--config', `${k}=${toml(v)}`]), env };
}

// Skipped on Codex: OAuth-only HTTP servers (the grant is in Claude's keychain) and stdio servers carrying env secrets.
function codexMcpServer(cfg: McpServerConfig, envVarFor: (value: string) => string): Record<string, unknown> | undefined {
  if (transportOf(cfg) === 'stdio') {
    if (!cfg.command || (cfg.env && Object.keys(cfg.env).length > 0)) return undefined;
    return { command: cfg.command, ...(cfg.args ? { args: cfg.args } : {}) };
  }
  if (!cfg.url || cfg.type === 'sse' || !cfg.headers || Object.keys(cfg.headers).length === 0) return undefined;
  const envHeaders = Object.fromEntries(Object.entries(cfg.headers).map(([h, v]) => [h, envVarFor(v)]));
  return { url: cfg.url, env_http_headers: envHeaders };
}
