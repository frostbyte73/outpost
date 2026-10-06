# Code style

What a reviewer flags first on a PR Outpost opens is almost never the logic. It is the comments and the tests: a doc block restating a three-line helper, a test file pinning what the standard library already guarantees. Both make the PR read as machine-written before anyone gets to the change. This file is the bar for both, plus the code-organization rules that go wrong next. `SHARED-lean-code.md` covers *what* to build; this covers how the diff reads.

Precedence: the repo's `CLAUDE.md` / `AGENTS.md` wins, then this file, then the tone of the file you are editing. Where the surrounding file is terser than this file asks, match the file.

## Comments

**The default is none.** Well-named identifiers, small functions and idiomatic code explain themselves. The bar for a comment is: *a reader of this file, in a year, would be confused without it — and you can name the specific confusion in one sentence.*

Two kinds of code earn a one-line comment without a further reason:

- An **exported** function, type or method — one line saying what it does, in the language's doc convention (Go: starts with the symbol name).
- A **larger internal helper** — beyond ~20 lines, or whose job isn't obvious from its name.

Beyond that, a comment is warranted only for: a non-obvious *why* (an invariant, a hidden constraint, a workaround); behavior that would surprise a first-time reader; a genuinely useful external reference (a spec section, an upstream issue); a required tooling annotation (`//go:build`, `# noqa`, `eslint-disable`).

Never write:

- A comment that restates the line below it. `// increment counter` above `counter++`.
- A doc line on a tiny internal helper that restates its name. `// stop stops the pacer`.
- Mechanism narration — walking through what the body does. The body does that.
- Field-name restatement. `// timeout is the timeout`.
- Cross-references that rot: `// used by X`, `// called from Y`, `// see PR #123`.
- Task or history narration: `// fix for ENG-1234`, `// after refactor`, `// added for the new flow`.
- Epitaphs for removed code: `// removed X because Y`, `// previously did Z`.
- Anything that reads as an assistant talking: "this function does", "as requested", "the following block".

**A comment is one line.** Inside a function body, one line per comment — a step that needs a paragraph should be a function whose name carries the why. On internal code, one line, full stop. Only a public API (a published package, a cross-repo library, a wire format) may take a second line, and only for *contract*: units, error semantics, ownership, what "empty" means — never a rephrasing of the first line.

**Write, then cut.** After writing any comment, delete it in your head and ask what specific confusion that leaves. If you can't name one, delete it for real. Ask per line, not per comment: in a three-line comment, line one is usually the only one that survives.

## Tests

A test earns its place by pinning logic **you wrote** that could plausibly break. Write those, and only those.

Don't write tests that:

- Exercise the language, standard library, framework or a dependency — that a map stores a key, that JSON round-trips, that a constructor returns what it was given.
- Assert a getter returns its field, a constant equals itself, or a mock returns what it was told to.
- Restate the implementation line by line, so any refactor breaks them and no bug ever does.
- Enumerate permutations of the same path. One case per distinct behavior; a table only when the rows exercise different branches.

Do write tests for: a branch with real decision logic, a parser or state machine, an edge case the code handles deliberately, and the exact input behind the bug you are fixing (a regression test that fails without your fix).

Put tests where the repo already puts them and match the existing test style — helpers, naming, assertion library. Don't introduce a new test framework or fixture pattern for one file. A change with no logic worth pinning ships with no new test, and that is the right outcome — say so in your report rather than writing one to fill the slot.

## Code

- **Build what's asked.** A bug fix doesn't rename, reformat or "clean up while here". Mention what else you saw; don't do it.
- **No defensive checks against impossible states.** Don't re-validate what the caller one frame up just produced, wrap calls that can't fail, or add fallbacks for branches that can't be taken. Validate at system boundaries only — user input, network, files, RPC entry points.
- **Don't carry the past.** When you replace code, delete the old code. No `_unused` renames, no compat shims or deprecated wrappers inside a repo whose callers you can just change. Compatibility is for published APIs and wire formats.
- **Honest names.** `applyQuotaToRequest`, not `processData`. Avoid bare `Manager` / `Helper` / `Util` suffixes. Booleans read as predicates: `isExpired`, `hasQuota`.
- **Errors carry context the caller lacks.** `loading config <path>: <err>`, not `error: <err>`. Wrap once; don't swallow silently.
- **Ordering for locality.** Constants and types at the top, a constructor right after its type, a single-use helper directly below its only caller, shared helpers at the bottom.
- **No section banners** (`// ===== HELPERS =====`). A file that needs them should be split.
