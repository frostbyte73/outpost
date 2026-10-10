import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/session/session-store.js';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-01T10:00:00Z');

function storeWith(lines: object[]) {
  const root = mkdtempSync(join(tmpdir(), 'sseng-'));
  const proj = join(root, '-p');
  mkdirSync(proj);
  writeFileSync(join(proj, 'sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return new SessionStore({ root }).listProjects()[0]!.sessions[0]!;
}

describe('SessionInfo.lastEngagedAt', () => {
  it('is the newest typed prompt, not later tool results or replies', () => {
    const s = storeWith([
      { type: 'user', cwd: tmpdir(), timestamp: iso(T0), message: { content: 'find the leak' } },
      { type: 'assistant', timestamp: iso(T0 + 1000), message: { content: [{ type: 'text', text: 'looking' }] } },
      { type: 'user', timestamp: iso(T0 + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    ]);
    expect(s.lastEngagedAt).toBe(T0);
    expect(s.lastModified).toBe(T0 + 2000);
  });

  it('falls back to the session file’s creation, never to agent activity', () => {
    const s = storeWith([
      { type: 'assistant', cwd: tmpdir(), timestamp: iso(T0), message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    expect(s.lastEngagedAt).toBe(statSync(s.path).birthtimeMs);
  });

  it('keeps the prompt once a long agent turn pushes it out of the tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'sseng-'));
    const proj = join(root, '-p');
    mkdirSync(proj);
    const file = join(proj, 'sess-1.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', cwd: tmpdir(), timestamp: iso(T0), message: { content: 'go' } }) + '\n');
    const store = new SessionStore({ root });
    expect(store.listProjects()[0]!.sessions[0]!.lastEngagedAt).toBe(T0);
    const filler = 'x'.repeat(2000);
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ type: 'assistant', timestamp: iso(T0 + 1000 + i), message: { content: [{ type: 'text', text: filler }] } })).join('\n') + '\n';
    appendFileSync(file, lines);
    expect(store.listProjects()[0]!.sessions[0]!.lastEngagedAt).toBe(T0);
  });

  it('ignores meta user records', () => {
    const s = storeWith([
      { type: 'user', cwd: tmpdir(), timestamp: iso(T0), message: { content: 'real prompt' } },
      { type: 'user', isMeta: true, timestamp: iso(T0 + 5000), message: { content: 'injected' } },
    ]);
    expect(s.lastEngagedAt).toBe(T0);
  });
});
