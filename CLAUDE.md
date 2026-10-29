# Outpost

Background daemon that exposes Claude Code over HTTPS+WS on a Tailscale tailnet, with a PWA client. See `README.md` for the user-facing install/usage; this file is the orientation for Claude working inside the repo. The reasoning behind each rule here — and the incidents that produced it — lives in `docs/design/`; read the matching file before changing the code it covers.

## Concepts

Three primitives. Everything else is implementation detail.

- **action** — atomic unit of work. One `SKILL.md` + `input.schema.json` + `output.schema.json` (+ an optional colocated `allowlist.json`), under `actions/<category>/<name>/`. Categories: `read`, `write`, `code`, `meta`.
- **job** — a running unit of work. Owns the editable plan + history. Lifecycle: `planning → plan_pending_review → executing → done`, plus terminal `failed` / `abandoned`. Steps in `executing` jobs are mutable via the plan editor (insert, skip, reorder).
- **step** — one row of a job's plan. Two shapes (`StepKind`, `src/work/work-types.ts`), and picking between them is the main modelling decision a plan makes:
  - **`action`** — spawn a session for one named action, take its output, settle. Everything that doesn't need to decide anything. (`meta.wait` is the exception that spawns nothing: a builtin runner that just parks the step in `waiting` until the user resumes or `resumeAt` elapses. The user can open their own session on a parked one — `openWaitSession`, stored as `manualSession` rather than `sessionId` so no action-session path ever touches it. `meta.session` reuses that session shape but the session IS the work: the daemon starts it at step entry with `inputs.prompt` as its first turn — a personal skill whose description claims the ticket's identifier prefix, e.g. `/investigate-cscu` for `CSCU-`; with no such skill installed the planner never emits one — and the user marks the step Done.) Terminal states include `declined` — the user denied this step's write draft, which is *not* a failure: the orchestrator's step-review gets the reason and re-plans around it.
  - **`orchestrated`** — a **controller** action owns the step end to end, deciding its own next move each turn. This is what `code.orchestrate-pr` / `code.orchestrate-review` are.

"Agent" and "skill" remain Claude Code primitives; they are not Outpost-level terms.

## Design docs

| Before touching | Read |
|---|---|
| `src/work/orchestrated-runner.ts`, `src/steps/orchestrated*`, `src/integrations/pr-watcher.ts`, `code.orchestrate-*`, pre-approvals | [`docs/design/controller-loop.md`](docs/design/controller-loop.md) |
| `meta.orchestrate`, the action catalog / envelope, `src/schedules/`, the run ledger, `meta.improve-actions` | [`docs/design/orchestrator.md`](docs/design/orchestrator.md) |
| `src/permissions/`, `config/permission-groups*.json`, any `allowlist.json`, the Permissions page | [`docs/design/permissions.md`](docs/design/permissions.md) |
| anything listed under Gotchas below | [`docs/design/gotchas.md`](docs/design/gotchas.md) |
| known gaps and what's deliberately not done | [`docs/design/deferred.md`](docs/design/deferred.md) |
| the full `src/` tree, file by file | [`docs/design/repo-layout.md`](docs/design/repo-layout.md) |

The invariants from those docs that are easiest to break without noticing:

- **Controller loop.** A controller reports exactly one `NextMove` per turn via `mcp__outpost__submit_step_progress`. There is no round cap — the guards in `src/steps/orchestrated-policy.ts` bound it; don't reintroduce one.
- A controller never arms its own timer (`validateNext` refuses a `wait` with `resumeAt`); the PR watcher and `WorkEngine.redeliverParked` wake it.
- The watcher only wakes a controller on a signal some ladder row can act on, because every wake costs a round. Don't make `changedSignals` noisier.
- For a writable step, `resolve` means the PR merged, and a PR is opened once (`duplicatePrCreate`). Both live in policy because skill prose didn't hold.
- `code.review-diff` is the only review lens a controller runs unprompted. Don't add "dispatch security/UI review when the diff touches X" rules.
- Only a user HTTP route can grant a pre-approval; a planner can only write `proposedPreapprovals`.
- **Catalog.** `buildActionCatalog` is scoped (`plannable` vs `controller`). An action reached only from a controller round, a UI button, or a schedule sets `outpost.plannable: false`; a controller lists its sub-actions in `outpost.roster`.
- **Permissions.** Groups are `core` (implicit), `read`, `pull`, `edit`, `push`. `push` is gated: every matching call also needs a pin from a write draft the user approved.
- A write belongs in `push`, never in an action's colocated `allowlist.json` — `assertNotWriteShaped` refuses it at load. A `push` rule must match writes only, or it makes a read need approval.
- An action-bound call gets `core ∪ its declared groups ∪ its allowlist.json ∪ session scope` and never falls back to global or project scope.
- Which files a bash clause touches (redirects, file ops, reads, `--body-file`-style flags) is decided by structural bars in `allows()`, not by regex. Don't try to encode it in a rule.

## Commands

```bash
npm run dev          # tsx watch, reloads on change
npm start            # one-shot daemon
npm test             # vitest + playwright
npm run test:unit    # vitest only
npm run test:e2e     # playwright only
npx tsc --noEmit     # NOT in the test gate — `npm test` never typechecks; run this yourself
```

## Repo layout

