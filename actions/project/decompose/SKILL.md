---
name: project.decompose
description: Break a project (brief.md + features.json in docs/projects/<slug>/) into roadmap.md — milestones as a dependency graph, the thinnest end-to-end slice first and the riskiest unknown next, each with a standalone meta.job brief and the feature IDs it must pass. Its milestones[] output maps straight onto meta.job steps. Returns ordering or scope questions as clarifications[]; when there are any, follow it with a meta.session "Answer clarifications" and a second project.decompose. Read-only — the file comes back in the output for a later code.orchestrate-pr step to commit (see SHARED-project-folder.md).
outpost:
  kind: action
  category: project
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 1800
  retries: 0
---

# project.decompose

Cut the project into milestones a child job can each build alone. Read-only: never edit,
never post.

## Step 1 — Read

```bash
cat "$OUTPOST_ENVELOPE"
cat ~/.outpost/actions/SHARED-project-folder.md
```

| Input | Required | Meaning |
|---|---|---|
| `slug` | yes | The project folder, `docs/projects/<slug>/`. |
| `context` | no | Anything else the planner wants weighed: a deadline, a fixed first milestone. |

Take each file's newest copy (a `previousSteps` `files[]` entry, else the checkout):

- `brief.md` and `features.json` — required. Without either, fail the step with
  `submit_step_failed` naming the path.
- `DESIGN.md`, `architecture.md`, `decisions/` — read when present; a milestone brief points
  at them rather than restating them.
- `roadmap.md` and `progress.md` — when present, this is a re-decompose. A milestone
  `progress.md` records as landed is finished: keep it in `roadmap.md`, but leave it out of
  `milestones[]` (Step 4). Never renumber or reuse a milestone ID. Every existing milestone
  keeps its own, and a new one takes the next `M`-number above the highest in `roadmap.md`.
  A milestone this run removes stays in `roadmap.md` marked dropped, never deleted, so its ID
  is never issued again. A dropped milestone is not in `milestones[]` either. A re-run within
  the same job starts from its own earlier output, under the same rules.
- `meta.session` outputs in `previousSteps` — answers and corrections (*Clarifications* in
  the shared doc).

## Step 2 — Order the milestones

1. **The thinnest end-to-end slice first** — every layer the finished project has, each doing
   the least it can, so the next milestones extend something that runs.
2. **Then the riskiest unknown** — the brief's worst rabbit hole, so it fails early and cheap.
3. Then the rest, in dependency order.

Every feature in `features.json` not marked `dropped` appears in exactly one milestone's
`acceptance`, and a finished milestone's acceptance counts. A milestone is sized for one child
job; if a brief needs more than a screen, split it.

When the order or a milestone's scope hinges on a question the brief and features don't
settle — which of two rabbit holes is riskier, whether a feature belongs in the first slice —
write the marker in `roadmap.md` at the affected milestone and list the question in
`clarifications` (at most 5). Still emit a complete provisional order and `milestones[]`.
Anything less consequential you decide, and say so in the milestone's brief. A re-run orders by
the answers, and never renumbers.

## Step 3 — Write each milestone's brief

A child job's planner sees **only** this text, so it stands alone. Five parts:

- **Goal** — one or two sentences.
- **Scope** — what this milestone builds.
- **Out of scope** — what a neighbouring milestone owns, named so it isn't built twice.
- **Read first** — folder files by repo path (`docs/projects/<slug>/brief.md`, …).
- **Done when** — each acceptance feature's `steps` work end to end, plus anything else
  checkable, and the PR appends a `progress.md` entry for this milestone's ID. Not "`passes`
  is true": only `project.accept-milestone` sets that, after the fact.

Each milestone's `title` starts with its ID (`M1 — Playable empty level`), so the child job,
which sees only its title and brief, knows which milestone it is.

`roadmap.md` renders the same milestones for people: one section each, holding the title,
`Depends on`, `Acceptance` and the brief. At most a screen per milestone.

## Step 4 — Submit

`output` is a JSON string per `output.schema.json`. Each `milestones[]` entry becomes a
`meta.job` step: `title` → `inputs.title`, `brief` → `inputs.brief`, and `dependsOn` orders
them. So `milestones[]` holds only the milestones still to build. A `dependsOn` entry may
name a finished milestone, which is already satisfied.

```json
{
  "slug": "space-game",
  "files": [{ "path": "docs/projects/space-game/roadmap.md", "content": "# Roadmap\n\n## M1 — …" }],
  "summary": "4 milestones; M2 de-risks the physics engine.",
  "milestones": [
    { "id": "M1", "title": "M1 — Playable empty level", "dependsOn": [], "acceptance": ["F-001", "F-002"], "brief": "## Goal\n…" }
  ],
  "clarifications": []
}
```

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output,mcp__outpost__submit_step_failed,mcp__outpost__submit_journal", max_results: 3 })
mcp__outpost__submit_step_output({ jobId: "<jobId>", stepId: "<stepId>", output: "<the JSON string>" })
```

## Before you exit — journal a blocker

```
mcp__outpost__submit_journal({
  action: "project.decompose", jobId: "<jobId>", stepId: "<stepId>",
  outcome: "decomposed" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, a missing or ambiguous envelope field,
anything you had to work around. Name the exact command or field. Skip it when the run was
unremarkable.
