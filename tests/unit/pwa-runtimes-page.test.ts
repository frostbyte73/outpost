// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runtimes = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../src/pwa/net/meta.js', () => ({
  metaApi: {
    runtimes: async () => ({ runtimes: runtimes.value }),
    runtimeAuthStart: async () => ({}),
    runtimeAuthCancel: async () => ({}),
    addAcpRuntime: async () => ({}),
    removeAcpRuntime: async () => ({}),
  },
}));

vi.mock('../../src/pwa/components/settings-surface/claude-auth.js', () => ({
  mountClaudeAuth: (body: HTMLElement) => {
    const section = document.createElement('div');
    section.className = 'o-section settings-block claude-test-block';
    section.innerHTML = '<h3>Claude</h3>';
    body.appendChild(section);
    return () => {};
  },
}));

// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
const { renderRuntimes } = await import('../../src/pwa/components/settings-surface/runtimes.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Runtimes page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
  });

  it('gives Codex and Cursor the same block shape as Claude, with ACP agents after', async () => {
    runtimes.value = [
      { id: 'claude', label: 'Claude', kind: 'claude', available: true, canLogin: false },
      { id: 'codex', label: 'Codex', kind: 'codex', available: true, canLogin: true, account: { loggedIn: true, detail: 'Logged in using ChatGPT' }, flow: null },
      { id: 'cursor', label: 'Cursor', kind: 'cursor', available: true, canLogin: true, account: { loggedIn: false }, flow: null },
      { id: 'acp:gemini', label: 'Gemini CLI', kind: 'acp', available: false, canLogin: false, command: 'gemini', args: ['--experimental-acp'] },
    ];
    renderRuntimes(document.getElementById('mount'));
    await flush();
    await flush();

    const headings = [...document.querySelectorAll('#mount .settings-block > h3')].map((h) => h.textContent);
    expect(headings).toEqual(['Claude', 'Codex', 'Cursor', 'Agents', 'Connect an agent']);

    const blocks = [...document.querySelectorAll('#mount .settings-block')];
    const codex = blocks[1]!;
    expect(codex.querySelector('.o-pill')?.textContent).toBe('Signed in');
    expect(codex.querySelector('.o-row-title')?.textContent).toBe('Logged in using ChatGPT');
    expect(codex.querySelector('.runtime-login')?.textContent).toBe('Re-authorize…');

    const cursor = blocks[2]!;
    expect(cursor.querySelector('.o-pill')?.textContent).toBe('Signed out');
    expect(cursor.querySelector('.runtime-login')?.textContent).toBe('Sign in…');

    const agents = blocks[3]!;
    expect(agents.querySelector('.runtime-remove')?.getAttribute('data-id')).toBe('acp:gemini');
    expect(agents.querySelector('.runtime-login')).toBeNull();
  });
});
