// A scripted ACP agent; FAKE_ACP_SCRIPT picks gated (ask, edit, repeat the final update), partial (ask for two files) or ungated.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const update = (u) => send({ method: 'session/update', params: { sessionId: 'fake-1', update: u } });
const waiting = new Map();
let nextId = 1000;

function ask(params) {
  const id = nextId++;
  send({ id, method: 'session/request_permission', params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function prompt(id) {
  if (process.env.FAKE_ACP_SCRIPT === 'gated') {
    const toolCall = { toolCallId: 'edit-1', title: 'Edit a.txt', kind: 'edit', status: 'pending', locations: [{ path: 'a.txt' }] };
    update({ sessionUpdate: 'tool_call', ...toolCall });
    const reply = await ask({
      sessionId: 'fake-1', toolCall,
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    });
    process.stderr.write(`permission:${JSON.stringify(reply)}\n`);
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed', content: [] });
  } else if (process.env.FAKE_ACP_SCRIPT === 'partial') {
    const toolCall = { toolCallId: 'edit-2', title: 'Edit two', kind: 'edit', status: 'pending', locations: [{ path: 'a.txt' }, { path: 'b.txt' }] };
    update({ sessionUpdate: 'tool_call', ...toolCall });
    const reply = await ask({
      sessionId: 'fake-1', toolCall,
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    });
    process.stderr.write(`permission:${JSON.stringify(reply)}\n`);
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-2', status: 'failed' });
  } else {
    update({ sessionUpdate: 'tool_call', toolCallId: 'sh-1', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } });
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
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'fake-1' } });
  } else if (msg.method === 'session/prompt') {
    void prompt(msg.id);
  }
});
