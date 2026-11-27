---
name: project.requirements
description: Turn a project's brief.md (plus DESIGN.md / architecture.md when present) into features.json — one acceptance entry per user-visible behaviour, each with end-to-end test steps and passes:false — for docs/projects/<slug>/. Never sets passes to true. Read-only — the file comes back in the output for a later code.orchestrate-pr step to commit (see SHARED-project-folder.md).
outpost:
  kind: action
  category: project
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 1800
  retries: 0
---

# project.requirements

Write the acceptance list every milestone is judged against. Read-only: never edit, never post.

## Step 1 — Read

```bash
cat "$OUTPOST_ENVELOPE"
cat ~/.outpost/actions/SHARED-project-folder.md
```

| Input | Required | Meaning |
|---|---|---|
| `slug` | yes | The project folder, `docs/projects/<slug>/`. |
| `context` | no | Anything else the planner wants weighed. |

Take each file's newest copy (a `previousSteps` `files[]` entry, else the checkout):

- `brief.md` — required. Without it, fail the step with `submit_step_failed` naming the path.
  `[NEEDS CLARIFICATION]` markers still in it are not a failure: they carry into the
  affected entries (below).
- `DESIGN.md`, `architecture.md` — when present, they sharpen the steps; they don't add scope.
- `features.json` — when present, this run **extends** it.

## Step 2 — Write `features.json`

The schema is in the shared doc. One entry per user-visible behaviour the brief's success
criteria need — no more. Nothing the brief lists as a no-go.

- `steps` are end-to-end: what a person or a browser driver does and sees, not unit checks.
- An existing entry keeps its `id` and its `passes` value. New entries take the next `F-NNN`
  above the highest ID in the file.
- Never delete an entry. A feature the brief no longer wants gets `"dropped": true` and stays,
  so its ID is never issued again.
- **`passes` is `false` on every new entry.** Only `project.accept-milestone` may set it to
  `true`, with evidence. You never do, however sure you are a feature works.
- A behaviour the brief leaves ambiguous, including one behind an open marker in the brief,
  gets `[NEEDS CLARIFICATION: <question>]` in its `description`, not an invented answer.

Pretty-print with two-space indent.

## Step 3 — Submit

`output` is a JSON string per `output.schema.json`:

```json
{
  "slug": "space-game",
  "files": [{ "path": "docs/projects/space-game/features.json", "content": "[\n  {\n    \"id\": \"F-001\", …" }],
  "summary": "14 features across core-loop, menus and scoring; 1 needs clarification.",
  "featureIds": ["F-001", "F-002"]
}
```

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output,mcp__outpost__submit_step_failed,mcp__outpost__submit_journal", max_results: 3 })
mcp__outpost__submit_step_output({ jobId: "<jobId>", stepId: "<stepId>", output: "<the JSON string>" })
```

## Before you exit — journal a blocker

```
mcp__outpost__submit_journal({
  action: "project.requirements", jobId: "<jobId>", stepId: "<stepId>",
  outcome: "written" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, a missing or ambiguous envelope field,
anything you had to work around. Name the exact command or field. Skip it when the run was
unremarkable.
