# Configuration

The defaults work for most people. The one file worth knowing about is `~/.outpost/.env`.

## Secrets in `~/.outpost/.env`

The background service doesn't inherit your shell's environment, so anything Claude's subprocesses need at runtime goes in `~/.outpost/.env`, which the daemon reads at startup:

```bash
# The daemon's GitHub identity: PR creation, the PR watcher, review intake.
# With it, Outpost calls the GitHub API directly and needs no `gh` binary;
# without it, those calls fall back to `gh` and its own auth.
GITHUB_TOKEN=ghp_...

# Turns on the built-in hourly Linear intake routine (one job per issue assigned to you).
LINEAR_API_TOKEN=lin_api_...

# Any other secrets your MCP servers or hooks expect.
```

Standard `KEY=value` syntax, `#` comments allowed, `export KEY=value` tolerated. Run `chmod 600 ~/.outpost/.env` after creating it, then restart Outpost.

## Environment variables

Precedence: **plist `EnvironmentVariables` > `~/.outpost/.env` > built-in defaults.** To override one permanently, add it to `~/.outpost/.env`, or to the plist under `<key>EnvironmentVariables</key>`, then restart.

| Var | Default | Purpose |
|---|---|---|
| `OUTPOST_HTTP_PORT` | `8080` | Plain-HTTP loopback listener port. Set to `0` to disable it — with Tailscale also unavailable, the daemon refuses to boot rather than start with no listener. |
| `OUTPOST_HTTPS_PORT` | `8443` | Port the PWA + WebSocket listen on over the tailnet. |
| `OUTPOST_HOOK_PORT` | `8444` | Loopback-only port the `PreToolUse` hook posts to. |
| `OUTPOST_PLIST_LABEL` | `local.outpost.$USER` | LaunchAgent label. Export **before** running `install/install.sh` for an org-style prefix like `com.example.outpost`. |
| `OUTPOST_RUNTIME_DIR` | `~/.outpost` | Where certs, jobs, worktrees, the installed action tree, and `.env` live. |
| `OUTPOST_PROJECTS_ROOT` | `~/.claude/projects` | Where the daemon scans for projects/sessions. |
| `OUTPOST_HOST` | auto-detected | Tailnet hostname used to locate the TLS cert+key in `OUTPOST_RUNTIME_DIR`. Override if auto-detection picks the wrong one. |
| `OUTPOST_BIND_ADDRESS` | auto-detected | Address the HTTPS listener binds. |
| `OUTPOST_APPROVAL_TIMEOUT_MS` | `600000` (10 min) | How long a pending approval card waits before the hook auto-rejects. |
| `OUTPOST_STOP_THRESHOLD_MS` | `30000` | How long a session must be idle before a stop-hook counts it as done (drives "needs you" notifications). |
| `OUTPOST_PUSH_TTL_SECONDS` | `60` | TTL on outgoing Web Push messages. |

Anything else (`OUTPOST_CERT_PATH`, `OUTPOST_KEY_PATH`, `OUTPOST_ALLOWLIST_PATH`, `OUTPOST_VAPID_PATH`, `OUTPOST_PUSH_SUBS_PATH`) exists for power users — see `src/config.ts` for the full list.

## Running the service

`install/install.sh` writes `~/Library/LaunchAgents/local.outpost.$USER.plist` and loads it. Re-run it any time; it replaces the running instance. It finds every project under `~/.claude/projects/` on its own, so there's no workspace to pick.

Before loading, the installer refuses to start if one of Outpost's ports is already in use, and names the process holding it. Any `OUTPOST_HTTP_PORT` / `OUTPOST_HTTPS_PORT` / `OUTPOST_HOOK_PORT` set on the install command line is saved to `~/.outpost/.env`, so `OUTPOST_HTTP_PORT=8090 install/install.sh` changes the port for good.

- **Logs:** `~/Library/Logs/outpost.{log,err.log}`
- **Restart:** `launchctl kickstart -k gui/$UID/local.outpost.$USER`
- **Sleep:** Outpost is only reachable while the Mac is awake. The service blocks idle sleep while plugged in, but closing the lid without an external display still sleeps the machine.

## Updates

Outpost checks for new commits once a day. When there are some, an **Update available** link appears in the sidebar (on mobile, the header) and opens **Settings › Updates**, with **Update now** and **Pull updates automatically**. An update pulls, reinstalls dependencies if they changed, and restarts once no session is mid-turn. Updating is disabled while the checkout is off `main` or has local changes.

## Uninstall

```bash
launchctl bootout gui/$UID/local.outpost.$USER
rm ~/Library/LaunchAgents/local.outpost.$USER.plist
rm -rf ~/.outpost
```

`~/.outpost` holds your jobs, worktrees, run history, and action tree — back it up first if you might want any of it. On Linux, see [Linux / WSL2](linux-wsl.md).
