# 0001 — Bootstrap, then dogfood

- Status: accepted, 2026-11-27 (chosen by the user)
- Source: [design spec, "How this work runs"](../../../superpowers/specs/2026-11-27-project-actions-design.md#how-this-work-runs)

## Context

- At the start only today's actions exist; the project needs new planning actions to plan itself well.

## Decision

- Approach B: M1 builds the minimal planning chain on today's tools. Every later milestone is re-planned with the tools the earlier ones built.

## Alternatives

- A. Fixed sequence on the old tools throughout. Predictable, but the new actions are first exercised at the end, when fixing them costs most.
- C. All children up front, in parallel. Fastest, but loses ordering and dogfooding, and parallel PRs against `engine.ts` / `meta.orchestrate` would conflict.

## Consequences

- A weak early action degrades every later plan, so each milestone hold is a real checkpoint.
- Edits to existing bundled actions must reach `~/.outpost/actions/`, so bundled-action sync must land before any other M1 PR.
