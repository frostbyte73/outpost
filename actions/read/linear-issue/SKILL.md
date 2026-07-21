---
name: read.linear-issue
description: Fetch a Linear issue by ID or URL with its full body, state, team, and comments. Read-only. Use as the first step of any playbook that triages or responds to a Linear ticket.
outpost:
  kind: action
  category: read
  side_effects: none
  runner: claude
  permissions: [pull]
  timeout_sec: 120
  retries: 1
---

# read.linear-issue

You are running as one atomic step of an Outpost job. Read the input envelope, fetch the requested Linear issue, return its structured shape, exit.

## Step 1 — read your envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

The envelope's `inputs` field matches this action's `input.schema.json`:

| Field | Required | Meaning |
|---|---|---|
| `ticket_ref` | yes | Linear issue ID (`CSCU-432`) or full URL. |
| `include_comments` | no, default true | If false, omit the `comments` array. |

## Step 2 — fetch the issue

Use the Linear MCP tool `mcp__claude_ai_Linear__get_issue` with the resolved ID. If `include_comments` is true, also call `mcp__claude_ai_Linear__list_comments` for the issue and inline them into the result.

Normalize the result into the shape declared in this action's `output.schema.json`. Pay attention to:
- `state` is the state's `name`, not its id.
- `team` is the team's `key` (e.g. `CSCU`), not the team's id.
- `comments[].author` is the user's email if available, otherwise `displayName`.

## Step 3 — Submit your output

The `output` field is a single string. JSON-stringify the normalized issue object and pass it as `output`.

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
```

If the tool doesn't come back, halt — the daemon will mark the step failed when your turn ends. Do NOT try to submit the output as your final text message; the daemon does not scrape transcripts.

Then call the `mcp__outpost__submit_step_output` tool:

```
mcp__outpost__submit_step_output({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  output: "<JSON-encoded string of the normalized issue object>"
})
```

The daemon stores `output` verbatim and downstream steps see the same string. No shell, no jq — the tool call accepts native JSON.

Stop. Do not perform any further work. Do not write any comment back to Linear — that's the job of a downstream `write.linear-comment` step.
