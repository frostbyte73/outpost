import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface DaemonSettingsOpts {
  outPath: string;
  hookPort: number;
}

export interface McpConfigOpts {
  outPath: string;
  hookPort: number;
  daemonAuthSecret: string;
}

// Loopback HTTP hook entry; claude refuses non-loopback URLs for SSRF safety.
function loopbackHook(hookPort: number, route: string, timeout: number, matcher = '') {
  return {
    matcher,
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${hookPort}${route}`,
        timeout,
        headers: { 'X-Daemon-Auth': '$DAEMON_AUTH' },
        allowedEnvVars: ['DAEMON_AUTH'],
      },
    ],
  };
}

// Shell command run by claude as the status-line builder. claude pipes a rich JSON
// payload to stdin (model, context_window.{size,used_percentage,current_usage}, cost,
// rate_limits, effort — see https://code.claude.com/docs/en/statusline#available-data).
// We POST that payload to the daemon's loopback hook server (fire-and-forget in a
// backgrounded subshell so a slow daemon never blocks claude's UI), then emit a short
// one-liner to stdout that's visible in the CLI status bar. The PWA's context-window
// meter is driven by the POSTed payload, not the stdout text.
//
// $DAEMON_AUTH is exported into claude's env by ClaudeProc (src/claude-proc.ts) — shell
// subprocesses inherit it, so no allowedEnvVars declaration is needed (that's an HTTP
// hook concern, not a command-hook one).
function statusLineCommand(hookPort: number): string {
  const url = `http://127.0.0.1:${hookPort}/hook/statusline`;
  return [
    'i=$(cat)',
    `{ printf '%s' "$i" | curl -s -m 2 -X POST -H "X-Daemon-Auth: $DAEMON_AUTH" -H 'content-type: application/json' --data-binary @- ${url} >/dev/null 2>&1; } & disown`,
    `printf '%s' "$i" | jq -r '"\\(.model.display_name) · \\((.context_window.used_percentage // 0) | floor)% ctx"' 2>/dev/null`,
  ].join('; ');
}

export function writeDaemonSettings(opts: DaemonSettingsOpts): void {
  const cfg = {
    hooks: {
      PreToolUse: [loopbackHook(opts.hookPort, '/hook/pretool', 600)],
      // Only tools whose responses can be recorded for eval replay; failures have their own event.
      PostToolUse: [loopbackHook(opts.hookPort, '/hook/posttool', 30, 'Bash|WebFetch|WebSearch|mcp__.*')],
      PostToolUseFailure: [loopbackHook(opts.hookPort, '/hook/posttoolfail', 30)],
      Stop: [loopbackHook(opts.hookPort, '/hook/stop', 30)],
      // Fires instead of Stop when an API error ended the turn — without it that turn never ends.
      StopFailure: [loopbackHook(opts.hookPort, '/hook/stop-failure', 30)],
    },
    statusLine: {
      type: 'command',
      command: statusLineCommand(opts.hookPort),
    },
  };
  writeFileSync(opts.outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Claude Code's `--settings` file ignores any `mcpServers` block — MCP servers only
// register via `--mcp-config <path>`. Write a separate file for that flag. Header
// interpolation (`$DAEMON_AUTH` + `allowedEnvVars`) is hook-only and doesn't apply
// here, so the literal secret is inlined; the file is per-launch, chmod 600, gitignored.
export function writeMcpConfig(opts: McpConfigOpts): void {
  const cfg = {
    mcpServers: {
      outpost: {
        type: 'http',
        url: `http://127.0.0.1:${opts.hookPort}/mcp`,
        headers: { 'X-Daemon-Auth': opts.daemonAuthSecret },
      },
    },
  };
  writeFileSync(opts.outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// An eval replay keeps only the gate: no Stop/statusline hooks, so it can't touch any session's state.
export function writeEvalSettings(outPath: string, hookPort: number): void {
  const cfg = { hooks: { PreToolUse: [loopbackHook(hookPort, '/hook/pretool', 600)] } };
  writeFileSync(outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function writeEvalMcpConfig(opts: McpConfigOpts & { sessionId: string; replayServers: string[] }): void {
  const server = (route: string) => ({
    type: 'http',
    url: `http://127.0.0.1:${opts.hookPort}${route}`,
    headers: { 'X-Daemon-Auth': opts.daemonAuthSecret },
  });
  const sid = encodeURIComponent(opts.sessionId);
  const mcpServers: Record<string, unknown> = { outpost: server(`/mcp/eval/${sid}`) };
  for (const name of opts.replayServers) mcpServers[name] = server(`/mcp/replay/${sid}/${encodeURIComponent(name)}`);
  writeFileSync(opts.outPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
}

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
