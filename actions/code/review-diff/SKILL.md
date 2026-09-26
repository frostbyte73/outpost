---
name: code.review-diff
description: Review a worktree's diff with fresh context — no knowledge of how the code came to be written — and return a structured list of issues (severity, file, line, comment) plus a one-paragraph summary. Checks the implementation against its spec and plan when the caller passes them, then scans the diff for bugs and house-style violations. Read-only — recommends only, does not edit.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read, pull]
  timeout_sec: 600
  retries: 0
---

# code.review-diff

Review of a working-tree diff by a session that did not write it. Does not modify files.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `workspace.repoCwd` | yes | Parent repo path. |
| `workspace.branch` | yes | Branch under review. |
| `context` | no | Optional `{goal, approach, risks, spec, implPlan}` from the step that produced the diff. |
| `diffRange` | no | Git diff range to review instead of the uncommitted diff — see below. |
| `worktreePath` | no | Absolute path of the worktree holding the diff. When set, run every git read as `git -C <worktreePath> …` and read files under it, instead of using your own cwd — see below. |


### `worktreePath` — when the diff lives in somebody else's worktree

Your own cwd is not always where the change is. A controller reviewing its *uncommitted* work
dispatches you with no workspace of your own (`workspace: {"kind":"none"}`) and passes
`worktreePath`, because a checkout of the branch would hold the committed tree — the change
under review would not be in it, you would review an empty diff, and you would report no
issues on code you never read.

When `worktreePath` is set, prefix every git read with `-C` and root every file read at that
path:

```bash
git -C <worktreePath> status
git -C <worktreePath> diff
```

Both are in the `read` group, so no extra grant is needed. If `git -C <worktreePath> diff` and
`git -C <worktreePath> status` both come back empty, **say so as a failure** rather than
reporting a clean review — an empty diff means the path or the range was wrong, not that the
code is fine.

## What to look for

If `diffRange` is absent, run `git status` + `git diff` to see the changes — this is the default, unchanged behavior: an uncommitted working-tree diff. If `diffRange` is set, run `git diff <diffRange>` instead (e.g. `git diff abc123...def456`) and skip `git status` — there's nothing uncommitted to report, the range itself is the diff under review.

`diffRange` exists for reviewing a PR's worktree, which is a clean detached checkout with no uncommitted changes — reviewing `git diff` there finds nothing and this action would report "no issues" on a diff it never looked at. The caller is expected to pass the three-dot form, `<merge-base>...<head>`, not `<base>..<head>` (two dots). Three dots is "what this branch actually changed since it forked" — `git diff A...B` *means* `git diff $(git merge-base A B) B`. That expansion is the semantics, not a recipe: `git merge-base` is not in this action's grant and running it is denied, so write the three dots and let git find the base itself. Two dots would also pull in every commit that landed on the base branch after the fork, and you'd flag someone else's code as if the PR author wrote it.

Read CLAUDE.md (and any `AGENTS.md`) to ground the review in conventions before you flag style issues.

### First, does the code do what it was supposed to do?

When `context.spec` or `context.implPlan` is set, that is the first pass and the one worth most — diff hygiene is the cheap half. The spec and the plan were written by the same session that then wrote the code, each step reading the last, so nobody has yet checked the result against the intent with fresh eyes. That is your job:

- **Every commitment in the spec has code behind it.** Walk the spec's claims one at a time and find the lines that implement each. A commitment with nothing behind it is `severity: "error"`, not a nit — a half-built feature that reads as finished is the most expensive thing to land.
- **Every task in the plan either landed or was consciously dropped.** A plan task with no diff and no explanation is a gap; say which one.
- **Deviations from the plan are justified improvements, not drift.** Flag each one you find and say which it looks like, so the implementer can confirm.
- **The spec is a vision document, not an enumeration.** It says what the software must do; it does not list every input, state, or failure the code will meet. Where the spec is silent, judge by what a reasonable user of this code would expect — silence is not permission. Grade by the effect on that person, not by whether the spec mentioned the case.
- **Problems with the plan itself** — a task that was the wrong idea, a spec commitment that contradicts another — are findings too. Say so explicitly rather than grading the code against a bad plan.

Then scan the diff for:

- Stray debug prints / commented-out code / "// removed: previously did X" epitaphs.
- Comments that restate code, name-restate functions, or narrate task history (`// fix for ENG-123`).
- Half-finished slices, dead branches added "just in case", backwards-compat wrappers inside a repo the owner controls.
- Files touched off-target (auto-format sweeps, accidental dependency bumps).
- Bugs (off-by-one, missed null cases, race conditions, resource leaks) — these get `severity: "error"`.
- Error paths: failures swallowed, errors wrapped without context the caller lacks, a `panic`/`throw` where the case is recoverable.
- Tests that assert on mocks rather than behavior, and behavior changed with no test touched at all.

Be sparing with `severity: "error"` — reserve it for things that would actively break. Most lint-style findings are `info` or `warn`.

## Output

```jsonc
{
  "summary": "Five files changed; one off-by-one in pagination, two stale comments to delete.",
  "issues": [
    { "severity": "error", "file": "src/page.ts", "line": 47, "comment": "loop ends at length-1, drops the last row." },
    { "severity": "info",  "file": "src/page.ts", "line": 12, "comment": "Comment restates the function name." }
  ]
}
```

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
```

If the tool doesn't come back, halt. The daemon will mark the step failed when your turn ends. Do NOT try to submit the review as your final text message.

Then call `mcp__outpost__submit_step_output` with `output` set to the JSON-stringified review object. Stop.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "code.review-diff",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "reviewed" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, a documented command that didn't exist, anything you had to
guess at or work around. Journal it even when you recovered and the step succeeded. These
recur identically on every future run of this action until a human sees them, and this
journal is the only place `meta.improve-actions` looks.

Name the exact command or field. "`git clone` denied — this action's `allowlist.json` has
no clone rule" is actionable; "permissions were too tight" is not. Skip the journal only
when the run was genuinely unremarkable; don't pad.
