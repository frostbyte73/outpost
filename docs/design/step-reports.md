# Step reports: meta.session reports back, any step can ask for a replan

`meta.wait` parked a job doing nothing, and the only thing it could hand the planner was a resume note that skipped review (`resolveWaitStep` stamps `reviewed: true`, so `owesStepReview` never runs). M7's planning chain needed more than that: answers typed at a hold have to reach the re-run, a sign-off has to be able to send the chain back, and a step that finds the plan itself is wrong has had no way to say so short of failing. Four decisions close those gaps.

## D1. meta.wait is removed

Every use it had gets a replacement, and none of them is another way to park:

| meta.wait use | Replacement |
|---|---|
| Promote a deploy ring after a health verdict | A `meta.session` "Promote <ring>?" that starts with the verdict and the dashboard links. Done promotes; a report that says "don't promote" asks for a replan (D2). Abandoning the job still halts it. |
| Content sign-off before the project folder lands | A `meta.session` "Sign off docs/projects/<slug>/" whose prompt lists `brief.md`, `features.json` and `roadmap.md` from the project.* step outputs. An approval reports approval; changes report `corrections`, and the step-review re-runs the affected project.* steps with them, then plans another sign-off. |
| Answer project.shape/requirements/decompose clarifications | A `meta.session` "Answer clarifications" whose prompt lists the questions verbatim, then a second run of the same action. The answers come back in the report's `answers` field, and the re-run reads them from `previousSteps` (the meta.session output's top-level `answers`), not from a resume note. |
| A leading hold before customer-incident writes | Dropped. Every `write.*` draft already gates on the user. |
| A timed soak before a health check | A plan-level step field, `delaySec`, on the step that has to wait — usually the `read.investigate` that checks health. The engine stamps `startAt` = (previous group settled) + `delaySec` and won't start the step before it. `waitTimers` / `scheduleWaitWake` / `reconcileWaits` carry over under new names. The PWA shows "Starts in 42m · Start now". |

The rule for the planner: if the user has to *do or decide* something, plan a `meta.session`; if the job only has to let time pass, set `delaySec` on the next step. Nothing parks a job doing nothing.

`delaySec` is the user's hold, written into the plan they approved — not a controller timer. `WaitSpec.resumeAt` stays refused by `validateNext` ([controller-loop.md](controller-loop.md)), so a controller still can't set a delay of its own, even though the renamed timer code also re-arms the legacy controller waits that already hold one on disk.

## D2. meta.session reports back

**`submit_session_report` is its own tool, not `submit_step_output`.** A meta.session runs as the user's `manualSession`, with no action allowlist, and what it hands back is the user's verdict written up by Claude rather than an action's output. It also always triggers a review, which a plain output doesn't. Shape:

```
{ jobId, stepId,
  summary,        // one line
  report,         // markdown: what was checked, what was found, what the user decided
  answers?,       // clarification sessions
  corrections?,   // sign-off sessions
  wantsReplan? }  // boolean
```

Submitting it resolves the step with output `{resumed_by: "report", summary, report, answers?, corrections?, wantsReplan?}`. The session stays open as history. Claude submits only when the user says they're done or asks it to report back — never on its own judgment that the task looks finished.

**Done in the PWA still works, and takes an optional note.** It resolves the step with `{resumed_by: "user", note?}`. That replaces the planned "Resume with a note" change: once meta.wait is gone, Done is the only button of its kind. The note field goes beside Done on `work/step-card.js`, `cockpit/bodies.js` and `tracked/focus-rail.js`. Mobile mounts the same step-card and focus-rail exports, so those two get the field without a change of their own. The cockpit is the exception: mobile mounts `cockpit/inbox.js`, whose rows open the job, and the step card there carries the field.

**A settled meta.session always gets a step-review.** `resolveWaitStep`'s `reviewed: true` shortcut goes away for meta.session, whether it settles by report or by Done. The shortcut existed so a hold wouldn't spawn an orchestrator between itself and the step it gated — right for a hold with nothing to say, wrong for a session whose whole point is what the user said. A review that finds nothing to change is one cheap `submit_continue`. When `wantsReplan` is true, or the report or note carries corrections or answers, the planner must re-plan. The step-review envelope already carries the step's `output`, so reports need no new envelope field.

**Auth.** `checkWorkLaunch` resolves `step.manualSession.id` for a meta.session step, for `submit_session_report` and `submit_replan_request` only — every other tool still refuses a manual session, which has no allowlist to be bound by. Every session already carries a `launchCredential`, so nothing new is minted. `waitSessionContext` tells the session its `jobId`/`stepId` and both tools, and drops the line "there is nothing to submit".

## D3. Any step can ask for a replan

A step that finds the *plan* wrong — a false premise, a missing prerequisite step, inputs that can't be right — had two exits, and both were wrong. `submit_step_failed` halts the job and blames the action for a decision the planner made; finishing anyway produces output the plan was never going to be able to use.

**`submit_replan_request({jobId, stepId, reason, evidence?, suggestion?})`** is open to action-step sessions and meta.session sessions. `reason` is why the plan as written can't succeed from here, `evidence` is citations (file:line, an output, a URL), and `suggestion` is the plan change the step thinks it needs. **Dispatched children are refused**: whether a controller's own step needs a replan is the controller's call. The refusal keys on the session `checkWorkLaunch` resolves belonging to a dispatch, not on a `dispatchId` argument, because a child that passes its dispatch id as `stepId` resolves to the same session.

