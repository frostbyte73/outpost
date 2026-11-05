# Development

```bash
npm run dev          # tsx watch, reloads on change
npm start            # one-shot daemon in the foreground
npm test             # vitest + playwright
npm run test:unit    # vitest only
npm run test:e2e     # playwright only
npx tsc --noEmit     # NOT in the test gate — run this yourself
```

The daemon binds `:8080` (loopback PWA + WS, plain HTTP), `:8443` (tailnet PWA + WS, HTTPS), and `:8444` (loopback hook endpoint). The hook endpoint is loopback-only and authenticated with a per-launch secret; it serves the outpost MCP server, the orchestrator's `/work/*` callbacks and the eval MCP routes — see `src/permissions/hook-server.ts`. Tool gating is not on it: sessions run on the Agent SDK and are gated by in-process hooks.

[`CLAUDE.md`](../CLAUDE.md) is the orientation document for working inside this repo: concepts, where new code goes, and the invariants that are easy to break. The reasoning behind them lives in [`design/`](design/): the permission model rule by rule, the controller loop's guards and why each exists, and the gotchas that have already bitten. Read the matching design doc before changing anything under `src/permissions/` or `src/work/`.

## Running side-by-side with the installed daemon

Two daemons can't share `~/.outpost/` — a second writer races the first. Stop the installed one first, then start an alternate-port instance from your checkout:

```bash
launchctl bootout gui/$UID/local.outpost.$USER
OUTPOST_HTTPS_PORT=8543 OUTPOST_HOOK_PORT=8544 npx tsx src/daemon.ts
```

Restart the real daemon with:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/local.outpost.$USER.plist
```

After merging work into the installed checkout, `launchctl kickstart -k gui/$UID/local.outpost.$USER` picks up the new code — `unload`/`load` trips on the `KeepAlive` race.

Each checkout has its own gitignored `config/allowlist.json` and `config/permission-groups.json`, so rules added in a worktree don't leak into your real install.

## Architecture

Backend is clustered by concern under `src/`; nothing new goes at the root.

| path | what lives there |
|---|---|
| `src/daemon.ts` | entrypoint — wires modules, installs route factories |
| `src/server.ts` | HTTPS + WS surface for the PWA (loopback + optional tailnet listener over one handler) |
| `src/mcp-server.ts` | MCP surface spawned Claude sessions report results through |
| `src/routes/` | HTTP route factories, one file per resource group |
| `src/runtime/` | the `AgentRuntime` boundary — canonical tools/events, and `claude/`, the Claude Code runtime behind every session |
| `src/session/` | session lifecycle — spawn via the runtime, WS fanout, replay, session sidecar meta |
| `src/work/` | job orchestration — the engine, envelopes, write drafts, the controller runtime |
| `src/steps/` | per-step-kind handlers, incl. the orchestrated policy that bounds a controller |
| `src/permissions/` | the `PreToolUse` gate — scopes, rules, the bash lexer, the write-shape lint |
| `src/actions/` | action registry, scorecards, improvement packs |
| `src/schedules/` | cron / event / token-opportunistic routines |
| `src/integrations/` | external polling — PR watchers, Linear, usage |
| `src/git/` | worktrees, git plumbing, diff parsing |
| `src/storage/` | persisted stores (all atomic-rename) |
| `src/pwa/` | the static client — plain ES modules, no bundler. `src/pwa/DESIGN.md` is its own orientation doc. |
| `actions/` | the shipped action catalog (`read` / `write` / `code` / `meta`) |
