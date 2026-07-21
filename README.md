# Outpost

**A command center for Claude Code.** Outpost is a background daemon that runs on your Mac and exposes a polished PWA — a single control surface for starting, watching, approving, and shipping Claude Code work across every project on the machine, from whatever device you're at.

Open it in a browser tab next to your editor, or reach it from another device on your network. Pick a project, start a session, approve tool calls as they run, review the diff, and open the PR — without dropping into a terminal for each step.

## Features

### Multi-project workspace

Every project under `~/.claude/projects/` shows up in a grouped list with its live, archived, and worktree-bound sessions. Pick a project, pick a branch (or start a fresh session), and you're in — `CLAUDE.md`, plugins, and MCP servers inherited from that workspace.

<img src="docs/screenshots/projects.png" width="300" alt="Projects list with worktree branches and recent sessions" />

### Permission modes that match the moment

Toggle the session between **Ask**, **Plan**, **Accept Edits**, and **Bypass** from the header — same vocabulary as the CLI, surfaced as a one-tap menu. Each session remembers its own mode; set a different default for new sessions in Settings.

<img src="docs/screenshots/modes.png" width="300" alt="Per-session permission mode picker explaining Ask, Plan, Accept Edits, and Bypass" />

### Selective approvals — no rubber-stamping

Every `PreToolUse` is intercepted. Reads, greps, and other safe calls run automatically per your allowlist; anything else (writes, bash, MCP side effects) queues an inline **Approve / Reject** card right where it would have run — including inside subagent feeds, so you can stop a runaway agent before it lands.

<img src="docs/screenshots/approvals.png" width="300" alt="Inline approve/reject card inside a subagent feed" />

### Tool tiles that read like the CLI

Each tool call is rendered with per-tool chrome — git-style diffs for `Edit`, shell-prompt blocks for `Bash`, ripgrep equivalents for `Grep`, Read excerpts, and so on — so a transcript scrolls like a story, not a JSON dump.

<img src="docs/screenshots/tools.png" width="300" alt="Edit tile rendered as a unified diff, Bash tile as a shell block" />

### Subagents in their own lanes

Agent-spawned work gets its own tabbed feed with the spawn context pinned at the top. Watch each agent's tool calls live, switch between them, and approve their pending calls without losing your place in the parent transcript.

<img src="docs/screenshots/agents.png" width="300" alt="Subagent feed showing live commands and the spawn context" />

### Task list panel

The session's todo list — in progress, completed, with strikethrough — one tap away. Useful for long sessions where you want a glance at "how much is left."

<img src="docs/screenshots/tasks.png" width="300" alt="Task list panel showing 19 of 20 complete" />

### Inline `AskUserQuestion`

When Claude needs a decision, the question lands as a real card — multi-select where applicable, with a freeform reply box always available.

<img src="docs/screenshots/ask.png" width="300" alt="AskUserQuestion card with options and a freeform reply box" />

### Source control, without a terminal

A full git overlay on every session: browse the log, stage hunks, write a commit message, push, and open a PR — without ever touching a terminal. Powered by local `git` and `gh`, so commits and PRs land under your real identity.

<p>
  <img src="docs/screenshots/git-log.png" width="240" alt="Git log view with recent commits and sync status" />
  <img src="docs/screenshots/git-commit.png" width="240" alt="Diff viewer with stage checkboxes and commit composer" />
  <img src="docs/screenshots/git-pr.png" width="240" alt="Open pull request modal with title and body fields" />
</p>

### Context and usage at a glance

A live readout of model, context %, cache breakdown, and your 5-hour / 7-day usage windows — so you know when you're about to hit a limit before Claude does.

<img src="docs/screenshots/context.png" width="300" alt="Context details panel showing cache breakdown and rate-limit windows" />

### Themes that don't look like every other dev tool

Nine hand-tuned palettes — Halcyon, Almanac, Terminal, Nordic, Ink, Botanical, Plasma, Atlas, Library — light and dark, plus the per-default permission mode picker, all in one Settings sheet.

