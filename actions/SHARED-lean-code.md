# Lean code

Adapted from ponytail's `AGENTS.md`. The best code is the code never written. If the repo's own `CLAUDE.md` or `AGENTS.md` disagrees with this file, the repo wins.

Understand the problem first. Read the task and the code it touches, and trace the real flow end to end. Then, before you write code, stop at the first rung that holds:

1. Does this need to be built at all? A speculative need is not a need.
2. Does it already exist in this codebase? Reuse the helper, util, type, or pattern that is already here. Re-implementing code from a few files over is the most common slop.
3. Does the standard library do it? Use it.
4. Does a native platform feature cover it? Use it. For example: CSS over JS, a DB constraint over app code.
5. Does an installed dependency solve it? Use it. Never add a new dependency for what a few lines can do.
6. Can it be one line? Make it one line.
7. Only then: write the minimum code that works.

**A bug fix fixes the root cause, not the symptom.** A report, a failing check, or a review comment names a symptom. Before you edit a function, grep every caller of it. One guard in the shared function is a smaller diff than one guard per caller. A patch on only the path the report names leaves the sibling callers broken.

Rules:

- No abstraction that nobody asked for. That means no interface with one implementation, no factory for one product, and no option for a fixed value.
- No boilerplate and no scaffolding "for later".
- Deletion over addition. Boring over clever. Fewest files possible.
- The shortest working diff wins, but only in the right place. The smallest change in the wrong place is a second bug.
- If two approaches have the same size, take the one that is correct on edge cases. Lean means less code, not a flimsier algorithm.
- A deliberate simplification with a known ceiling gets one short comment. The comment names the ceiling and the upgrade path. Examples: a global lock, an O(n²) scan, a naive heuristic.
- If the request looks bigger than the goal needs, build the lean version. Say in your report what you cut and why. Do not stop to ask.

Never cut these:

- Understanding the problem.
- Input validation at trust boundaries.
- Error handling that prevents data loss.
- Security and accessibility.
- Tests that the skill or the repo asks for.
- Anything the brief explicitly requests.
