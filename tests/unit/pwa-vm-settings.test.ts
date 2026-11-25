// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { hotkeyRows, runtimeRow, settingsSections } from '../../src/pwa/vm/settings.js';

describe('settingsSections', () => {
  it('includes Hotkeys only on desktop', () => {
    const desktop = settingsSections({}, true).map((g: any) => g.label);
    const mobile = settingsSections({}, false).map((g: any) => g.label);
    expect(desktop).toContain('Hotkeys');
    expect(mobile).not.toContain('Hotkeys');
  });

  it('lists Runtimes, not a Claude-only account page', () => {
    const keys = settingsSections({}, true).flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(keys).toContain('runtimes');
    expect(keys).not.toContain('claude-account');
  });
});

describe('runtimeRow', () => {
  const codex = { id: 'codex', label: 'Codex', kind: 'codex', available: true, canLogin: true };

  it('offers sign-in on a signed-out runtime without alarming', () => {
    const row = runtimeRow({ ...codex, account: { loggedIn: false } });
    expect(row).toMatchObject({ statusLabel: 'Signed out', tone: 'warn', canLogin: true, signedIn: false });
  });

  it('reports a probe that failed as unknown rather than signed out', () => {
    expect(runtimeRow({ ...codex, account: { loggedIn: false, error: 'timed out' } }))
      .toMatchObject({ statusLabel: 'Unknown', sub: 'timed out' });
  });

  it('shows the account detail when signed in', () => {
    expect(runtimeRow({ ...codex, account: { loggedIn: true, detail: 'Logged in using ChatGPT' } }))
      .toMatchObject({ statusLabel: 'Signed in', sub: 'Logged in using ChatGPT', tone: 'ok' });
  });

  it('offers no login for a runtime that is not installed, or an ACP agent', () => {
    expect(runtimeRow({ ...codex, available: false })).toMatchObject({ statusLabel: 'Not installed', canLogin: false });
    const acp = runtimeRow({ id: 'acp:goose', label: 'Goose', kind: 'acp', available: true, canLogin: false, command: 'goose', args: ['acp'] });
    expect(acp).toMatchObject({ statusLabel: 'Installed', canLogin: false, removable: true, sub: 'goose acp' });
  });
});

describe('hotkeyRows', () => {
  it('groups by surface in order and reflects an override over the default', () => {
    const groups = hotkeyRows({ 'shell.toggleSidebar': 'mod+shift+b' });
    expect(groups.map((g: any) => g.surface)).toEqual(['shell', 'session', 'palette', 'diff', 'cockpit']);
    const shell = groups.find((g: any) => g.surface === 'shell')!;
    const sidebar = shell.rows.find((r: any) => r.id === 'shell.toggleSidebar')!;
    expect(sidebar.binding).toBe('mod+shift+b');
    expect(sidebar.isDefault).toBe(false);
    const palette = groups.find((g: any) => g.surface === 'palette')!;
    const cycle = palette.rows.find((r: any) => r.id === 'palette.cycleModel')!;
    expect(cycle.binding).toBe('mod+m');
    expect(cycle.isDefault).toBe(true);
  });
});
