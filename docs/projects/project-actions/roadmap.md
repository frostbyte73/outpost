# Project actions — roadmap

- Each milestone is one `meta.job` child, followed by a user hold. They run one at a time, in the order below — never in parallel (they collide on `src/work/engine.ts` and `meta.orchestrate`).
- IDs are stable and never renumbered: M7 (hardening) was added after M1 and runs before M2.
- Each child's brief is the section below, opened by a header naming the repo (frostbyte73/outpost, `~/github/frostbyte73/outpost`) and this folder.

## M1 — Bootstrap the planning chain (landed)

- **Status:** landed, commits `3307710`…`4924e27` on `main`.
- **Depends on:** —
- **Acceptance:** F-001, F-002, F-003, F-004, F-005, F-006, F-007, F-008, F-009, F-010

Bundled-action sync on daemon start; this project folder; `actions/SHARED-project-folder.md`; categories `design`, `arch`, `project`; the `meta.orchestrate` project category; `project.shape`, `project.requirements`, `project.decompose`; `write.create-repo`; `meta.session` for hands-on steps.

## M7 — Harden the planning chain

- **Depends on:** M1
- **Acceptance:** F-011, F-012, F-013, F-014, F-015, F-016, F-017, F-018, F-019, F-020, F-060, F-061, F-062, F-063

### Goal

Make the M1 planning chain safe to build on: answers given in a session reach the re-run, the user signs off the folder content before it lands, clarifications stay few and are handled the same way at every step, and a step that finds the plan wrong can say so. The design is `docs/design/step-reports.md`.

### Scope

- The design doc and this acceptance rewrite (first).
- `meta.session` reports back: `submit_session_report`, Done with a note on `work/step-card.js`, `cockpit/bodies.js` and `tracked/focus-rail.js`, and a step-review after every settled meta.session.
- Replan requests: `submit_replan_request` for action and meta.session steps, a `replan` move for controllers, the `replan_requested` state, immediate replan-mode routing, two strikes.
- `meta.wait` removed; a timed soak becomes a plan-level `delaySec` on the step that waits.
- `meta.orchestrate` project category: a sign-off `meta.session` before the PR that commits the folder, with corrections re-running the chain; an "Answer clarifications" `meta.session` and a second run for each project.* action; a final `meta.session` check after the last milestone.
- `project.shape`: at most 5 scope/audience/appetite clarifications; other unknowns become assumptions.
- `clarifications[]` on `project.requirements` and `project.decompose`, handled like shape's.
- `project.requirements`: checkable `quality` entries (look, feel, not generic) for any project with a UI.

### Out of scope

Screenshots and visual review (M2); verification actions (M4); new categories or grants.

## M2 — UI quality loop

- **Depends on:** M7
- **Acceptance:** F-021, F-022, F-023, F-024, F-025, F-026, F-027, F-028, F-029, F-030, F-054, F-055, F-056

### Goal

Outpost renders a UI, reviews it from screenshots with fresh context and fixes it, proven by rebuilding one Outpost screen the user names into one they judge better.

### Scope

- Localhost-only screenshot grant, designed in `docs/design/permissions.md`, landed first as its own PR.
- `npm run ui:check`: a11y, overflow/clipping, off-token values, generic-AI lint, console errors.
- `code.implement-ui`, `code.review-visual` (fixed matrix, cited rubric, ≤ 5 located fixes, ship / don't ship).
- `code.orchestrate-pr` honours `inputs.lenses: [visual]`; no round cap — ends on ship or two passes that don't beat the best, keeping the best round; taste disputes go to the user side by side.
- PWA shows screenshots at gates; a calibration hold; the screen rebuild.

### Out of scope

`design.language` and `code.review-ux` (M3); motion capture and game review (M5).

## M3 — Design actions

- **Depends on:** M2
- **Acceptance:** F-031, F-032, F-033, F-034, F-035

### Goal

A project gets a short, checkable visual and UX language — and a game a one-page game design — before feature code, with the look signed off from a rendered tile.

### Scope

`design.language` (DESIGN.md, W3C tokens in OKLCH, light/dark, style tile at a gate, art-bible mode); `design.ux-flows`; `design.gameplay`; `code.review-ux` (heuristics, walkthroughs, WCAG 2.2 AA; planner-requested); `meta.orchestrate` plans them.

### Out of scope

Architecture and acceptance (M4); assets and game capture (M5).

## M4 — Architecture and verification

- **Depends on:** M3
- **Acceptance:** F-036, F-037, F-038, F-039, F-040, F-041, F-042, F-043

### Goal

Architecture is decided and binding before building, the plan is checked for buildability, and a skeptical evaluator — not the builder — decides when a feature passes.

### Scope

`arch.design` (C4, stack with alternatives, ADRs, CI fitness functions); binding ADRs; `arch.spike`; `arch.review`; `project.check-readiness`; `project.accept-milestone` (the only thing that sets `passes`); `project.correct-course`; `project.retro`; `meta.orchestrate` wires them in.

### Out of scope

Game capture and review (M5); the real game (M6).

## M5 — Game support

- **Depends on:** M4
- **Acceptance:** F-044, F-045, F-046, F-047, F-048

### Goal

Outpost can see, judge and hand over a browser game: motion captured, game-specific review, deliberately sourced art and sound, a playtest opened from the phone.

### Scope

Scripted play with frame/GIF capture; game review criteria (HUD, juice, first 30 s, measured fps); playtest hold with a tailnet-served build; `read.research`; `design.source-assets`; a default game web stack documented; `meta.orchestrate` plans game projects with these.

### Out of scope

The real game (M6).

## M6 — Acceptance run

- **Depends on:** M5
- **Acceptance:** F-049, F-050, F-051, F-052, F-053, F-057, F-058, F-059

### Goal

Outpost makes a game from a short idea with only the holds, and the user judges it good. Nothing short of that finishes the project.

### Scope

A hold for the idea; a `meta.job` game job planned in the project category; on a not-good verdict, `project.retro`, fixes to the actions, and a fresh run, until the user says it is good; a close-out permissions audit.

### Out of scope

New actions not driven by a retro finding.