<img src="docs/screenshots/themes.png" width="300" alt="Theme picker and default-mode selector" />

## Quick start

Run Outpost on the Mac where your projects live:

```bash
git clone https://github.com/frostbyte73/outpost.git
cd outpost
npm install
npm start
```

Then open `http://localhost:8080` in your browser. That's it — the daemon binds the PWA to loopback and you're in. `npm start` runs it in the foreground for a quick look; to keep it running on login and restarting on crash, install it as a background daemon (below). To reach it from another device, see [Remote access over Tailscale](#remote-access-over-tailscale-optional) near the bottom — the localhost listener stays available either way.

## Prerequisites

- **macOS** (this is a launchd LaunchAgent; nothing else is supported).
- **Node.js 22+** on `PATH`.
- **Claude Code CLI** (`claude`) installed and authenticated for the user the daemon runs as.
- **GitHub CLI** (`gh`), if you want to use the source-control overlay's "Open PR" flow. `brew install gh && gh auth login`.

> **The daemon has to be running.** Outpost runs locally on your Mac, so the PWA is only reachable while the machine is awake. The installer wraps the daemon in `caffeinate -is` to block idle and AC-power system sleep, but closing the lid on a Mac without an external display still triggers sleep regardless. If you want Outpost reachable while you're away from the machine, leave it plugged in with the lid open.

## Run it in the background

`npm start` is a one-shot foreground process. For everyday use, install Outpost as a LaunchAgent so it starts at login and restarts on crash.

### (Optional) Set up secrets in `~/.outpost/.env`

macOS launchd strips your shell's env when it spawns the daemon, so anything Claude subprocesses need at runtime — `GITHUB_TOKEN`, MCP server credentials, etc. — has to be made available to the daemon explicitly. The simplest way is a `~/.outpost/.env` file the daemon sources at startup:

```bash
cat > ~/.outpost/.env <<'EOF'
# Required if you want PR creation / `gh pr view` in the source-control overlay
# to act under a specific identity. Otherwise gh falls back to its own auth.
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Any other secrets your MCP servers or hooks expect, e.g.:
# ANTHROPIC_API_KEY=sk-ant-...
# LINEAR_API_KEY=lin_api_...
EOF
chmod 600 ~/.outpost/.env
```

Standard `KEY=value` syntax, `#` comments allowed, `export KEY=value` tolerated. Anything already set in the plist or shell wins over the file, so the file is the safe place for secrets you don't want baked into LaunchAgent XML.

### Review the allowlist

`config/allowlist.default.json` ships the defaults for which tools auto-approve vs. queue for explicit confirmation in the PWA. On first daemon start it's copied to `config/allowlist.json` (gitignored), which is the runtime file the daemon reads and writes. The defaults auto-approve read-only tools and queue everything else — open either file and trim or extend it before going live. See [Allowlist](#allowlist) below.

### Install the LaunchAgent

```bash
install/install.sh
```

This writes `~/Library/LaunchAgents/local.outpost.$USER.plist`, loads it, and prints the pid on success. The daemon starts at every login and auto-restarts on crash. Logs land in `~/Library/Logs/outpost.{log,err.log}`. It auto-discovers every project under `~/.claude/projects/` at startup, so there's no "pick one workspace" step — you'll get a project picker in the PWA when starting a new session.

## Configuration

The daemon reads env vars at startup, in this precedence: **plist `EnvironmentVariables` > `~/.outpost/.env` > built-in defaults.** For most users, the defaults are fine and the only thing to touch is `~/.outpost/.env` for secrets (see above).

If you need to override a default permanently, edit `~/Library/LaunchAgents/$PLIST_LABEL.plist` and add the key under `<key>EnvironmentVariables</key>`, then `launchctl kickstart -k gui/$UID/$PLIST_LABEL`.

| Var | Default | Purpose |
|---|---|---|
| `OUTPOST_HTTP_PORT` | `8080` | Plain-HTTP loopback listener port. Set to `0` to disable the loopback listener. With Tailscale also unavailable, the daemon refuses to boot. |
| `OUTPOST_HTTPS_PORT` | `8443` | Port the PWA + WebSocket listen on (tailnet listener). Change if `:8443` is taken. |
| `OUTPOST_HOOK_PORT` | `8444` | Loopback-only port the `PreToolUse` hook posts to. Change if `:8444` is taken. |
| `OUTPOST_PLIST_LABEL` | `local.outpost.$USER` | LaunchAgent label. Export this in your shell **before** running `install/install.sh` if you want an org-style prefix like `com.example.outpost`. |
| `OUTPOST_RUNTIME_DIR` | `~/.outpost` | Where certs, allowlist, push subscriptions, and `.env` live. |
| `OUTPOST_PROJECTS_ROOT` | `~/.claude/projects` | Where the daemon scans for projects/sessions. |
| `OUTPOST_HOST` | auto-detected | Tailnet hostname used to locate the TLS cert+key in `OUTPOST_RUNTIME_DIR`. Override if auto-detection picks the wrong one. |
| `OUTPOST_APPROVAL_TIMEOUT_MS` | `600000` (10 min) | How long a pending approval card waits before the hook auto-rejects. |

Anything else (`OUTPOST_CERT_PATH`, `OUTPOST_KEY_PATH`, `OUTPOST_ALLOWLIST_PATH`, `OUTPOST_VAPID_PATH`, etc.) exists for power users and edge cases — see `src/config.ts` for the full list.

### Allowlist

`config/allowlist.json` (created on first daemon start from the tracked `config/allowlist.default.json`) controls which tool calls run without prompting. There are three lists:

- `alwaysAllow`: exact tool names that always pass (e.g. `Read`, `Grep`).
- `alwaysAllowBashPatterns`: regex matched against the `command` arg of `Bash` calls.
- `alwaysAllowMcpPatterns`: regex matched against MCP tool names (`mcp__<server>__<tool>`).

The defaults auto-approve read-only tools (file reads, greps, read-only `git` and `gh`, and a handful of read-only MCP integrations) and queue everything else. **Review and edit before using.** Anything not matched gets queued for explicit approval in the PWA.

## Remote access over Tailscale (optional)

By default Outpost only listens on `localhost`. To reach it from another device — your phone, a tablet, another laptop — put both machines on the same [Tailscale](https://tailscale.com) tailnet and let the daemon serve HTTPS on its tailnet hostname. Nothing is exposed to the public internet.

**1. Install Tailscale on both devices.** On the Mac running the daemon:

```bash
brew install --cask tailscale-app   # or download from https://tailscale.com/download/mac
```

Open the menu-bar app and sign in, then confirm `tailscale status` shows a `100.x.y.z` IP. Install Tailscale on the other device ([iOS](https://apps.apple.com/us/app/tailscale/id1470499037) / [Android](https://play.google.com/store/apps/details?id=com.tailscale.ipn)) and sign in with the **same account** so the two show up in the same tailnet.

**2. Enable HTTPS + MagicDNS** for your tailnet in the Tailscale admin console (a one-time account setting, not on the device). This gives the Mac a stable `<host>.ts.net` name and lets you mint a real TLS cert for it — both of which the daemon needs. Follow Tailscale's [HTTPS / MagicDNS guide](https://tailscale.com/kb/1153/enabling-https).

**3. Provision a TLS cert+key** for that hostname (run on the Mac):

```bash
HOST=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')   # e.g. your-mac.tailXXXX.ts.net
mkdir -p ~/.outpost
tailscale cert \
  --cert-file ~/.outpost/$HOST.crt \
  --key-file  ~/.outpost/$HOST.key \
  $HOST
```

The daemon reads these files at startup. If they're missing or unreadable it exits with the exact `tailscale cert` command to run, so you can also skip this step and let the daemon tell you what to type.

**4. Open the PWA** from the other device at the tailnet hostname:

```
https://<your-tailnet-hostname>.ts.net:8443/
```

Make sure Tailscale is signed in and toggled on there first — it only routes traffic while actively connected. On **iPhone**, open the URL in **Safari** (not Chrome — the PWA install path only works in Safari on iOS), tap the Share button, then "Add to Home Screen", and launch Outpost from the new icon. **This is required for push notifications on iOS** — iOS only allows Web Push from PWAs installed to the Home Screen. On Android Chrome, Web Push works without installing; the Settings page's "Enable push notifications" toggle is all you need. If the page doesn't load, the usual culprit is Tailscale being toggled off on the other device.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/local.outpost.$USER.plist
rm ~/Library/LaunchAgents/local.outpost.$USER.plist
rm -rf ~/.outpost
```

## Upgrading from single-cwd outpost

If you previously installed outpost with the `OUTPOST_CWD` env var pinning the daemon to one project, no migration is needed beyond removing that line: outpost now discovers every project under `~/.claude/projects/` and asks where to launch each new session via a picker sheet.

Edit `~/Library/LaunchAgents/local.outpost.$USER.plist` and delete the `<key>OUTPOST_CWD</key>` element plus its following `<string>...</string>`. Then reload the daemon:

```bash
launchctl unload ~/Library/LaunchAgents/local.outpost.$USER.plist
launchctl load ~/Library/LaunchAgents/local.outpost.$USER.plist
```

Existing sessions are not migrated — they're already in their per-project dirs and will appear in the new grouped list on first load.

## Development

```bash
npm run dev          # tsx watch, reloads on change
npm start            # one-shot daemon
npm test             # vitest + playwright
npm run test:unit    # vitest only
npm run test:e2e     # playwright only
```

The daemon expects to bind `:8080` (loopback PWA + WS, plain HTTP), `:8443` (tailnet PWA + WS, HTTPS), and `:8444` (loopback hook endpoint). The hook endpoint is loopback-only and authenticated with a per-launch secret that's written into Claude's `settings.json` at startup — see `src/hook-server.ts` for the rationale.

### Running side-by-side with the installed daemon

Two daemons can't share `~/.outpost/` — `index.json` files use atomic rename for persistence and a second writer will race. When testing from a checkout (worktree or otherwise) while the prod LaunchAgent is running, **stop the LaunchAgent first**, then spin up an alternate-port instance:

```bash
launchctl bootout gui/$UID/local.outpost.$USER         # stop the installed daemon
OUTPOST_HTTPS_PORT=8543 OUTPOST_HOOK_PORT=8544 \
  npx tsx src/daemon.ts                                # the test instance
```

Open `https://<host>.ts.net:8543/` to drive it. When you're done, restart the real daemon with:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/local.outpost.$USER.plist
```

(After a working-tree merge, `launchctl kickstart -k gui/$UID/local.outpost.$USER` is the cleanest way to pick up the new code — `unload`/`load` trips on the `KeepAlive` race.)

The allowlist is the exception to "don't run side-by-side": each checkout has its own gitignored `config/allowlist.json` seeded from `config/allowlist.default.json`, so rules hot-added in a worktree don't leak into prod (and vice versa).

## Architecture

- `src/daemon.ts` — wires everything together; main entrypoint.
- `src/server.ts` — hosts up to two listeners over one shared handler: a plain-HTTP loopback (always-on by default at `127.0.0.1:8080`) and an optional HTTPS listener on the tailnet IP. WebSocket upgrades work on either.
- `src/hook-server.ts` — the loopback HTTP endpoint Claude's `PreToolUse` hook posts to.
- `src/session-manager.ts` — owns the live Claude subprocesses and per-session WebSocket fanout.
- `src/session-store.ts` — reads session JSONLs off disk for transcript replay.
- `src/worktree-manager.ts` — per-session git worktrees under `~/.outpost/worktrees/<sessionId>/`.
- `src/git-ops.ts` — git plumbing for the PWA's source-control overlay (status, log, diff, commit, push, pull, `gh pr` lookups).
- `src/approvals.ts` — the pending-approval queue.
- `src/allowlist.ts` — matches incoming tool calls against the allowlist.
- `src/pwa/` — the static PWA assets served at `/`.
