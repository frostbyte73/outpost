# Plan diagrams (d2)

A plan can carry one diagram in `findings.diagram`, written in d2 (https://d2lang.com). The PWA shows it right under the plan's summary, before any folded section. So it is the second thing the user reads at plan approval. If it does not show the change at a glance, leave it out.

## When to draw

No diagram is the default. If a picture says something that the step list cannot, draw one. That is the case when:

- The plan touches two or more components, services, or repos, and the order or direction between them matters.
- The plan changes a request flow or a data flow: something moves through a different path after the change.
- The plan changes a state machine or a lifecycle: states or transitions are added, removed, or rewired.

Do not draw a diagram for these jobs:

- a single-file fix, a copy change, or a config change
- a version bump
- a pure investigation or a code review

A diagram of one box, or of boxes in a straight line, says nothing that the steps do not already say.

## What to draw

- Draw only the part of the system that the change touches. Do not draw the whole architecture.
- Keep it to about 15 nodes at most.
- Use the real names from the code: modules, services, functions, tables. Every node must be something you read during the investigation.
- Label every edge with what moves along it (`submit_plan`, `PR url`, `job.json`).
- Mark what the plan adds or changes. Put the new parts in a `new` class with a thicker stroke and a bold label. Keep everything else plain.
- If the change rewires an existing flow, draw `before` and `after` as two containers side by side.

```d2
classes: {
  new: { style: { stroke-width: 3; bold: true } }
}
direction: right

orchestrator: meta.orchestrate
daemon: daemon {
  submit: submit_plan handler
  check: checkPlanDiagram {class: new}
  engine: WorkEngine.onPlanReady
  submit -> check: findings.diagram
  check -> engine: compiled ok
}
pwa: PWA plan card

orchestrator -> daemon.submit: submit_plan
daemon.engine -> pwa: job over WS
pwa -> daemon: "GET diagram.svg" {class: new}
```

## Rules the daemon enforces

The daemon compiles the source when you call `submit_plan`. If it does not compile, the call fails with d2's own message (with line and column). Fix the source and submit again.

- No imports: no `@file` and no `...@file`. Write the whole diagram inline.
- No `icon:`. d2 fetches icons over the network.
- The source is at most 20,000 characters.

Do not set any colors: no `fill`, `stroke`, `font-color`, and no `theme-overrides`. The daemon paints the diagram in the colors of the theme that the user has on, and it overrides any color that the source sets in `theme-overrides`.