Backend is clustered by concern under `src/`. Do NOT drop new files at the root of `src/` — pick the cluster or create a new one. The cluster table is in [`docs/development.md`](docs/development.md#architecture); the file-by-file tree is in [`docs/design/repo-layout.md`](docs/design/repo-layout.md). The PWA (`src/pwa/`) has its own orientation doc, `src/pwa/DESIGN.md`.

### Where new code goes

- **New HTTP route** → factory function in `src/routes/<group>.ts`; wire it in `daemon.ts` (`registerXRoutes(server, deps)`). Do not inline routes into `daemon.ts`.
- **New action** → `actions/<category>/<name>/` **and** `~/.outpost/actions/<category>/<name>/` — both, always (see Gotchas). A step that must decide its own next move is a controller (`type: 'orchestrated'`); anything else is a plain `action` step. If it's only ever reached from a controller round, a UI button, or a schedule, set `outpost: plannable: false` so it stays out of the orchestrator's catalog; if it IS a controller, add its sub-actions to `outpost: roster` and add it to the same roster whenever you add a round that binds it.
- **New backend concern** → the matching cluster subdir. If nothing fits, create a new subdir rather than dropping a file at `src/` root.
- **New PWA surface** → its own dir under `src/pwa/components/<surface>/index.js`, exporting `renderList`/`renderDetail`/`renderContext` as needed and registered in `shell/surfaces.js` (desktop) — `mobile-shell/index.js` mounts the *same* exports as a pushed screen, it does not reimplement the surface. The one exception is the cockpit: desktop mounts the board (`components/cockpit/index.js`), mobile mounts the old inbox (`components/cockpit/inbox.js`), because a dense live board doesn't fit a phone.
- **New PWA view-model** → `src/pwa/vm/<surface>.js`, pure functions only (no DOM, no store reads inside — callers pass raw snapshots in). This is what keeps desktop and mobile rendering the same derived data through different chrome.
- **Cross-module callback** a component needs from `app.js` → add a key to `src/pwa/app-bridge.js`'s bridge object and wrapper function, installed via `installAppBridge()` at boot. Don't import `app.js` from a component (creates cycles).
- **New PWA util** → `src/pwa/utils/<name>.js` if pure. Don't add another top-level `util.js`.
- **State stores** → `src/pwa/state/<name>.js`. Use the existing store shape (subscribable snapshot + typed mutators).

### Keep modules small

- Files hitting ~500 LOC should be looked at for extraction. `daemon.ts` and `app.js` used to be 2365 / 6501 lines; both were refactored (they're ~1330 / ~990 now), and `app.js`'s WS handling has since moved out entirely into `pwa/ws/dispatch.js`. Regressing to that shape is a code smell.
- Route handlers larger than ~30 lines? Extract the handler body into a named function in the same route file.
- `WorkEngine` is the one remaining monolith — extraction is welcome but non-trivial (see `docs/design/deferred.md`).

## Running the daemon

The daemon runs as a launchd LaunchAgent (`local.outpost.$USER`) with its state in `~/.outpost/`. Two daemons can't share `~/.outpost/`, so never start a second one alongside it. After merging, bounce the real one with `launchctl kickstart -k gui/$UID/local.outpost.$USER` (`unload`/`load` trips on the `KeepAlive` race). Side-by-side testing from a worktree is described in [`docs/development.md`](docs/development.md).

## Gotchas

One line each; the full reasoning is in [`docs/design/gotchas.md`](docs/design/gotchas.md).

- Don't loosen the sessionId/branch regexes in `src/git/worktree-manager.ts` — they stop path traversal and git argv-flag smuggling.
- Every new endpoint in `src/permissions/hook-server.ts` must validate the secret header; only `server.ts` is exposed on the tailnet.
- Persisted stores in `~/.outpost/` (override: `OUTPOST_RUNTIME_DIR`) write via atomic rename; keep that pattern in new ones.
- launchd strips the shell env, so secrets reach subprocesses through `~/.outpost/.env` (`env-file.ts`), where an `op://` value is resolved through 1Password. Precedence: plist > .env > defaults.
- The daemon's GitHub calls all go through `runGh` (`gh-cli.ts`), answered from the API when `gh` isn't installed and `GITHUB_TOKEN` is set; never spawn `gh` directly, and a new argv shape needs a shim case and a test.
- Sessions learn the daemon's port only from `$OUTPOST_API_URL`; an action that calls back must allowlist both that spelling and `127.0.0.1:<port>`.
- A step failure always journals a `blocked` entry against the action (pass `{ journal: false }` when the action didn't cause it). A denied write draft journals against whoever chose to run the action instead.
- Every catalog action must exist in both the repo's `actions/` and `~/.outpost/actions/`; `ensureActionsInstalled` never overwrites an existing dir.
- A rule granting a network or filesystem write must be an anchored whitelist pinned to its destination. Never write a rule that tries to forbid a flag.
- A gated write needs an approved pin as well as an allowlist hit, and the pin matches the exact approved command text. An action that rewrites the payload gets denied.
- A review comment's `diff_hunk` ends at the commented line. `pr-file-patches.ts` fetches the real patch, so don't remove it as redundant.
- PWA modules extracted from `app.js` get app-side callbacks via `initX({ ... })` deps injection or `app-bridge.js`; follow one of the two.

## Conventions

- ESM (`"type": "module"`), import paths end in `.js` even for `.ts` source. When moving files, update every importer.
- No comments restating code; comments only for non-obvious WHY (see existing files for tone).
- Errors at the boundary (user input, git, filesystem) — trust internal calls.
- Prefer editing existing files over creating new ones — but when a file is heading toward monolith territory (see "Keep modules small"), extract instead of adding to it.
