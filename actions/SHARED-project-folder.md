# The project folder

A project bigger than one PR keeps its shared memory in the repo it builds, at
`docs/projects/<slug>/` (kebab-case slug; one repo may hold several projects). It is the
only memory a project's child jobs share: a child's planner sees nothing but its own brief,
so every child-job brief names this folder and the files in it the child must read.

**The folder changes only through PRs.** A child that learns something — a decision, a
finished milestone, a revised design — updates the file in its own PR. Never edit it out of
band, and never keep a fact a later job needs anywhere else.

## Files

| File | Purpose | Budget | Written by |
|---|---|---|---|
| `brief.md` | Problem, audience, appetite (time budget), no-gos, rabbit holes, success criteria. | ≤ 1 page | `project.shape` |
| `features.json` | The acceptance list — one entry per user-visible behaviour (schema below). | as many entries as behaviours, no more | `project.requirements` |
| `DESIGN.md` + tokens | Visual and UX language; tokens as `tokens.json` or `tokens.css` beside it. | ≤ ~150 lines | `design.*` |
| `architecture.md` | Components, data flow, key interfaces and where each lives. | ≤ ~150 lines | `arch.*` |
| `decisions/NNNN-<slug>.md` | One ADR per decision: context, decision, consequences. | ≤ ~40 lines each | whoever decides |
| `roadmap.md` | Milestones as a dependency graph, each with a standalone `meta.job` brief and its acceptance feature IDs. | ≤ ~1 screen per milestone | `project.decompose` |
| `progress.md` | Append-only log: date, milestone, what landed (PR link), what's next. | one short entry per landing | each milestone |

Budgets are ceilings, not targets. A document nobody reads is worse than a short one.

- **ADRs** are numbered from `0001` and never renumbered. A changed decision gets a new ADR
  that supersedes the old one; the old one is not edited beyond a `Superseded by NNNN` line.
- **Roadmap order:** the thinnest end-to-end version first, then the riskiest unknown, then
  everything else.

## `features.json`

```json
[
  {
    "id": "F-001",
    "category": "core-loop",
    "description": "The player can start a new game from the title screen.",
    "steps": ["Open the app", "Click New Game", "The first level loads with the player at spawn"],
    "passes": false
  }
]
```

- `id` is stable and never reused, even after a feature is dropped. Plan steps and roadmap
  milestones trace to these IDs.
- `category` is a free-form grouping within the project, not an action category.
- `steps` are end-to-end test steps a person (or a browser driver) could follow.

**Only the acceptance evaluator (`project.accept-milestone`) may set `passes: true`**, and
only with end-to-end evidence cited in its PR. Every other action writes `passes: false` and
leaves it there — including an implementer certain the feature works. Self-reported
completion is exactly what this field exists not to trust.

## When a file is missing

An action that needs a file the folder doesn't have says so — in its output, or as
`[NEEDS CLARIFICATION]` in the document it writes — rather than inventing the content.
