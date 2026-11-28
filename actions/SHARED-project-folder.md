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
| `progress.md` | Append-only log: date, milestone ID (e.g. `M2`), what landed (PR link), what's next. | one short entry per landing | each milestone |

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

- `id` is stable and never reused. Plan steps and roadmap milestones trace to these IDs.
- `dropped` is optional: `true` on a feature the project no longer wants, absent otherwise. A
  dropped feature is never deleted, so the highest ID ever issued is always visible and the
  next one can't repeat it.
- `category` is a free-form grouping within the project, not an action category.
- `steps` are end-to-end test steps a person (or a browser driver) could follow.

**Only the acceptance evaluator (`project.accept-milestone`) may set `passes: true`**, and
only with end-to-end evidence cited in its PR. Every other action writes `passes: false` and
leaves it there — including an implementer certain the feature works. Self-reported
completion is exactly what this field exists not to trust.

## How the folder lands

The `project.*` actions are read-only. None of them edits the tree: each returns the files it
wrote as its step output, and a later `code.orchestrate-pr` step commits them.

- The `output` passed to `submit_step_output` is a JSON string:
  `{"slug": "<slug>", "files": [{"path": "docs/projects/<slug>/brief.md", "content": "…"}], "summary": "<1–3 lines>", …}`.
  `path` is relative to the repo root and always under `docs/projects/<slug>/`; `content` is
  the whole file, never a diff.
- The step that commits them writes every `files[]` entry **byte for byte** — no rewording,
  no reformatting. When two earlier steps emitted the same path, the later step wins.
- **The newest copy of a folder file** is the latest `previousSteps[].output` `files[]` entry
  for that path; only without one is it the file in the checkout. A chain like shape →
  requirements → decompose runs before anything is committed, so the checkout is stale.

## Clarifications

`project.shape`, `project.requirements` and `project.decompose` share one contract for what
they can't decide.

- **Ask few.** Where a later step would have to guess, write
  `[NEEDS CLARIFICATION: <one specific question>]` in place in the file you write, and list
  the questions of the markers still in it as `clarifications[]`, verbatim and in order —
  **at most 5**. Everything else you decide yourself and record as an assumption: in
  `brief.md`'s Assumptions section, or in the feature's or milestone's own text. With more
  than 5 candidates, keep the 5 that most change what gets built and assume the rest.
- **Where answers come from.** Read every `meta.session` output in `previousSteps`, not only
  the newest. A report, `{resumed_by: "report", report, answers?, corrections?}`, carries
  `answers` as `[{question, answer}]` and, after a sign-off, `corrections`: changes the user
  asked for. A Done, `{resumed_by: "user", note?}`, answers in its free-text `note`. Apply an
  answer whose question matches one of your markers (by meaning, if the user paraphrased —
  say so in `summary`), and a correction that concerns your file or one it derives from.
- **Revise, don't restart.** A re-run starts from the newest copy of its own file. It resolves
  every answered marker — the answer written in, the marker gone, the question not listed
  again — keeps the unanswered ones, and never re-asks something already answered. A session
  with no answers, corrections or note answers nothing.
- **The planner's side.** A non-empty `clarifications` is followed by a `meta.session`
  "Answer clarifications" whose prompt lists the questions verbatim, then a second run of the
  same action. An output with no `clarifications` field has none.

## When a file is missing

An action that needs a file the folder doesn't have says so — in its output, or as
`[NEEDS CLARIFICATION]` in the document it writes — rather than inventing the content. When
the missing file is one the action requires as input (`brief.md` for `project.requirements`;
`brief.md` and `features.json` for `project.decompose`), it fails the step with
`submit_step_failed`, naming the path.
