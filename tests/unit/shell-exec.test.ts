import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashBlocks, splitBashBlocks, SessionShell } from '../../src/session/shell-exec.js';
import { SessionStore } from '../../src/session/session-store.js';

describe('bash block round-trip', () => {
  it('recovers the run and leaves the user text the blocks were prepended to', () => {
    const blocks = bashBlocks({ command: 'ls -la', stdout: 'a\nb\n', stderr: '' });
    const { runs, rest } = splitBashBlocks(`${blocks}now look at that`);
    expect(runs).toEqual([{ command: 'ls -la', stdout: 'a\nb\n', stderr: '' }]);
    expect(rest).toBe('now look at that');
  });

  it('recovers several runs queued before one message', () => {
    const text = bashBlocks({ command: 'pwd', stdout: '/tmp\n', stderr: '' })
      + bashBlocks({ command: 'false', stdout: '', stderr: 'exit 1' });
    const { runs, rest } = splitBashBlocks(text);
    expect(runs.map((r) => r.command)).toEqual(['pwd', 'false']);
    expect(runs[1]!.stderr).toBe('exit 1');
    expect(rest).toBe('');
  });
});

describe('SessionShell', () => {
  it('runs in the session cwd, broadcasts the result, and queues it for the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellexec-'));
    const sent: unknown[] = [];
    const shell = new SessionShell({
      cwdFor: () => dir,
      broadcast: (_id, msg) => { sent.push(msg); },
      enabled: () => true,
    });

    await shell.run('s1', 'x1', 'pwd');

    expect(sent).toHaveLength(1);
    expect((sent[0] as { stdout: string }).stdout.trim()).toBe(realpathSync(dir));

    const drained = shell.drain('s1');
    expect(drained).toContain('<bash-input>pwd</bash-input>');
    // Drained once — a second message must not replay the same output.
    expect(shell.drain('s1')).toBe('');

    shell.restore('s1', drained);
    expect(shell.drain('s1')).toBe(drained);
  });

  it('reports a failing command on stderr without queueing nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellexec-'));
    const shell = new SessionShell({ cwdFor: () => dir, broadcast: () => {}, enabled: () => true });
    await shell.run('s1', 'x1', 'exit 3');
    expect(shell.drain('s1')).toContain('exit 3');
  });

  // The preference is what grants this — a client that sends the frame anyway must not run.
  it('runs nothing and queues nothing while the preference is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellexec-'));
    const marker = join(dir, 'ran');
    const sent: unknown[] = [];
    const shell = new SessionShell({
      cwdFor: () => dir,
      broadcast: (_id, msg) => { sent.push(msg); },
      enabled: () => false,
    });

    await shell.run('s1', 'x1', `touch ${marker}`);

    expect(existsSync(marker)).toBe(false);
    expect(shell.drain('s1')).toBe('');
    expect((sent[0] as { stderr: string }).stderr).toMatch(/Settings/);
  });
});

describe('SessionStore transcript', () => {
  it('renders a `!` run as its own entry and keeps the message it rode in with', () => {
    const root = mkdtempSync(join(tmpdir(), 'shellstore-'));
    const projectDir = join(root, '-p');
    mkdirSync(projectDir);
    const blocks = bashBlocks({ command: 'git status', stdout: 'clean\n', stderr: '' });
    writeFileSync(
      join(projectDir, 'sess-shell01.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmpdir(), message: { content: `${blocks}what changed?` } }) + '\n',
    );

    const messages = new SessionStore({ root }).readMessages('sess-shell01');
    expect(messages).toEqual([
      { role: 'shell', text: 'git status', stdout: 'clean\n', stderr: '' },
      { role: 'user', text: 'what changed?' },
    ]);
  });
});
