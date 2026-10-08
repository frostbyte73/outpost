---
name: meta.improve-actions
description: Use when invoked as `/meta.improve-actions`, or whenever `$OUTPOST_ENVELOPE` is set with `kind=schedule` and `skill=meta.improve-actions`. Outpost's scheduled improvement loop activates this on its own once one action has accumulated enough run evidence to be worth reviewing. Reads the evidence pack the daemon assembled for exactly one action — the user's edits to its drafts, their send-back notes, failed runs, blocked calls, previously rejected proposals — and either proposes a SKILL.md revision grounded in cited runs, or records that nothing was worth changing. Delivers both outcomes via `mcp__outpost__submit_action_proposal`. Never edits files; the daemon applies an approved proposal.
outpost:
  kind: action
  category: meta
  side_effects: gated-write
  runner: claude
  plannable: false
  permissions: [read]
  timeout_sec: 900
  retries: 0
---

# Action improver

You review **one** Outpost action against evidence of how it actually performed, and propose a
change to its `SKILL.md` only when the evidence supports one. One turn: read the envelope, apply
the rubric, submit a proposal or a no-change verdict, print one line, stop. Never write files.

## Step 1 — Read your envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

| Field | Meaning |
|---|---|
| `actionName`, `whySelected` | The one action under review, and why it was picked. |
| `improve.currentSkillMd` | Its `SKILL.md` as installed. Your "before". |
| `improve.currentTokens` / `improve.tokenCeiling` | Its size, and the most it may be. `null` ceiling: no limit enforced. |
| `improve.edits[]` | Drafts the user **changed before approving**: `diff` is drafted → approved. The strongest evidence you have — it is literally what they wanted instead. |
| `improve.feedback[]` | The user's own words on drafts they sent back (`revised`) or threw out (`denied`). |
| `improve.failures[]` | Failed / gave-up runs with reasons. |
| `improve.revisions[]` | Send-backs, with `feedbackText`. |
| `improve.scorecard` | Measured rates. `null` means nothing adjudicated, not zero. |
| `improve.denials[]` | Unresolved blocked tool calls, newest first; `denialsTotal > denialsCap` means truncated. |
| `improve.rejectedProposals[]` | Proposals already declined, with the reason. |
| `improve.lessons[]` | What the action wrote about itself — weaker than the above, useful for *why*. |
| `improve.history[]` | Past applied / reverted revisions. A reverted improver edit is the strongest negative signal; a `system` revert whose rationale reads `regression:` is the daemon undoing one that measurably made things worse. |
| `improve.revisionStats[]` | Each revision scored on the runs that ran under it: `verbatimRate` (approved untouched ÷ ruled on), `failureRate`, `tokens`. Runs a reverted edit cited are already removed from the evidence above — cite something newer. |
| `improve.previousReview` | Your conclusion last cycle. |

Runs the user ruled on after the situation changed under the draft (a new commit, a new comment, a
conflict) are already removed. The pack is your only admissible evidence; you may read the action's
directory and siblings for context.

## Step 2 — The rubric

**Ground every change in a pattern.** Name it, and list **at least two** run ids exhibiting it in
`citedRunIds`. The canonical improvement is a recurring edit: the user keeps rewriting X into Y, so
the action should produce Y. One bad run is noise; no pattern means no change.

**Don't repeat a rejection.** Check `rejectedProposals` and `history` first. If you think a rejection
was wrong, say what new evidence changes it.

**Criteria over procedure.** State what a correct output looks like ("a review that finds nothing
blocking approves instead of commenting") rather than adding steps. Say it once, where it applies.
Edit surgically: touch the lines the evidence implicates and nothing else.

**Size.** `currentTokens` must not exceed `tokenCeiling` after your change, and a proposal that fixes
fewer than three cited runs must not grow the file at all — pay for additions by deleting guidance no
run exercises, duplicated rules, or caveats about states that can't occur. A **cut-only** proposal
(`cutOnly: true`, no `citedRunIds`) that only removes such text is a legitimate outcome on its own.

**Triggering.** The `description` decides whether the action runs at all. Narrow it for runs that
shouldn't have happened (abandoned runs, recurring denials); broaden it, in the third person and
leaning pushy, for runs that should have.

**Denials get a verdict, never a grant.** You cannot grant permissions. For a denial worth acting on,
cite its `id` in `evidence` with `promote` (name the group and rule — the user applies it), `never`
(say why), or `fix-action` (make the fix in `skillMdAfter`). Never send `allowlistAdds`.

**"Nothing to improve" is the expected outcome** on a healthy action. A speculative change is worse
than none.

## Step 3 — Submit

```
ToolSearch({ query: "select:mcp__outpost__submit_action_proposal", max_results: 1 })
```

If it doesn't load, halt — the daemon does not scrape transcripts.

```
mcp__outpost__submit_action_proposal({
  sessionId: "<$ACTION_EDIT_SESSION_ID>",
  actionName: "<envelope actionName>",
  summary: "<the pattern, the fix, and the token delta>",
  skillMdAfter: "<complete revised SKILL.md including frontmatter>",
  citedRunIds: ["r7f2", "r9c1"],
  evidence: ["r7f2, r9c1: user replaced an LGTM comment with an approval both times"]
})
```

Cut-only: same call with `cutOnly: true` and no `citedRunIds`. No change:

```
mcp__outpost__submit_action_proposal({
  sessionId: "<$ACTION_EDIT_SESSION_ID>",
  actionName: "<envelope actionName>",
  summary: "<what you examined and why nothing warranted a change>",
  noChange: true
})
```

Then print `Proposed revision to <action>.` or `Reviewed <action>: no change.` and stop.

## Before you exit — journal a blocker

If anything got in your way — a denied call, a missing or ambiguous envelope field — journal it,
naming the exact command or field:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
mcp__outpost__submit_journal({
  action: "meta.improve-actions", jobId: "<$JOB_ID>", stepId: "<$STEP_ID>",
  outcome: "proposed" | "no-change" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

Skip it when the run was unremarkable.
