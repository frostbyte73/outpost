# Replan requests

A step can ask for a replan when it finds the *plan* wrong: the job is sent back to the planner straight away, with the step's reasoning in its envelope. Doing that instead of failing matters for two reasons. Failing halts the job and blames your action for a decision the planner made. Finishing anyway hands the next step output the plan was never going to be able to use.

## When to ask

Only when this step cannot get past the problem without the plan changing:

- **A false premise.** The plan assumes something that isn't so: the bug is in another service, the file it names was deleted, the flag it wants to flip doesn't exist.
- **A missing prerequisite.** Something has to happen first that no step does: a dependency bump, a migration, a decision only the user can make.
- **Inputs that can't be right.** The step was handed a branch, a PR, a ticket or a value that contradicts its own goal.

Never because the work is hard, slow, flaky, or failing for this step's own reasons. That is `submit_step_failed`, or another try. A replan request says the planner was wrong, so make sure it was.

## What to send

- `reason` — why the plan as written cannot succeed from here, in a sentence or two the user can read at plan approval.
- `evidence` — citations: `file:line`, a command and its output, a URL. Make it something the planner can check without redoing your work.
- `suggestion` — the plan change you think it needs: insert a step before this one, drop this one, change its inputs to X.

## Who asks, and how

- **An action step or a `meta.session`** calls `mcp__outpost__submit_replan_request({jobId, stepId, reason, evidence?, suggestion?})`, then stops.
- **A controller** ends its turn with `submit_step_progress` and `next: {kind: "replan", reason, evidence?, suggestion?}`. That is its one move for the turn. The move is refused while any of its dispatches are still in flight, so `wait` for them first. An open PR doesn't block it; the planner sees the PR and decides.
- **A dispatched child** cannot ask. Whether its controller's step needs a replan is the controller's call, so put the finding in your output and let the controller decide.

## What happens next

Your session is closed, along with any pending write draft. The planner runs at once and proposes an amendment, and the user approves it like any plan. The planner either drops this step or keeps it. A kept step re-runs from scratch with your request in `previousAttempts`.

A second request from the same step after an amendment fails the step ("asked for a replan twice"), and the job halts for the user. At that point the step and the planner disagree, and settling it is up to the user.
