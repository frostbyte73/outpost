---
name: meta.wait
description: Pause the job between steps until the user resumes — a hold/soak with an optional auto-resume timer. Use between deploy rings (let a canary bake, verify health, then continue) or before an irreversible write so the user can review a preview and resume or abandon. Builtin runner — the daemon spawns no session, but the user can open one on the parked step to check on what it's waiting for.
outpost:
  kind: action
  category: meta
  side_effects: none
  runner: builtin
  timeout_sec: 604800
  retries: 0
---

# meta.wait

A daemon-side pause between steps. The orchestrator marks the step as waiting, surfaces the `reason` + optional `preview` in the PWA, and holds the job until one of:

- **the user resumes** — the job continues to the next step, or
- **the timer elapses** — if `duration_sec` is set, the wait auto-resumes after that soak period, or
- **the user abandons the job** — nothing downstream runs.

It is a **hold, not a question**. It has no options and asks nothing to *assess* — it only pauses so a human (or the clock) can decide the job is safe to continue. That resume-or-abandon is the implicit yes/no; there is no N-way pick.

Two shapes:

- **Timed soak** — set `duration_sec` to bake a deploy before the next ring. The user can still resume early.
- **Manual hold** — omit `duration_sec` and the job waits indefinitely for the user. Pair a `preview` (a health verdict from an upstream `read.investigate`, a diff link, the drafted body of a pending write) so the user has what they need to decide.

Do NOT use `meta.wait` to *assess* something — "is staging healthy?" is `read.investigate`, which reads the metrics and produces a verdict. Do NOT use it for a hands-on task either — "restart the daemon and confirm the catalog", "test the build by hand" — that's `meta.session`, which starts the user's session with instructions instead of leaving them to open one. `meta.wait` is only the follow-up hold: "given those findings, resume when you're ready to promote." And never use it as a stand-in for real work — a "deploy" is an `orchestrated` PR step (the merge IS the deploy), not a wait.

The daemon spawns no Claude session for this action. The user can open one from the parked step — an ordinary session under their own permissions, pre-loaded with the job, this wait's `reason`/`preview`, and the earlier steps' outputs — to check on a deploy or run a manual test. It opens in the step's `workspace`: give the wait a `readonly` workspace on the repo where that checking happens (the deploy-config repo with no `ref`, which opens at the freshly fetched base branch; the repo under test with `ref` at the PR's branch), or `none` to have the user pick. Never `writable`.
