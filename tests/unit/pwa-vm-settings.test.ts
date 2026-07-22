// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { hotkeyRows, settingsSections } from '../../src/pwa/vm/settings.js';

describe('settingsSections', () => {
  it('includes Hotkeys only on desktop', () => {
    const desktop = settingsSections({}, true).map((g: any) => g.label);
    const mobile = settingsSections({}, false).map((g: any) => g.label);
    expect(desktop).toContain('Hotkeys');
    expect(mobile).not.toContain('Hotkeys');
  });
});

describe('hotkeyRows', () => {
  it('groups by surface in order and reflects an override over the default', () => {
    const groups = hotkeyRows({ 'shell.toggleSidebar': 'mod+shift+b' });
    expect(groups.map((g: any) => g.surface)).toEqual(['shell', 'session', 'palette', 'diff']);
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
