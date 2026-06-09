import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session-store.js';

describe('SessionStore', () => {
  let storeDir: string;

  beforeAll(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'sstest-'));
    writeFileSync(
      join(storeDir, 'sess-aaaaaaaa.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'Investigating INC-540' }) + '\n' +
      JSON.stringify({ type: 'user', message: { content: 'what is up with INC-540' } }) + '\n',
    );
    writeFileSync(
      join(storeDir, 'sess-bbbbbbbb.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
    );
  });

  it('lists sessions with id + mtime', () => {
    const store = new SessionStore({ dir: storeDir });
    const sessions = store.list();
    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-aaaaaaaa', 'sess-bbbbbbbb']);
  });

  it('reads the title from summary records when present', () => {
    const store = new SessionStore({ dir: storeDir });
    const sessions = store.list();
    const a = sessions.find((s) => s.id === 'sess-aaaaaaaa')!;
    expect(a.title).toBe('Investigating INC-540');
  });

  it('falls back to first-user-message preview when no summary record exists', () => {
    const store = new SessionStore({ dir: storeDir });
    const sessions = store.list();
    const b = sessions.find((s) => s.id === 'sess-bbbbbbbb')!;
    // Titles get cleaned: first-letter capitalization is applied.
    expect(b.title).toContain('Hello');
  });

  it('strips filler prefixes and surfaces slash-command args as the title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sstest-titles-'));
    // Filler-prefix case: "can you look into …" should drop the prefix and capitalize.
    writeFileSync(
      join(dir, 'sess-filler.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'can you look into the cluster outage in frankfurt' } }) + '\n',
    );
    // Slash-command case: /goal's <command-args> payload IS the user's intent, even
    // though the surrounding envelope looks like a system injection.
    writeFileSync(
      join(dir, 'sess-cmd.jsonl'),
      JSON.stringify({ type: 'user', message: { content: '<command-name>/goal</command-name><command-args>ship gamekit by tomorrow morning</command-args>' } }) + '\n',
    );
    const list = new SessionStore({ dir }).list();
    const filler = list.find((s) => s.id === 'sess-filler')!;
    const cmd = list.find((s) => s.id === 'sess-cmd')!;
    // "can you look into" → stripped, then "the cluster outage…" capitalized.
    expect(filler.title.startsWith('The cluster outage')).toBe(true);
    // /goal args appear as the title source, after first-letter capitalization.
    expect(cmd.title).toBe('Ship gamekit by tomorrow morning');
  });

  it('carries structured Task* tool_use fields and surfaces their tool_result', () => {
    // The PWA's todos panel is rebuilt from the disk transcript on reload, so session-store
    // has to preserve enough of each Task* tool call to do that: name, input, tool_use_id,
    // and the matching tool_result text (which carries the server-assigned task id). Other
    // tools' results stay dropped — they'd bloat the transcript for no UI benefit.
    const dir = mkdtempSync(join(tmpdir(), 'sstest-task-'));
    writeFileSync(
      join(dir, 'sess-task.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_01',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_create', name: 'TaskCreate', input: { subject: 'Ship feature' } },
            { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { path: '/x' } },
          ],
        },
      }) + '\n' +
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_create', content: 'Task #1 created successfully: Ship feature' },
            { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file contents we do not want in the transcript' },
          ],
        },
      }) + '\n',
    );
    const msgs = new SessionStore({ dir }).readMessages('sess-task');
    const create = msgs.find((m) => m.toolName === 'TaskCreate');
    expect(create?.toolUseId).toBe('toolu_create');
    expect((create?.toolInput as { subject: string }).subject).toBe('Ship feature');
    const result = msgs.find((m) => m.role === 'tool_result');
    expect(result?.toolUseId).toBe('toolu_create');
    expect(result?.text).toContain('Task #1 created');
    // Read's tool_result must NOT leak through — that's the existing behavior we're preserving.
    expect(msgs.some((m) => m.role === 'tool_result' && m.toolUseId === 'toolu_read')).toBe(false);
  });

  it('stamps msgId on assistant + tool_use entries so the PWA can dedupe WS replays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sstest-msgid-'));
    writeFileSync(
      join(dir, 'sess-cccccccc.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking now' },
            { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { path: '/tmp/x' } },
          ],
        },
      }) + '\n',
    );
    const store = new SessionStore({ dir });
    const msgs = store.readMessages('sess-cccccccc');
    const assistantText = msgs.find((m) => m.role === 'assistant');
    const toolUse = msgs.find((m) => m.role === 'tool_use');
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(assistantText?.msgId).toBe('msg_01abc');
    expect(toolUse?.msgId).toBe('msg_01abc');
    expect(userMsg?.msgId).toBeUndefined();
  });
});
