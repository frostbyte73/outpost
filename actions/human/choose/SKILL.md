---
name: human.choose
description: Pause the job and ask the user to pick from N structured options. Each option has a value, a label, and optional description/link/preview metadata so the user can compare before selecting. Richer than human.gate — use when the choices have associated context. Builtin runner — no Claude session spawned.
outpost:
  kind: action
  category: human
  side_effects: none
  runner: builtin
  timeout_sec: 86400
  retries: 0
---

# human.choose

A daemon-side richer pick than human.gate. The PWA renders the prompt + each option's label/description/link/preview and waits for the user to choose. Single or multi-select.

The chosen `value` becomes the step's output (or array of values when `multi_select` is true). Downstream steps reference it via `{from: <stepId>, path: "selected"}`.

There is no Claude session spawned for this action.
