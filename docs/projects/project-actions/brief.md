# Project actions — brief

## Problem

Every Outpost action assumes one ticket → one PR. Nothing takes a whole project from a
one-paragraph idea to a finished, good result by shaping, designing, architecting, splitting
it into ordered child jobs, building them and checking the result. The test case is "make a
video game, here's my idea". And the UI Outpost (and Claude generally) builds is functional
but looks bad — generic, inconsistent, poorly laid out — so UI quality is on the critical
path: a good game needs good visuals and feel.

## Audience

The single Outpost user (frostbyte73), working on this repo and on new browser-game repos.
They have the daemon, the PWA, `code.orchestrate-pr` / `code.orchestrate-review`, and (since
M1) bundled-action sync, this folder convention, the `design`/`arch`/`project` categories,
`write.create-repo`, `project.shape`/`requirements`/`decompose`, the `meta.orchestrate`
project category, and `meta.session` for hands-on steps.

## Appetite

No time budget: quality over speed, and M6 reruns until the game is good. Still
proportionate — no milestone cut to reach M6 sooner, and no review fan-out that doesn't
change outcomes. Each milestone is one `meta.job` child followed by a user hold. Remaining
scope, in order: (1) harden the planning chain, (2) UI quality loop, (3) design actions,
(4) architecture and verification, (5) game support, (6) acceptance run — see
[roadmap.md](roadmap.md).

## No-gos

- Native/desktop engines (Unity, Unreal, Godot). Games are browser-based.
- Replacing `code.orchestrate-pr` / `code.orchestrate-review` — extend, don't fork.
- Heavy spec process for small work: a one-ticket job keeps its short path.
- Anti-goals that fail the project even if it works: spec waterfall; rubber-stamp review
  (reviews need fresh context, cited evidence, hard thresholds); premature done (only
  `project.accept-milestone` flips `passes`, with end-to-end evidence); loosened permissions
  (anchored whitelists, writes only in `push`); generic AI-looking output.

## Rabbit holes

- **Answers can't reach a re-run.** The PWA Resume buttons (`step-card.js`,
  `cockpit/bodies.js`, `tracked/focus-rail.js`) send only `{gate, stepId}`, though the engine
  accepts a note. Fix this first; until then, keep clarifications rare.
- **Planning-chain quality.** A weak early action degrades every later plan. De-risk with a
  content sign-off `meta.wait` before the shaping chain's folder lands; cap shape's
  clarifications at ~3–5 scope/appetite questions, the rest recorded as assumptions; give
  `project.requirements` and `project.decompose` a `clarifications[]` handled like shape's;
  a checkable quality category (look, feel, not-generic) in `features.json`; and a check
  `meta.session` on the last milestone.
- **Screenshots vs. permissions.** Playwright was removed from `edit`. De-risk with a new
  narrow anchored grant designed in `docs/design/permissions.md`, landed as its own PR.
- **Visual review that never ends, or rubber-stamps.** No controller round cap: the loop
  ends when the reviewer says ship or two passes fail to beat the best score, keeping the
  best round. A calibration hold anchors the rubric; taste disputes go to the user side by
  side.
- **Seeing it at a gate.** Step artifacts are markdown, so the PWA must show screenshots.
- **Game art and sound.** De-risk with `design.source-assets` on a general `read.research`
  action; its proposal is approved at a hold, and any host or key lands as an anchored-grant
  PR plus a `~/.outpost/.env` entry.

## Success criteria

- The user tells Outpost to make a game from a short idea; it runs end to end with only the
  holds, and the user judges the game good. Nothing short of that counts.
- On the way: one Outpost screen the user names, rebuilt through the UI loop, is judged
  better by the user; every new grant lands as an approved PR; `npx tsc --noEmit` passes.

Assumptions (left to the builder, not open questions): action names, schemas and SKILL
text; how screenshots are stored and shown; the game web stack (chosen in `arch.design`,
with a default documented in M5); rubric wording and thresholds, as long as they need
evidence and can fail; splitting or merging milestones; builds served over the tailnet for
playtests.
