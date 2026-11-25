---
name: meta.job
description: Run a whole job as one step of this plan — either create a new job from a title and a self-contained brief, or link an existing job by id. Use when a step is itself multi-step work that deserves its own plan. Builtin runner — the daemon spawns no session; the child job runs its own planner and the step settles when the child does.
outpost:
  kind: action
  category: meta
  side_effects: none
  runner: builtin
  retries: 0
---

# meta.job

A step whose work is another job.

- **Create** (`title` + `brief`): the child job is created only when this step's turn comes, never earlier, so the brief can still be revised by a re-plan until then. Once created, the child keeps the brief it started with.
- **Link** (`job_id`): adopt an existing job as this step. Refused if the job doesn't exist, already belongs to another parent, or is this job or one of its ancestors.

The child's planner sees only its brief (plus whatever it investigates itself), so **the brief must stand alone**: the goal, the scope, what's out of scope, the files or docs to read, and when it counts as done. Don't rely on this plan's other steps or on conversation context.

The step resolves when the child job is `done`, with an output naming the child, its PRs and its last step's output. If the child fails or is abandoned, the step fails and this job re-plans around it; if the child is retried and recovers, the step recovers too.

Prefer create. Link only when the user named an existing job by id.
