# Project actions — brief

Full design: [project-actions-design.md](../../superpowers/specs/2026-11-27-project-actions-design.md).

## Intent

- Take a whole project from a one-paragraph idea to a finished, good result.
- Test case: "make a video game, here's my idea".
- UI quality is on the critical path: a good game needs good visuals and feel.
- Done = the user judges the delivered game good.

## Goals

1. Project-folder convention: `docs/projects/<slug>/`.
2. A `meta.orchestrate` project category.
3. Project, design, architecture and verification actions.
4. A UI quality loop driven by screenshots.
5. Game support.
6. An acceptance run.

## Non-goals

- Native engines (Unity, Unreal, Godot). Games are browser-based.
- Replacing `code.orchestrate-pr` / `code.orchestrate-review`. Extend them, don't fork.
- Heavy spec process for small work.

## Anti-goals

- Spec waterfall.
- Rubber-stamp review.
- Premature done: only the acceptance evaluator flips `passes`.
- Loosened permissions.
- Generic AI-looking output.

## Constraints

- Every action exists in both `actions/` and `~/.outpost/actions/`.
- An action reached only from a controller round, a UI button or a schedule sets `outpost.plannable: false`; controllers list their sub-actions in `outpost.roster`.
- `code.review-diff` is the only lens a controller runs unprompted, so visual review is requested per step via `inputs.lenses`.
- Action categories are hard-coded (`src/actions/types.ts`, `src/actions/registry.ts`), so new categories need a code change.
- Screenshots need a new narrow, anchored grant: playwright was removed from `edit` in `config/permission-groups.default.json`.
- Step artifacts are markdown (`src/work/work-types.ts`).
- `write.create-repo` goes through write drafts.
- Run `npx tsc --noEmit`; `npm test` doesn't typecheck.
- No controller round cap.

## Milestones

M1 bootstrap the planning chain · M2 UI quality loop · M3 design actions · M4 architecture and verification · M5 game support · M6 acceptance run. See [roadmap.md](roadmap.md).
