import { describe, it, expect } from 'vitest';
import { StreamJsonMapper } from '../../src/runtime/claude/events.js';

const assistant = (content: object[], stopReason: string | null, extra: object = {}) => ({
  type: 'assistant',
  message: { id: 'msg_1', model: 'claude-x', content, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } },
  ...extra,
});

describe('StreamJsonMapper', () => {
  it('maps a turn of Claude stream-json to canonical events', () => {
    const m = new StreamJsonMapper();
    const frames = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', mcp_servers: [{ name: 'linear', status: 'pending' }] },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { output_tokens: 1 } } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"' } } },
      assistant([{ type: 'text', text: 'running it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'tool_use'),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } },
      { type: 'result', modelUsage: { 'claude-x[1m]': { contextWindow: 1_000_000 } } },
      { type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'done' },
    ];
    expect(frames.flatMap((f) => m.map(f))).toEqual([
      { type: 'session.started', sessionId: 's1', model: 'claude-x', mcpServers: [{ name: 'linear', status: 'pending' }] },
      { type: 'turn.started' },
      { type: 'usage.updated', usage: { streamingOutputTokens: 1 } },
      { type: 'content.delta', stream: 'assistant_text', text: 'hi' },
      { type: 'content.delta', stream: 'reasoning', text: 'hmm' },
      { type: 'content.delta', stream: 'tool_input', text: '{"' },
      { type: 'item.completed', item: { type: 'assistant_message', id: 'a0', messageId: 'msg_1', text: 'running it' } },
      {
        type: 'item.started',
        item: {
          type: 'tool_call', id: 't1', messageId: 'msg_1', kind: 'command_execution', tool: 'shell', rawName: 'Bash',
          input: { command: 'ls' }, status: 'inProgress',
        },
      },
      {
        type: 'usage.updated',
        usage: { model: 'claude-x', response: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } },
      },
      {
        type: 'item.completed',
        item: {
          type: 'tool_call', id: 't1', messageId: 'msg_1', kind: 'command_execution', tool: 'shell', rawName: 'Bash',
          input: { command: 'ls' }, status: 'completed', resultText: 'a.txt',
        },
      },
      { type: 'usage.updated', usage: { streamingOutputTokens: 9 } },
      { type: 'turn.completed', state: 'completed', stopReason: 'end_turn' },
      { type: 'usage.updated', usage: { contextWindows: { 'claude-x[1m]': 1_000_000 } } },
      { type: 'task.notification', taskId: 'a1', status: 'completed', summary: 'done' },
    ]);
  });

  it('ends the turn on a terminal stop carried by the assistant message itself', () => {
    const events = new StreamJsonMapper().map(assistant([{ type: 'text', text: 'done' }], 'end_turn'));
    expect(events.at(-1)).toEqual({ type: 'turn.completed', state: 'completed', stopReason: 'end_turn' });
  });

  it('emits nothing for a thinking-only delivery', () => {
    expect(new StreamJsonMapper().map(assistant([{ type: 'thinking', thinking: '…' }], null))).toEqual([]);
  });

  it('marks a failed tool result failed', () => {
    const m = new StreamJsonMapper();
    m.map(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 'tool_use'));
    const [done] = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit 1' }] } });
    expect(done).toMatchObject({ type: 'item.completed', item: { status: 'failed', resultText: 'exit 1' } });
  });

  it('tags every event from a subagent frame so the parent transcript can drop it', () => {
    const events = new StreamJsonMapper().map(assistant(
      [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }], 'tool_use', { parent_tool_use_id: 'toolu_parent' },
    ));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.subagent).toEqual({ parentToolCallId: 'toolu_parent' });
  });
});
