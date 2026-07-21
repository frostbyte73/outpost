---
name: human.gate
description: Pause the job and ask the user a single yes/no/choose question before continuing. Used between any two steps that need explicit human confirmation — verdict review, write approval, branch selection. Runner is "builtin" — the daemon implements the wait natively, this body is documentation.
outpost:
  kind: action
  category: human
  side_effects: none
  runner: builtin
  human_gate: false
  timeout_sec: 86400
  retries: 0
---

# human.gate

A daemon-side pause. The orchestrator marks the step as awaiting input, surfaces the question + options + preview in the PWA, and waits for the user to click an option. The user's choice becomes the step's output, available to downstream steps via `{from: <stepId>, path: "choice"}`.

This action exists so that every gated write in a playbook is **a visible, auditable step** instead of buried prose inside a skill. If your playbook would otherwise contain "ask the user before X," insert a `human.gate` step before X.

There is no Claude session spawned for this action.
