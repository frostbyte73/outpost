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
    expect(b.title).toContain('hello');
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
