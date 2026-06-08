# claude-relay

A small macOS LaunchAgent that runs Claude Code as a background service so you can drive it from your phone (or any device on your Tailnet) while you're away from your laptop. Built for incident response: get paged, open the PWA, ask Claude to investigate, approve or deny each privileged tool call as it goes.

## What it does

- Spawns `claude` subprocesses on demand and pipes their stream-JSON output over WebSocket to a small PWA.
- Serves the PWA over HTTPS using your Tailscale node's cert, so it's only reachable from your own tailnet.
- Intercepts every `PreToolUse` hook from Claude. Tools matching your allowlist run automatically; everything else is queued as a pending approval surfaced in the PWA.
- Persists Claude's session JSONL files in the standard location, so resuming a session from your laptop later picks up the full transcript.

## Prerequisites

- **macOS** (this is a launchd LaunchAgent; nothing else is supported).
- **Node.js 22+** on `PATH`.
- **Claude Code CLI** (`claude`) installed and authenticated for the user the daemon runs as.

## Install

### 1. Sign into Tailscale and enable HTTPS

Install Tailscale and sign into your tailnet. Then enable HTTPS certificates and MagicDNS for the tailnet in the admin console — follow Tailscale's [HTTPS / MagicDNS setup guide](https://tailscale.com/kb/1153/enabling-https). The daemon needs both: MagicDNS gives your Mac a stable `<host>.ts.net` name, and the HTTPS feature lets you provision a real cert for it in the next step.

Confirm Tailscale is up and figure out your tailnet hostname:

```bash
tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'
# → e.g. davids-macbook-pro.tail1234.ts.net
```

Save that hostname — you'll use it in the next step.

### 2. Provision a TLS cert+key for that hostname

```bash
mkdir -p ~/.claude-relay
HOST=davids-macbook-pro.tail1234.ts.net   # ← your hostname from step 1
tailscale cert \
  --cert-file ~/.claude-relay/$HOST.crt \
  --key-file  ~/.claude-relay/$HOST.key \
  $HOST
```

The daemon reads these files at startup. If they're missing or unreadable it'll exit with the exact `tailscale cert` command to run, so you can also skip this step and let the daemon tell you what to type.

### 3. Clone and install deps

```bash
git clone https://github.com/frostbyte73/claude-relay.git
cd claude-relay
npm install
```

By default, sessions spawned by the daemon run with `cwd=$HOME`. To inherit a specific project's `CLAUDE.md`, plugins, and MCP servers, export `CLAUDE_RELAY_CWD` now — any `CLAUDE_RELAY_*` env var in your shell when you run `install.sh` (step 5) gets baked into the LaunchAgent plist.

```bash
export CLAUDE_RELAY_CWD=$HOME/path/to/your/workspace
```

See [Configuration](#configuration) for the full list of env vars.

### 4. Review the allowlist

`config/allowlist.json` controls which tools auto-approve vs. queue for explicit confirmation in the PWA. The defaults are tuned for read-only incident-response work — open the file and trim or extend it before going live. See [Allowlist](#allowlist) below.

### 5. Install the LaunchAgent

```bash
install/install.sh
```

This writes `~/Library/LaunchAgents/local.claude-relay.$USER.plist`, loads it, and prints the pid on success. The daemon starts at every login and auto-restarts on crash. Logs land in `~/Library/Logs/claude-relay.{log,err.log}`.

### 6. Open the PWA

From any device on your tailnet, open `https://<your-tailnet-hostname>.ts.net:8443/`. On iOS, "Add to Home Screen" makes it feel like a native app.

## Configuration

All configuration is via environment variables read at daemon startup. To make them stick across reinstalls, export them in the shell you run `install/install.sh` from — any `CLAUDE_RELAY_*` var in your environment is baked into the plist automatically.

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_RELAY_CWD` | `$HOME` | Working directory Claude subprocesses are spawned in. Point this at the workspace that holds the `CLAUDE.md`, project plugins, and MCP servers you want relayed sessions to inherit. |
| `CLAUDE_RELAY_SESSION_DIR` | derived from `CLAUDE_RELAY_CWD` | Where to read Claude's session JSONL files from. Only set this if you're doing something unusual. |
| `CLAUDE_RELAY_PLIST_LABEL` | `local.claude-relay.$USER` | LaunchAgent label. Set this if you want an org-style prefix like `com.example.claude-relay`. |

### Allowlist

`config/allowlist.json` controls which tool calls run without prompting. There are three lists:

- `alwaysAllow`: exact tool names that always pass (e.g. `Read`, `Grep`).
- `alwaysAllowBashPatterns`: regex matched against the `command` arg of `Bash` calls.
- `alwaysAllowMcpPatterns`: regex matched against MCP tool names (`mcp__<server>__<tool>`).

The defaults are tuned for incident response (kubectl read-only, gh read-only, incident.io read tools, Datadog read tools, etc.). **Review and edit before using.** Anything not matched gets queued for explicit approval in the PWA.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/local.claude-relay.$USER.plist
rm ~/Library/LaunchAgents/local.claude-relay.$USER.plist
rm -rf ~/.claude-relay
```

## Development

```bash
npm run dev    # tsx watch, reloads on change
npm test       # vitest
```

The daemon expects to bind `:8443` (PWA + WS) and `:8444` (loopback hook endpoint). The hook endpoint is loopback-only and authenticated with a per-launch secret that's written into Claude's `settings.json` at startup — see `src/hook-server.ts` for the rationale.

## Architecture

- `src/daemon.ts` — wires everything together; main entrypoint.
- `src/server.ts` — the HTTPS + WS server that backs the PWA.
- `src/hook-server.ts` — the loopback HTTP endpoint Claude's `PreToolUse` hook posts to.
- `src/session-manager.ts` — owns the live Claude subprocesses and per-session WebSocket fanout.
- `src/session-store.ts` — reads session JSONLs off disk for transcript replay.
- `src/approvals.ts` — the pending-approval queue.
- `src/allowlist.ts` — matches incoming tool calls against the allowlist.
- `src/pwa/` — the static PWA assets served at `/`.
