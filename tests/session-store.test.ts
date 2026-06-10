import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session-store.js';

describe('SessionStore', () => {
  let rootDir: string;
  let projectDir: string;

  beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'sstest-root-'));
    projectDir = join(rootDir, '-test-project');
    mkdirSync(projectDir);
    const tmp = tmpdir();
    writeFileSync(
      join(projectDir, 'sess-aaaaaaaa.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'Investigating INC-540' }) + '\n' +
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'what is up with INC-540' } }) + '\n',
    );
    writeFileSync(
      join(projectDir, 'sess-bbbbbbbb.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'hello' } }) + '\n',
    );
  });

  it('lists sessions with id + mtime', () => {
    const store = new SessionStore({ root: rootDir });
    const projects = store.listProjects();
    const sessions = projects[0]!.sessions;
    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-aaaaaaaa', 'sess-bbbbbbbb']);
  });

  it('reads the title from summary records when present', () => {
    const store = new SessionStore({ root: rootDir });
    const sessions = store.listProjects()[0]!.sessions;
    const a = sessions.find((s) => s.id === 'sess-aaaaaaaa')!;
    expect(a.title).toBe('Investigating INC-540');
  });

  it('falls back to first-user-message preview when no summary record exists', () => {
    const store = new SessionStore({ root: rootDir });
    const sessions = store.listProjects()[0]!.sessions;
    const b = sessions.find((s) => s.id === 'sess-bbbbbbbb')!;
    // Titles get cleaned: first-letter capitalization is applied.
    expect(b.title).toContain('Hello');
  });

  it('strips filler prefixes and surfaces slash-command args as the title', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-titles-root-'));
    const proj = join(root, '-test-titles');
    mkdirSync(proj);
    const tmp = tmpdir();
    // Filler-prefix case: "can you look into …" should drop the prefix and capitalize.
    writeFileSync(
      join(proj, 'sess-filler.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'can you look into the cluster outage in frankfurt' } }) + '\n',
    );
    // Slash-command case: /goal's <command-args> payload IS the user's intent, even
    // though the surrounding envelope looks like a system injection.
    writeFileSync(
      join(proj, 'sess-cmd.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: '<command-name>/goal</command-name><command-args>ship gamekit by tomorrow morning</command-args>' } }) + '\n',
    );
    const sessions = new SessionStore({ root }).listProjects()[0]!.sessions;
    const filler = sessions.find((s) => s.id === 'sess-filler')!;
    const cmd = sessions.find((s) => s.id === 'sess-cmd')!;
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
    const root = mkdtempSync(join(tmpdir(), 'sstest-task-root-'));
    const proj = join(root, '-test-task');
    mkdirSync(proj);
    const tmp = tmpdir();
    writeFileSync(
      join(proj, 'sess-task.jsonl'),
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
        cwd: tmp,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_create', content: 'Task #1 created successfully: Ship feature' },
            { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file contents we do not want in the transcript' },
          ],
        },
      }) + '\n',
    );
    const msgs = new SessionStore({ root }).readMessages('sess-task');
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
    const root = mkdtempSync(join(tmpdir(), 'sstest-msgid-root-'));
    const proj = join(root, '-test-msgid');
    mkdirSync(proj);
    const tmp = tmpdir();
    writeFileSync(
      join(proj, 'sess-cccccccc.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'hi' } }) + '\n' +
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
    const store = new SessionStore({ root });
    const msgs = store.readMessages('sess-cccccccc');
    const assistantText = msgs.find((m) => m.role === 'assistant');
    const toolUse = msgs.find((m) => m.role === 'tool_use');
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(assistantText?.msgId).toBe('msg_01abc');
    expect(toolUse?.msgId).toBe('msg_01abc');
    expect(userMsg?.msgId).toBeUndefined();
  });

  it('extracts cwd from the first jsonl line in a project dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-cwd-root-'));
    const proj = join(root, '-test-cwd');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-aa.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/dc/livekit', message: { content: 'hi' } }) + '\n',
    );
    const store = new SessionStore({ root });
    expect(store.readCwdFromProject(proj)).toBe('/Users/dc/livekit');
  });

  it('returns null when no jsonl in the project dir has a cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-no-cwd-root-'));
    const proj = join(root, '-test-no-cwd');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-aa.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'no cwd here' } }) + '\n',
    );
    expect(new SessionStore({ root }).readCwdFromProject(proj)).toBeNull();
  });

  it('walks to the next jsonl when the most-recent has no cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-cwd-fallback-root-'));
    const proj = join(root, '-test-cwd-fallback');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-old.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/dc/projectA', message: { content: 'hi' } }) + '\n',
    );
    const newerPath = join(proj, 'sess-new.jsonl');
    writeFileSync(newerPath, JSON.stringify({ type: 'summary', summary: 'no cwd here' }) + '\n');
    const future = new Date(Date.now() + 2000);
    utimesSync(newerPath, future, future);
    expect(new SessionStore({ root }).readCwdFromProject(proj)).toBe('/Users/dc/projectA');
  });

  it('lists projects under a root, each with cwd + sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-root-'));
    const projA = join(root, '-Users-dc-projectA');
    const projB = join(root, '-Users-dc-projectB');
    mkdirSync(projA);
    mkdirSync(projB);
    const tmp = tmpdir();
    writeFileSync(
      join(projA, 'sess-a1.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'a1' } }) + '\n',
    );
    writeFileSync(
      join(projB, 'sess-b1.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'b1' } }) + '\n',
    );
    const projects = new SessionStore({ root }).listProjects();
    expect(projects.length).toBe(2);
    expect(projects.map((p) => p.projectDir).sort()).toEqual([projA, projB].sort());
    const a = projects.find((p) => p.projectDir === projA)!;
    expect(a.sessions.map((s) => s.id)).toEqual(['sess-a1']);
    expect(a.cwd).toBe(tmp);
  });

  it('hides projects whose cwd no longer exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-orphan-'));
    const proj = join(root, '-tmp-deleted-path');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-o.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/this/path/does/not/exist', message: { content: 'x' } }) + '\n',
    );
    expect(new SessionStore({ root }).listProjects()).toEqual([]);
  });

  it('sorts projects by max session mtime descending', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-sort-'));
    const projOld = join(root, '-Users-dc-old');
    const projNew = join(root, '-Users-dc-new');
    mkdirSync(projOld);
    mkdirSync(projNew);
    const tmp = tmpdir();
    writeFileSync(
      join(projOld, 'sess-old.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'old' } }) + '\n',
    );
    writeFileSync(
      join(projNew, 'sess-new.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'new' } }) + '\n',
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(join(projNew, 'sess-new.jsonl'), future, future);
    const projects = new SessionStore({ root }).listProjects();
    expect(projects[0]!.projectDir).toBe(projNew);
    expect(projects[1]!.projectDir).toBe(projOld);
  });

  it('findSession locates a session across project dirs and returns its cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-find-'));
    const projA = join(root, '-Users-dc-projectA');
    mkdirSync(projA);
    const tmp = tmpdir();
    writeFileSync(
      join(projA, 'sess-target.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'hi' } }) + '\n',
    );
    const found = new SessionStore({ root }).findSession('sess-target');
    expect(found?.cwd).toBe(tmp);
    expect(found?.projectDir).toBe(projA);
  });

  it('findSession returns null for an unknown id', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-find-miss-'));
    mkdirSync(join(root, '-Users-dc-empty'));
    expect(new SessionStore({ root }).findSession('nope')).toBeNull();
  });
});
