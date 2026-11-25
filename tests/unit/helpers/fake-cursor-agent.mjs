// A scripted `agent acp` that runs Outpost's real hook command the way Cursor does; FAKE_CURSOR_SCRIPT picks the scenario.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const update = (u) => send({ method: 'session/update', params: { sessionId: 'fake-1', update: u } });
const waiting = new Map();
let nextId = 1000;
const OPTIONS = [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }];

function ask(toolCall) {
  const id = nextId++;
  send({ id, method: 'session/request_permission', params: { sessionId: 'fake-1', toolCall, options: OPTIONS } });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function hook(payload) {
  const r = spawnSync('sh', ['-c', process.env.FAKE_CURSOR_HOOK_COMMAND], { input: JSON.stringify(payload), encoding: 'utf8' });
  const allowed = r.status === 0 && JSON.parse(r.stdout).permission === 'allow';
  process.stderr.write(`hook:${payload.tool_name}:${allowed ? 'allow' : 'deny'}\n`);
  return allowed;
}

async function prompt(id) {
  const script = process.env.FAKE_CURSOR_SCRIPT;
  if (script === 'shell' || script === 'request-without-hook') {
    const call = { toolCallId: 'toolu_sh', title: '`echo hi`', kind: 'execute', status: 'in_progress' };
    update({ sessionUpdate: 'tool_call', ...call });
    const allowed = script === 'shell'
      ? hook({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'echo hi', cwd: process.cwd() }, tool_use_id: 'uuid-sh' })
      : true;
    if (allowed) process.stderr.write(`permission:${JSON.stringify(await ask({ ...call, rawInput: null }))}\n`);
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_sh', status: 'completed' });
  } else if (script === 'shell-denied-then-allowed') {
    for (const n of [1, 2]) {
      const call = { toolCallId: `toolu_sh${n}`, title: '`echo hi`', kind: 'execute', status: 'in_progress' };
      update({ sessionUpdate: 'tool_call', ...call });
      const payload = { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'echo hi', cwd: process.cwd() }, tool_use_id: `uuid-sh${n}` };
      if (hook(payload)) process.stderr.write(`permission:${JSON.stringify(await ask({ ...call, rawInput: null }))}\n`);
      update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'completed' });
    }
  } else if (script === 'edit') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_ed', title: 'Edit `a.txt`', kind: 'edit', status: 'in_progress' });
    const base = { hook_event_name: 'preToolUse', tool_use_id: 'toolu_ed' };
    if (hook({ ...base, tool_name: 'Read', tool_input: { file_path: 'a.txt' } })) {
      hook({ ...base, tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'hi' } });
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_ed', status: 'completed' });
  } else {
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_rd', title: 'Read a.txt', kind: 'read', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_rd', status: 'completed' });
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
  send({ id, result: { stopReason: 'end_turn' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result);
    waiting.delete(msg.id);
  } else if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [{ id: 'cursor_login' }] } });
  } else if (msg.method === 'authenticate') {
    send({ id: msg.id, result: {} });
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'fake-1' } });
  } else if (msg.method === 'session/prompt') {
    void prompt(msg.id);
  }
});
