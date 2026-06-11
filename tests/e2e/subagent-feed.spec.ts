import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, DEFAULT_FIXTURE } from './harness/browser.js';

const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const SUBAGENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_CWD = '/tmp/outpost-e2e-subagent';

// Parent session JSONL: contains the Agent tool_use, then a <task-notification> that
// reports the subagent's completion. SessionStore parses these to populate `.completion`.
const PARENT_JSONL = [
  JSON.stringify({
    type: 'user',
    timestamp: '2026-06-10T10:00:00Z',
    message: { role: 'user', content: 'grep for foo with an agent' },
    cwd: TEST_CWD,
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-10T10:00:01Z',
    message: {
      id: 'msg_par_1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_par_1', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Grep for foo', prompt: 'Find foo' } }],
      model: 'claude-opus-4-7',
      usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }),
  // <task-notification> for the async-completion path: synthetic user-role string content.
  JSON.stringify({
    type: 'user',
    timestamp: '2026-06-10T10:00:10Z',
    message: { role: 'user', content: `<task-notification><task-id>${SUBAGENT_ID}</task-id><status>completed</status><summary>Found foo</summary><result>matches in 2 files</result></task-notification>` },
  }),
].join('\n') + '\n';

// Subagent's own JSONL — a Grep tool_use, mirroring what subagent-driven runs write.
const SUBAGENT_JSONL = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-06-10T10:00:05Z',
  message: {
    id: 'msg_sub_1',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Grep', input: { pattern: 'foo' } }],
    model: 'claude-opus-4-7',
    usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}) + '\n';

const SUBAGENT_META = JSON.stringify({
  agentType: 'general-purpose',
  description: 'Grep for foo',
  toolUseId: 'toolu_par_1',
});

test.use({
  daemonOpts: {
    fixturePath: DEFAULT_FIXTURE,
    initialProjects: [{ cwd: TEST_CWD, sessions: [{ id: SESSION_ID, jsonl: PARENT_JSONL }] }],
  },
});

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('subagent sidecar surfaces via /api/sessions/:id/subagents with completion', async ({ daemon, outpostPage }) => {
  // Sidecar files have to live in the project dir under <sessionId>/subagents/.
  // The harness's projectsRoot is daemon.projectsRoot; the project dir is the sanitized cwd.
  const sanitizedCwd = TEST_CWD.replace(/\//g, '-');
  const subagentDir = join(daemon.projectsRoot, sanitizedCwd, SESSION_ID, 'subagents');
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(join(subagentDir, `agent-${SUBAGENT_ID}.meta.json`), SUBAGENT_META);
  writeFileSync(join(subagentDir, `agent-${SUBAGENT_ID}.jsonl`), SUBAGENT_JSONL);

  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions/${SESSION_ID}/subagents`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.subagents).toHaveLength(1);
  const sub = body.subagents[0];
  expect(sub.agentId).toBe(SUBAGENT_ID);
  expect(sub.agentType).toBe('general-purpose');
  expect(sub.description).toBe('Grep for foo');
  expect(sub.entries.length).toBeGreaterThan(0);
  // Completion stamped from <task-notification> in the parent JSONL.
  expect(sub.completion).not.toBeNull();
  expect(sub.completion.status).toBe('completed');
  expect(sub.completion.summary).toBe('Found foo');
});
