---
name: write.create-repo
description: Use when a job needs a brand-new GitHub repository — a new project with no repo yet. Creates frostbyte73/<name> (private unless `inputs.visibility` is "public") with a README so origin has a default branch, then clones it to a durable path and registers it with Outpost like write.add-project. External-write — drafts the exact create call via `mcp__outpost__submit_write_draft` and stops; creates it only once the user approves (see `SHARED-write-drafts.md`). For a repo that already exists, use write.add-project instead.
outpost:
  kind: action
  category: write
  side_effects: external-write
  runner: claude
  permissions: [read, pull, push]
  timeout_sec: 1800
  retries: 0
---

# write.create-repo

Create a GitHub repo under the `frostbyte73` account, then make it usable by Outpost: on disk
at a durable path and registered with the daemon. One external write (the create, drafted and
approved), two local side effects (a clone and a registry entry). Stop at "created, cloned,
registered" — first commits, branches and dependency installs belong to the steps after.

**The owner is always `frostbyte73`.** The permission rule for `gh repo create` is pinned to
that owner and a closed flag set; anything else is denied, not drafted. A denial here means the
command shape is wrong — never retry with another spelling.

Read the draft mechanics once before Step 4:

```bash
cat ~/.outpost/actions/SHARED-write-drafts.md
```

## Step 1 — read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

This is an action step, so the write gate is at `typePayload.writeGate`. If
`typePayload.writeGate.phase` is `"commit"`, go to Step 5. Otherwise read `inputs`:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Repo name; created as `frostbyte73/<name>`. |
| `description` | no | One line. No `"`, `$`, backticks, backslashes or control characters — it is drafted as a literal. |
| `visibility` | no | `"private"` (default) or `"public"`. |
| `dest` | no | Absolute path to clone into. Derived in Step 6 when omitted. |

If `inputs` has no `name`, take it from the goal only when the goal names it outright;
otherwise fail (Step 9) saying the name is missing. Never invent one.

## Step 2 — decide visibility

Private unless `inputs.visibility === "public"`. Don't infer public from prose: if the goal
says "public" but `inputs` doesn't, keep it private and say so in `summary` — making a private
repo public later is one click, the reverse can't unpublish what was already seen.

## Step 3 — preflight (reads only)

```bash
which gh
```

**Without `gh`** (the usual case on this machine), confirm the token is frostbyte73's — the
create call goes to `/user/repos`, which always creates under the token's own login:

```bash
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
```

`login` must be `frostbyte73`. Anything else → fail, naming the login. Never draft
`/orgs/<org>/repos` instead. Then check whether the repo exists:

```bash
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/frostbyte73/<name>
```

**With `gh`:**

```bash
gh repo view frostbyte73/<name> --json nameWithOwner,isPrivate,url,defaultBranchRef
```

