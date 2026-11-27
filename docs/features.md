# Features

## Concepts

Three primitives; everything else is detail.

- **action** — one atomic unit of work: a `SKILL.md` plus input/output schemas, under `actions/<category>/<name>/`. Categories are `read`, `write`, `code`, `meta`, `design`, `arch`, `project`.
- **job** — a running unit of work with an editable plan and a history. Goes `planning → plan_pending_review → executing → done`.
- **step** — one row of a plan. Either a plain **action** step (spawn a session for one named action, take its output, settle) or an **orchestrated** step, where a *controller* action owns the step end to end and decides its own next move each turn — that's how a PR gets shepherded from spec through merge.

"Agent" and "skill" stay Claude Code's terms. They aren't Outpost-level concepts.

## The Cockpit is the only page you have to watch

Everything parked on a human lands in one inbox: pending tool approvals, jobs holding a write draft, steps sitting on a gate, plans waiting to be reviewed, anything that broke — alongside what's currently in flight. Nothing is persisted and nothing is ever "marked read"; a row is open because a predicate over live state holds, and it disappears when it stops holding.

![Cockpit — everything parked on a human, in one place](screenshots/cockpit.png)

## One launcher, three destinations

⌘K opens the palette: pick a project (recent, ephemeral worktrees, or known repos — or add one), type the prompt, pick a model, choose in-place or a fresh worktree. Then choose what it becomes:

- **↵** — an interactive session.
- **⌘⇧↵** — a tracked job. Auto-flips to a worktree; the orchestrator plans it.
- **⇧⌘S** — a schedule, seeded with the same prompt/cwd/model.

![⌘K palette with a composed prompt and the three launch actions](screenshots/palette.png)

## Tracked jobs, with a plan you can edit

Hand Outpost a goal and the orchestrator investigates it, then emits a typed, ordered plan. You review the plan before anything runs. Once it's executing, the plan stays mutable — insert a step, skip one, reorder.

A controller step then runs its own loop: spec → plan → implement, then watch the PR. It reads what the PR watcher records (CI checks, review state, new comments, head moves) and picks its next move each turn — keep going, fan out to sub-actions, park on an event, ask you a question, or settle. A step is only allowed to call itself done when the PR it owns actually merged.

The right rail is the job's ledger: what needs you, every session the job has spawned, the branch/PR/age at a glance, and the recent activity trail down to which step registered which repo.

Jobs also arrive without you: an interactive session can be promoted to a job (⌘⇧P), and the built-in Linear routine files one per issue assigned to you.

![Tracked job: plan, an approval-gated merge draft, and the focus rail](screenshots/tracked.png)

## Every external write stops for the exact payload

Actions can't post, push, merge, or file anything on their own. An action that wants an external write **drafts** it — the literal command, or the literal comment body — and stops. That's the card in the middle of the shot above: `code.merge-pr` proposing a squash merge and a branch delete, each command shown in full, with the evidence it based them on, and Accept / Propose changes / Deny.

You can edit the payload in place before accepting. Then the approved bytes are what runs: a session that changes the command after you approved it gets denied. Bodies too big for a command line are drafted inline, so the card always shows the actual content behind a `--body-file`. Riskier calls carry a visible warning, and a few — a force-push, an `--admin` merge — need an extra checkbox.

For writes you'd approve every time anyway (pushing your own branch, re-running a flaky CI check, merging once approved), you can pre-approve them per job or globally in Settings.

## Source control, without a terminal

A full git overlay on every session and job step: browse the log, review the diff side by side, stage or discard, and commit with a message Claude drafts (and you edit, or regenerate). Push, squash to the branch, merge to base, or open the PR — the overlay knows whether one is already open.

Review comments on a PR render inside their real diff hunk, with lines on both sides. Powered by local `git` and `gh`, so commits and PRs land under your real identity.

![Diff review overlay with a drafted commit message and ship actions](screenshots/diff.png)

## Sessions that read like the CLI

Live transcript with per-tool chrome — git-style diffs for `Edit`, shell-prompt blocks for `Bash`, ripgrep-shaped output for `Grep`, Read excerpts — so a session scrolls like a story, not a JSON dump. Alongside it: the task list, `AskUserQuestion` rendered as a real card, and a rail showing model, cwd, mode, tokens, and connected MCP servers.

Toggle the session between **Ask**, **Plan**, **Accept edits**, and **Bypass** from the header — same vocabulary as the CLI. Each session remembers its own mode; set the default for new sessions in Settings.

## Selective approvals

Every tool call is checked before it runs. Reads, greps, and other safe calls run automatically; anything else queues an inline **Approve / Reject** card right where it would have run — including inside subagent feeds, so you can stop a runaway agent before it lands. Agent-spawned work gets its own tabbed feed with the spawn context pinned at the top.

## Routines — work that fires without you

Schedules run on a `cron`, `once`, on an `event`, or **opportunistically off spare token headroom** (your 5h/7d windows have room, so something useful runs). Guards can veto a firing. A routine runs one of four things: a catalog action, a free-text prompt, a plain shell script (no Claude session at all), or an in-daemon native handler. Findings can route to the Cockpit, a Slack webhook, or a PR/issue comment.

Seven ship built-in: a nightly Claude Code updater, hourly Linear intake, the PR watcher, your-open-PRs watcher, PR review intake (one review job per PR from others in repos you watch, or that requests your review), an MCP credential-expiry check, and the action improver — which is gated on accumulated run evidence rather than a clock, so a firing with nothing to review records a skip instead of burning tokens.

![Schedules: the token-opportunistic action improver, its trigger, and its run history](screenshots/schedules.png)

## Actions get better on their own

Every action round is recorded — outcome, cost, denial count, any lesson the action journaled about why it got stuck, and every tool call that was blocked. That evidence feeds a scorecard per action, and a routine that picks the single action most worth improving and proposes a `SKILL.md` revision citing the specific runs that justify it. You approve or reject the diff; every version is kept and revertible.

![Skills library: the action catalog and one action's SKILL.md with its blocked-call evidence](screenshots/skills.png)

## Permissions you can read and edit

Each action inherits a few named permission groups, and you can edit them rule by rule from Settings › Permissions. See [permissions](permissions.md).

## Usage and context at a glance

A live readout of your 5-hour and 7-day usage windows sits in the sidebar, and per-session model / context / cache detail in the session rail — so you know when you're about to hit a limit before Claude does. It's also what the opportunistic scheduler reads to decide there's room to run something.

## Themes

Nine hand-tuned palettes — Halcyon, Almanac, Terminal, Nordic, Ink, Botanical, Plasma, Atlas, Library — each in light and dark, plus three row densities. Terminal is genuinely brutalist; Almanac is an editorial serif.
