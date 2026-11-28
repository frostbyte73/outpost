---
name: project.shape
description: Shape a project idea into a one-page brief.md — problem, audience, appetite (time budget), no-gos, rabbit holes, success criteria — for docs/projects/<slug>/. Writes [NEEDS CLARIFICATION] instead of guessing and returns those questions as clarifications[]; when there are any, follow it with a meta.session "Answer clarifications" and a second project.shape. Read-only — the file comes back in the output for a later code.orchestrate-pr step to commit (see SHARED-project-folder.md).
outpost:
  kind: action
  category: project
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 1800
  retries: 0
---

# project.shape

Turn an idea into the brief every later step of the project plans against. Read-only: never
edit, never post.

## Step 1 — Read

```bash
cat "$OUTPOST_ENVELOPE"
cat ~/.outpost/actions/SHARED-project-folder.md
```

| Input | Required | Meaning |
|---|---|---|
| `idea` | yes | The user's description of the project, in their words. |
| `slug` | no | Folder name under `docs/projects/`. Derive a short kebab-case one from the idea when absent. |
| `context` | no | Anything else the planner knows: constraints, the target repo, who it's for. |
| `answers` | no | Answers to an earlier draft's clarifications, when the planner already has them. |

Also read, newest first per the shared doc:

- An earlier `project.shape` output in `previousSteps` — this run is then a **revision**.
- A `meta.session` output in `previousSteps` — its `answers` (or its Done `note`) holds the user's answers.
- `docs/projects/<slug>/brief.md` in the workspace, when the repo already has one.

The workspace is `readonly` on the target repo, or `none` for a project with no repo yet. In
an existing repo, skim its `README.md` and `CLAUDE.md` so the brief doesn't contradict them.

## Step 2 — Write `brief.md`

One page at most. Six sections, each a few lines:

- **Problem** — what is wrong or missing today, and for whom.
- **Audience** — who uses the result and what they already have.
- **Appetite** — how much time this is worth (a budget the scope fits into, not an estimate).
- **No-gos** — what is deliberately out, so a later step doesn't build it.
- **Rabbit holes** — the risky unknowns, each with how the project will de-risk it.
- **Success criteria** — observable outcomes that mean done.

Never guess. Where the idea doesn't settle something a later step would have to decide, write
`[NEEDS CLARIFICATION: <one specific question>]` in place. On a revision, resolve every marker
the answers cover and keep the ones they don't.

## Step 3 — Clarifications

`clarifications` lists the questions from the markers still in the brief, in order, verbatim.
It is empty when the brief has none.

**The contract the planner relies on:** when `clarifications` is non-empty, the plan follows
this step with a `meta.session` "Answer clarifications" whose prompt lists the questions, then a
second `project.shape` with the same `slug`. The user answers in that session, and the second
run reads the draft and those answers from `previousSteps`. If the second run still returns
clarifications, that is the planner's cue to re-plan with another session and shape pair. A
session that comes back with no answers answers nothing, so the markers stay as they were.

## Step 4 — Submit

`output` is a JSON string per `output.schema.json`:

```json
{
  "slug": "space-game",
  "files": [{ "path": "docs/projects/space-game/brief.md", "content": "# Space game\n\n## Problem\n…" }],
  "summary": "Brief for a browser space shooter; 2 open questions on audience and platform.",
  "clarifications": ["Is this for desktop browsers only, or also mobile?", "…"]
}
```

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output,mcp__outpost__submit_journal", max_results: 2 })
mcp__outpost__submit_step_output({ jobId: "<jobId>", stepId: "<stepId>", output: "<the JSON string>" })
```

## Before you exit — journal a blocker

```
mcp__outpost__submit_journal({
  action: "project.shape", jobId: "<jobId>", stepId: "<stepId>",
  outcome: "shaped" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, a missing or ambiguous envelope field,
anything you had to work around. Name the exact command or field. Skip it when the run was
unremarkable.
