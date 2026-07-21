---
name: code.review-diff
description: Read the uncommitted diff in a worktree and return a structured list of issues (severity, file, line, comment) plus a one-paragraph summary. Read-only — recommends only, does not edit. Extracted from code.implement's self-review step so any code-writing playbook can reuse it.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# code.review-diff

Self-review of an uncommitted working-tree diff. Does not modify files.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `workspace.repoCwd` | yes | Parent repo path. |
| `workspace.branch` | yes | Branch under review. |
| `context` | no | Optional `{goal, approach, risks}` from the step that produced the diff. |

## What to look for

Run `git status` + `git diff` to see the changes. Read CLAUDE.md (and any `AGENTS.md`) to ground the review in conventions before you flag style issues. Then scan for:

- Stray debug prints / commented-out code / "// removed: previously did X" epitaphs.
- Comments that restate code, name-restate functions, or narrate task history (`// fix for ENG-123`).
- Half-finished slices, dead branches added "just in case", backwards-compat wrappers inside a repo the owner controls.
- Files touched off-target (auto-format sweeps, accidental dependency bumps).
- Bugs (off-by-one, missed null cases, race conditions, resource leaks) — these get `severity: "error"`.

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
