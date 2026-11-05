# Repo layout

Backend is clustered by concern under `src/`. Do NOT drop new files at the root of `src/` — pick the cluster or create a new one.

```
src/
  daemon.ts              # entrypoint; wires modules; installs route factories
  server.ts              # HTTPS + WS surface for the PWA
  mcp-server.ts          # MCP surface for spawned Claude sessions
  config.ts, env-file.ts, tailscale.ts
  push-{keys,sender,subscriptions}.ts

  runtime/               # the AgentRuntime boundary: what every session runs on
    types.ts               # AgentRuntime, RuntimeHost, canonical items/events, capabilities
    tools.ts               # canonical tool names; Claude spellings are permanent aliases
    event-ndjson.ts        # per-session native + canonical event logs (runtime-logs/, 14-day retention)
    daemon-host.ts         # RuntimeHost: the daemon's answers to gating, turn ends, usage
    registry.ts            # RuntimeRegistry, resolveRuntime (action > job > claude), capability refusal
    transcripts.ts         # CompositeTranscripts: every runtime's history behind one reader
    jsonl-transcripts.ts   # Outpost-owned canonical item log for runtimes that keep no usable history
    action-turn.ts, bin.ts # `/<action>` → SKILL.md body for non-Claude runtimes; PATH lookup past launchd
    claude/                # Claude Code on the Agent SDK — the default runtime
      runtime.ts, sdk-session.ts, bin.ts   # ClaudeRuntime, one streaming-input query() per session, binary lookup
      events.ts              # SDK messages → canonical events
      hooks.ts               # in-process SDK hooks → RuntimeHost calls (the PreToolUse gate)
      usage.ts               # the statusLine payload, rebuilt from SDK frames
      once.ts                # one-shot runs: PR draft, eval judge, eval replay
      transcripts.ts, transcript-{parse,scan}.ts  # ~/.claude/projects JSONL → canonical items
      skills.ts, config.ts   # action delivery as skills, ~/.claude.json
    codex/                 # OpenAI Codex over `codex app-server` JSON-RPC
      runtime.ts, app-server.ts, bin.ts  # CodexRuntime + session, the stdio client, binary lookup
      pretool-hook.ts, pretool.ts         # the fail-closed PreToolUse command (inline sh) and its endpoint handler
      thread-config.ts, hook-trust.ts     # `--config` overrides; the trust + feature handshake
      items.ts, events.ts, call-tracker.ts  # v2 items → canonical; ungated-call tripwire, pin release
      tools.ts                            # tool-name mapping
    acp/                   # any Agent Client Protocol agent over stdio JSON-RPC, one runtime per configured agent
      runtime.ts, connection.ts           # AcpRuntime + session (gate, tripwire, pins), the bidirectional stdio client
      config.ts                           # ~/.outpost/acp-agents.json: seeded, validated, read at boot
      permission.ts, events.ts            # request_permission → gate calls + reply; session/update → canonical

  routes/                # HTTP route factories: registerXRoutes(server, deps)
    {git,jobs,sessions,projects,push,runs,schedules,meta,util,actions,preferences,update}.ts
    action-revisions.ts, schedule-edits.ts
  session/               # session lifecycle
    session-{manager,store}.ts, stream-json.ts, event-log.ts, attachments.ts
  work/                  # job orchestration
    engine.ts, work-{queue,types}.ts, envelope.ts, reconcile.ts, write-draft{,-runner}.ts
    orchestrated-runner.ts # the controller loop's runtime (see [controller-loop.md](controller-loop.md))
    launch-governor.ts     # who gets to spawn next, under token headroom
    job-liveness.ts, workspace.ts, pr-url.ts, action-run-{derive,ledger}.ts
  permissions/           # hook plumbing + gates
    gate.ts                # gateToolCall: the per-call decision every runtime's tool calls reach
    hook-server.ts, approval-mode.ts, approvals.ts
    allowlist.ts           # scopes + rules; shell-{split,safety}.ts are its bash lexer +
                           # argv/expansion bar, denial-suggestion.ts the rule offered on a miss
    file-flags.ts          # which flags name a FILE, and the /tmp shape one may name — the
                           # predicate allows() and the write-draft pin must never disagree on
    dangerous-writes.ts    # deny-vs-warn for external writes: refusedWrite() feeds allows(),
                           # writeFindings() rides out on the draft for the approval card
    github-token.ts        # where $GITHUB_TOKEN may go: curl's Authorization header to api.github.com, nowhere else
  ws/                    # inbound PWA WebSocket frames
    client-messages.ts     # decode + dispatch; isolated because a throw in ws.on('message') kills the daemon
  git/                   # worktree + git ops + diff
    worktree-manager.ts, git-ops.ts, diff-{parser,endpoint}.ts
    known-cwd.ts           # is this caller-supplied path one the daemon already knows? gate for spawn/shell-out
  integrations/          # external polling
    linear-{api,writer}.ts, pr-watcher.ts, user-prs-watcher.ts, usage-{poller,ledger}.ts
    review-intake.ts       # PRs by others → one review job each, plan generated without the planner
    gh-cli.ts              # runGh: the one GitHub seam — the gh binary, or the API via gh-api-shim.ts when gh is missing and GITHUB_TOKEN is set
    github-api.ts, gh-api-shim.ts  # REST/GraphQL client; gh argv → API calls printing gh's JSON
    pr-file-patches.ts     # per-file PR diffs, fetched on demand + cached by head sha (NOT persisted
                           # onto the job); what lets a review comment render inside its hunk
  schedules/             # cron/event/token-triggered runs (routines) — dependency-free of work/
    scheduler.ts, schedules-store.ts, guards.ts, routing.ts, types.ts, wiring.ts
    headroom.ts, token-scheduler.ts  # opportunistic firing off spare 5h/7d token capacity
    native-handlers.ts, script-runner.ts, schedule-envelope.ts, setup-schedules.ts
  update/                # updater.ts: daily fetch of origin/main, ff-only pull, restart once no session is mid-turn
  storage/               # persisted stores
    {journal,project-registry,actions,runs,preferences}-store.ts, runs-capture.ts
    stop-hook-tracker.ts, recurrence-tracker.ts, job-event-log.ts, jobs-migrate.ts
    action-{revisions,edits}-store.ts  # SKILL.md version history + revert; durable half of the in-flight edit map
    action-runs-store.ts, denials-store.ts  # per-round run rows + every allowlist miss — the improvement loop's evidence
  actions/               # registry + types; install.ts, scorecard.ts, improvement-pack.ts, proposal-intake.ts, skill-diff.ts
  steps/                 # step handlers: action.ts, orchestrated{,-policy,-inbox}.ts
  jobs/                  # lifecycle.ts

  pwa/                   # static client (plain ES modules, no bundler); DESIGN.md lives here
    app.js, index.html, sw.js, app-bridge.js, util.js, markdown.js, session-filter.js,
    deep-links.js, session-launch.js, test-hooks.js
    components/            # per-feature UI modules — one dir per surface/overlay
      shell/                 # desktop chrome: topbar, sidebar, surface registry/frame, keyboard, list-filter
      mobile-shell/          # mobile chrome: bottom tab bar, header, FAB, More screen, screen stack
      cockpit/               # desktop board (index.js) + mobile inbox (inbox.js)
      tracked/               # jobs list + detail + focus rail
      sessions-surface/      # sessions list/detail/rail
      schedules/             # schedules list/detail/create-dialog + routing/trigger/what/runs cards
      library/               # skills list/detail + runs-history detail
      settings-surface/      # settings sections + detail cards
      palette/               # ⌘K command palette (new session/project, jump-to)
      session-view/          # live transcript + composer — shared core for desktop and mobile
      diff-overlay/, agents-sheet/, push/, work/  # diff review; subagent sheet; push-notif setup;
                                                   # job-detail sub-widgets (step-card, thread-card, ...) used by tracked/
      ask-card.js, ask-flow.js, tool-use-tile.js, todos-{core,sheet}.js, sheet-utils.js,
      mobile-header.js, approvals-mobile.js, cwd-picker.js, theme-picker.js,
      diff-review-format.js
    vm/                    # view-models (D2): pure derivations from raw store snapshots → row/card shapes.
                           # One file per surface ({cockpit,tracked,sessions,schedules,library,settings,runs}.js) + work-predicates.js;
                           # session-events.js maps canonical session items to transcript entries.
                           # Zero DOM. Renderers are layout-agnostic; mobile-shell arranges the SAME renderers
                           # desktop's shell/surfaces.js uses — never a second copy.
    state/                 # store singletons (sessions, approvals, subagents, work, usage, settings, git,
                           # schedules, runs, actions, library, grants, nav, ...)
    net/                   # fetch wrappers per resource (actions, meta, preferences, runs, schedules, work)
    ws/                    # dispatch.js: WS message → store mutations
    layout/                # mobile vs desktop pick
    css/                   # base.css (tokens + global chrome), primitives.css (the canonical .o-* components),
                           # overlays.css (shared sheet/modal/popover chrome), app-shell.css (pre-JS bootstrap shell),
                           # shell-desktop.css, shell-mobile.css, desktop.css, palette.css, session-view.css,
                           # surfaces/{cockpit,tracked,sessions,schedules,library,settings,runs,diff}.css
                           # (legacy-components.css was dissolved into these per-surface sheets —
                           #  see src/pwa/DESIGN.md, codename Signal)
    utils/                 # formatting.js, usage-bar.js (shared tier thresholds/popover), overflow-menu.js,
                           # autogrow.js, context-usage.js, hotkey.js, keyed-rows.js, row-activation.js,
                           # diff-window.js (which slice of a PR diff sits under a review comment)
```
