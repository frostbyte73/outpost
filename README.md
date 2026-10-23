# Outpost

**Run Claude Code from your browser or your phone.** Approve tool calls, review diffs, and ship PRs across every project on your Mac, from one place.

![Outpost's Cockpit — jobs, approvals, and live sessions in one place](docs/screenshots/overview.png)

## Quick start

Needs macOS (or [Linux / WSL2](docs/linux-wsl.md)), Node.js 22+, and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup), logged in.

```bash
git clone https://github.com/frostbyte73/outpost.git
cd outpost
install/install.sh
```

Open `http://localhost:8080`. Outpost runs in the background from now on, starts at login, and restarts if it crashes.

Port 8080 taken by something else? Re-run with another port, e.g. `OUTPOST_HTTP_PORT=8090 install/install.sh`. The installer saves it to `~/.outpost/.env`, so the background service keeps using it.

## What you get

- **One inbox for everything waiting on you** — approvals, plans to review, PRs ready to merge, and anything that broke, next to what's running now. [features →](docs/features.md)
- **Hand it a goal, get a merged PR** — Outpost plans the change, you approve the plan, and it writes the code, gets it reviewed, and walks the PR through CI and review comments. [tracked jobs →](docs/features.md#tracked-jobs-with-a-plan-you-can-edit)
- **Nothing leaves your machine without your OK** — every push, comment, and merge stops on a card showing exactly what will run. Edit it, approve it, or say no.
- **Git without a terminal** — review the diff, commit with a drafted message, push, and open the PR from any session.
- **Use it from your phone** — install it as an app on your phone over [Tailscale](docs/remote-access.md), with push notifications when something needs you.
- **Work that runs on its own** — routines on a schedule, on an event, or whenever you have spare usage left in your limits. [routines →](docs/features.md#routines--work-that-fires-without-you)
- **Safe by default** — reads run automatically; anything else asks first. [permissions →](docs/permissions.md)
- **Runs on what you already have** — your `claude` login, your `git` identity and GitHub token or `gh` login, your MCP servers.

GitHub features (PRs, CI, review comments) need GitHub access: a `GITHUB_TOKEN` in `~/.outpost/.env` is enough (the daemon then calls the GitHub API directly, and actions use `curl` with it — see [configuration](docs/configuration.md)). Otherwise install the [GitHub CLI](https://cli.github.com) and log in: `brew install gh && gh auth login`.

Linear features (hourly intake of your assigned tickets as jobs, ticket state updates) need a personal API key from Linear › Settings › Security & access, added to `~/.outpost/.env` as `LINEAR_API_TOKEN=lin_api_...`, then `launchctl kickstart -k gui/$UID/local.outpost.$USER`. See [configuration](docs/configuration.md).

## Docs

[features](docs/features.md) · [remote access](docs/remote-access.md) · [permissions](docs/permissions.md) · [configuration, updates & uninstall](docs/configuration.md) · [Linux / WSL2](docs/linux-wsl.md) · [development](docs/development.md)
