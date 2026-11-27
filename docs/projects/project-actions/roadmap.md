# Project actions — roadmap

- Each milestone is a `meta.job` child, followed by a user hold.
- M2–M6 are provisional. After M1 they are re-planned with `project.decompose`.

## M1 — Bootstrap the planning chain

- Bundled-action sync on daemon start (first, before anything else).
- This project folder.
- Project-folder convention, in a shared doc the actions reference (`actions/SHARED-project-folder.md`).
- Categories `design`, `arch`, `project`.
- `meta.orchestrate` project category.
- `project.shape`, `project.requirements`, `project.decompose`.
- `write.create-repo`.

## M2 — UI quality loop

- Screenshot grant.
- `ui:check` deterministic checks.
- `code.implement-ui`.
- `code.review-visual`: a fixed screenshot matrix, at most 5 located fixes.
- `code.orchestrate-pr` honours a `lenses` input. No round cap: the loop ends when the reviewer says ship, or two passes fail to beat the best score.
- The PWA shows screenshots at gates.
- A calibration hold.

## M3 — Design actions

- `design.language`: `DESIGN.md`, W3C design tokens, a style tile.
- `design.ux-flows`.
- `design.gameplay`.
- `code.review-ux`: WCAG 2.2 AA.

## M4 — Architecture and verification

- `arch.design`: C4 diagrams, ADRs, fitness functions.
- `arch.spike`, `arch.review`.
- `project.check-readiness`.
- `project.accept-milestone`: the only thing that flips `passes`.
- `project.correct-course`, `project.retro`.

## M5 — Game support

- Scripted play with frame/GIF capture.
- Game review criteria.
- Playtest hold.
- `design.source-assets`, built on `read.research`.
- Builds served over the tailnet.

## M6 — Acceptance run

- A real make-a-game job.
- Retro and rerun until the user says it's good.