**A controller gets a move, not the tool:** `{kind: "replan", reason, evidence?, suggestion?}` through `submit_step_progress`, which keeps the one-`NextMove`-per-turn rule intact. It arms no timer, so the no-self-armed-timer invariant holds. `validateNext` refuses it while dispatches are in flight, since it would strand them — the controller waits for them first. An open PR doesn't block it: the planner sees `pr` in `currentSteps` and decides whether to keep the step.

**State.** A new step state, `replan_requested`, on action and orchestrated steps alike, with `replanRequest: {reason, evidence?, suggestion?, at}` on the step and in `planStepView`. It is not a failure, not resolved and not cancelled. The live session, any pending write draft and any queued dispatches are closed, as on `fail`.

**Routing is immediate.** The engine spawns `meta.orchestrate` in `replan` mode straight away, with `replanRequest: {stepId, action, reason, evidence, suggestion}` in the envelope. It does not wait for the step's parallel group to settle the way `owesStepReview` does — the request is about the plan, and every sibling still running is running on that plan. The job goes to `planning`, and the amended plan goes through the user's plan approval as usual, so a replan never changes the plan silently. The planner must give the requesting step a disposition: drop it, or keep it with a patch. A patched keep resets it the way `onStepRetry` (`engine.ts`) does — back to its initial state, with an attempt recorded that carries the request's reason, so the re-run sees it in `previousAttempts`.

**Journal.** The request journals against `meta.orchestrate` — the action whose plan was wrong — not against the requesting action. The run ledger records the round with outcome `replan-requested`.

**Two strikes.** A second replan request from the same step after a plan amendment becomes a failure ("asked for a replan twice") and halts the job like any failure. One amendment is the planner learning something; a second request means the step and the planner disagree, and that is the user's to settle.

How it differs from the other ways a step stops:

| | Means | What happens |
|---|---|---|
| `submit_step_failed` | the step couldn't do its own job | job halts, journals against the action, no planner runs |
| declined write draft | the user vetoed a write | step-review re-plans after the group settles |
| `replan_requested` | the step judged the *plan* wrong | the planner runs at once with the step's reasoning; the user approves the amendment |

`actions/SHARED-replan-requests.md` says when to use it: only when the step can't get past the problem without the plan changing, never because the work is hard. `code.orchestrate-pr`, `code.orchestrate-review`, the meta.session context and the project.* actions point to it.

## D4. Migration

**Jobs on disk.** None has a live meta.wait — in `~/.outpost/jobs` the six in the project-actions parent job are cancelled and two are resolved. The renamed `reconcileWaits` pass still runs at startup — it keeps re-arming `delaySec` timers and the legacy controller waits that hold a `resumeAt` — and gains a sweep that cancels any non-terminal, non-cancelled `meta.wait` step and logs an event saying the action was removed; without it, `decide()` would find no registry entry and spawn a session for an unknown action. Resolved and cancelled meta.wait steps keep rendering as plain history.

**`~/.outpost/actions/meta/wait`.** `ensureActionsInstalled` never deletes, so `src/actions/install.ts` gets a `RETIRED_ACTIONS` list. An unedited installed copy (its hash matches the `action-bundles.json` baseline that `src/actions/bundle-sync.ts` already keeps, so the list reuses it rather than hashing again) is deleted; an edited one is moved to `~/.outpost/actions/.retired/meta/wait/` and logged, so the user's edits survive. Either way it leaves the catalog.

**Routes.** `POST /approve {gate: "wait"}` becomes `{gate: "session", stepId, note?}`, and `wait` is dropped outright — the PWA ships with the daemon, so there is no old client to keep answering. `…/wait-session` narrows to meta.session.

**PWA.** The meta.wait hold block, soak timer and Resume buttons go from `work/step-card.js`, `work/wait-session.js`, `cockpit/bodies.js`, `tracked/focus-rail.js`, `tracked/session-mounts.js`, `work/wheel-toggle.js`, `state/work.js`, `net/work.js`, `vm/tracked.js`, `vm/cockpit.js`, `vm/cockpit-board.js` and `vm/work-predicates.js`. Two new renders, desktop and mobile: "Asked for a replan: <reason>", and a delayed step's "Starts in … · Start now".

**Tests.** `engine-wait.test.ts` is deleted and its timer cases fold into a new `engine-step-delay.test.ts`; `engine-wait-session.test.ts` becomes meta.session-only. Updated: `wait-session-context`, `action-catalog-scope` (its counts), `action-registry`, `pwa-vm-{tracked,cockpit,cockpit-board,work-predicates}`, `orchestrated-{handler,policy,runner,wake,inbox}` and `pr-watcher-branch-head`. New: `session-report`, `replan-request` (action, controller move, meta.session, dispatch refusal, two strikes, routing envelope), `actions-retire` and `meta-wait-sweep`.

**Docs.** CLAUDE.md's step paragraph, [orchestrator.md](orchestrator.md)'s Project jobs paragraph, [controller-loop.md](controller-loop.md) (a `replan` row in the move table, and its last sentence about meta.wait's soak) and [gotchas.md](gotchas.md) if a gotcha falls out.

**Order.** Six PRs, one at a time — the four code PRs all touch `src/work/engine.ts`:

1. This doc and the acceptance rewrite.
2. The session report and Done with a note (F-011–013, F-060).
3. Replan requests (F-061, F-062).
4. meta.wait removed; a soak becomes `delaySec` (F-063).
5. project.* clarifications and the project category's sessions (F-014–020).
6. The progress.md M7 entry.

The report has to exist before meta.wait goes, or the sign-off and clarification holds have nothing to become.
