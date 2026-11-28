---
name: meta.session
description: Hand a step to the user as an ordinary interactive session that starts by sending a given prompt — a hands-on task for the user to do with Claude's help (restart a service and check it, test a build by hand, verify a milestone's acceptance features), or a personal skill invocation like `/investigate-cscu CSCU-123`. Use when a person has to do or check something themselves; a plain hold with nothing to do is meta.wait. Builtin runner — the daemon starts the session as soon as the step begins; the step resolves when the user marks it done or the session reports back, and the planner then reviews it.
outpost:
  kind: action
  category: meta
  side_effects: none
  runner: builtin
  timeout_sec: 604800
  retries: 0
---

# meta.session

A step whose work is one user-driven Claude session. When the step starts, the daemon spawns a session under the **user's own permissions** — not an action allowlist — and sends `prompt` as its first message. The step parks in `waiting` with the session rendered inline; the user converses with it, approves whatever it asks to do, and marks the step **Done** in the PWA when finished.

Use it whenever a step's work is **a person doing something by hand** — run or restart something and check the result, click through a build, verify a milestone against its acceptance features, apply a manual fix. The prompt says what to do and how to tell it worked; Claude in the session helps the user carry it out. It is one step in the plan like any other: the steps after it run once the user marks it done.

The special case is a ticket type with a dedicated personal skill the user runs interactively (see meta.orchestrate's "Personal-workflow tickets"). There the skill owns the investigation, the approval gates and the write-back, so the `meta.session` that starts it is the job's **only** step.

Do NOT use it for work an action in the catalog already covers. Do NOT use it for a pure hold — a deploy soak, or "resume when you're ready to promote" where the user only decides whether to continue and has nothing to do — that's `meta.wait`.

## Inputs

- `prompt` — the first message, verbatim. Either a skill invocation (`/<skill-name> <args>`), or plain instructions: what to do, in which repo, and what to check to call it done (commands to run, features to verify, what a pass looks like).
- `reason` — optional one-liner shown on the step in the PWA.

The session opens in the step's `workspace`: `none` opens it in the user's home directory, `readonly` in a fresh checkout of that repo. Never `writable`.

## Output

The step settles one of two ways, and either one is followed by the planner's step-review:

- **Done** in the PWA, with an optional note → `{resumed_by: "user", note?}`.
- **A report** — Claude in the session calls `submit_session_report` when the user says they're done or asks it to report back, never on its own judgment → `{resumed_by: "report", summary, report, answers?, corrections?, wantsReplan?}`. `answers` are `[{question, answer}]` for a step that asked clarification questions; `corrections` are the changes the user asked for at a sign-off.

When the step exists to collect answers or a sign-off, say so in the `prompt`, so the session knows to put them in `answers` or `corrections`.