**It already exists** → don't draft. Set `created: false`, note its visibility in `summary` if
it differs from what was asked (don't change it), and go to Step 6. A re-run must never ask to
create twice.

## Step 4 — draft the create, then stop

One call, every value literal. Omit `--description` / `description` when there is none.

With `gh`:

```
{ label: "create repo",
  bash: "gh repo create frostbyte73/<name> --private --add-readme --description \"<description>\"" }
```

(`--public` in place of `--private` only per Step 2.)

Without `gh`:

```
{ label: "create repo",
  bash: "curl -sS --fail-with-body -X POST -H \"Authorization: Bearer $GITHUB_TOKEN\" -H 'Accept: application/vnd.github+json' https://api.github.com/user/repos -d @/tmp/outpost-create-repo-<name>.json",
  files: { "/tmp/outpost-create-repo-<name>.json": "{\"name\":\"<name>\",\"description\":\"<description>\",\"private\":true,\"auto_init\":true}" } }
```

For a public repo (Step 2) the body says `"private":false`.

`--add-readme` / `auto_init` is not optional: it gives origin a default branch, which is what
later steps cut worktrees from. `evidence`: the owner, the visibility and why, and the token
login from Step 3. Call `mcp__outpost__submit_write_draft` and end the turn.

## Step 5 — commit phase

Run `typePayload.writeGate.approvedCalls` verbatim, then continue to Step 6. If the call exits
non-zero, re-run Step 3's existence read before retrying — a create can land and still error,
and a 422 "name already exists on this account" means it exists.

## Step 6 — choose the destination

`inputs.dest` if set. Otherwise:

```bash
cat ~/.outpost/projects.json
```

Use `<the parent of an already-registered frostbyte73 checkout>/<name>`. With none, use the
parent directory hosting the most registered projects; with an empty registry,
`$HOME/frostbyte73/<name>`. Never inside `~/.outpost/`, never inside another
checkout (`git -C <nearest existing ancestor of <dest>> rev-parse --show-toplevel` succeeding
means you're in one — `<parent>` may not exist until Step 7).

If `<dest>` already exists and its `git -C <dest> remote get-url origin` is this repo (either
`git@github.com:frostbyte73/<name>.git` or `https://github.com/frostbyte73/<name>(.git)`),
reuse it as-is and go to Step 8. If it exists as anything else, fail — don't delete it, don't
pick `<dest>-2`.

## Step 7 — clone

```bash
mkdir -p <parent>
git clone git@github.com:frostbyte73/<name>.git <dest>
```

SSH is what this machine's checkouts use and it needs no token. If it fails on auth: with
`gh`, `gh repo clone frostbyte73/<name> <dest>`; without it,
`git clone https://github.com/frostbyte73/<name>.git <dest>`, which only works for a public
repo — a private one has no https credential here, so fail with the SSH error instead.

The clone grant is exactly those shapes — URL plus absolute destination, no flags.
`git clone --upload-pack='<any command>'` runs that command on this machine, and `-c
protocol.ext.allow=always` with an `ext::` URL does the same, so an open clone grant is an
arbitrary-execution grant. Never pass `--depth`, `--single-branch` or `--bare` either: worktrees
are cut from this checkout.

```bash
git -C <dest> rev-parse --show-toplevel
git -C <dest> log -1 --oneline
git -C <dest> branch --show-current
```

If any of these fails, the clone is incomplete — fail rather than register it. The last one is
the output's `defaultBranch`; `url` is `https://github.com/frostbyte73/<name>`.

## Step 8 — register with the daemon

Never hand-edit `~/.outpost/projects.json`; the daemon rewrites it from memory.

```bash
curl -fsS -X POST "$OUTPOST_API_URL/api/projects" \
  -H 'content-type: application/json' \
  -d '{"cwd":"<dest>"}'
```

`{"added":false}` means it was already registered — success, report `alreadyRegistered`. Only
`$OUTPOST_API_URL` and a `127.0.0.1`/`localhost` literal are allowlisted for this POST, with
`-H`/`-d` carrying literal values; don't reach for another HTTP client on a denial. Re-read
`~/.outpost/projects.json` and confirm `<dest>` is in `projects[]`.

## Step 9 — deliver or fail

Done means: the repo exists under frostbyte73, it is cloned at `<dest>`, and `<dest>` is
registered. Anything short of that is a failure — `mcp__outpost__submit_step_failed` with what
was requested, what blocked it and the unblock. Don't submit a hopeful success.

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output,mcp__outpost__submit_step_failed", max_results: 2 })
```

```
mcp__outpost__submit_step_output({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  output: "{\"ok\": true, \"repo\": \"frostbyte73/game\", \"url\": \"https://github.com/frostbyte73/game\", \"path\": \"/Users/testuser/github/frostbyte73/game\", \"private\": true, \"created\": true, \"registered\": true, \"alreadyRegistered\": false, \"defaultBranch\": \"main\", \"summary\": \"Created private frostbyte73/game, cloned to /Users/testuser/github/frostbyte73/game and registered it.\"}"
})
```

## Before you exit — journal a blocker

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "write.create-repo",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "created" | "reused" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or ambiguous
envelope field, anything you had to guess at or work around. Journal it even when you
recovered. Name the exact command or field. Skip the journal only when the run was genuinely
unremarkable.
