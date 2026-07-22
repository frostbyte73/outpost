// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshKeymap() {
  vi.resetModules();
  // @ts-expect-error PWA modules are plain JS; tests import them at runtime.
  const prefs = await import('../../src/pwa/state/preferences.js');
  const pushSpy = vi.spyOn(prefs, 'push').mockImplementation(() => {});
  // @ts-expect-error runtime JS import
  const mod = await import('../../src/pwa/state/keymap.js');
  return { keymap: mod.keymap, applyForTest: mod.__applyOverridesForTest, pushSpy };
}

function ev(init: any) { return new KeyboardEvent('keydown', init); }

beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('keymap registry', () => {
  it('bindingFor returns override else catalog default', async () => {
    const { keymap } = await freshKeymap();
    expect(keymap.bindingFor('shell.toggleSidebar')).toBe('mod+b');
    keymap.setBinding('shell.toggleSidebar', 'mod+shift+b');
    expect(keymap.bindingFor('shell.toggleSidebar')).toBe('mod+shift+b');
  });

  it('matches uses the platform modifier', async () => {
    const { keymap } = await freshKeymap();
    // force mac for determinism
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(keymap.matches(ev({ key: 'b', metaKey: true }), 'shell.toggleSidebar')).toBe(true);
    expect(keymap.matches(ev({ key: 'b' }), 'shell.toggleSidebar')).toBe(false);
  });

  it('conflictFor: same surface conflicts', async () => {
    const { keymap } = await freshKeymap();
    // palette.newProject default mod+o; try to steal it for palette.cycleModel
    expect(keymap.conflictFor('mod+o', 'palette.cycleModel')).toBe('palette.newProject');
  });

  it('conflictFor: two non-global surfaces may reuse a combo', async () => {
    const { keymap } = await freshKeymap();
    // palette.launchSession and diff.primaryAction both mod+enter by default,
    // different non-shell surfaces -> no conflict.
    expect(keymap.conflictFor('mod+enter', 'diff.primaryAction')).toBeNull();
  });

  it('conflictFor: shell conflicts with anything sharing the combo', async () => {
    const { keymap } = await freshKeymap();
    // give a shell command the same combo a palette command uses
    expect(keymap.conflictFor('mod+o', 'shell.toggleSidebar')).toBe('palette.newProject');
    // and vice versa: a palette command colliding with a shell default
    expect(keymap.conflictFor('mod+b', 'palette.cycleModel')).toBe('shell.toggleSidebar');
  });

  it('isReserved flags browser/OS combos incl. mod+shift+a', async () => {
    const { keymap } = await freshKeymap();
    expect(keymap.isReserved('mod+w')).toBe(true);
    expect(keymap.isReserved('mod+shift+a')).toBe(true);
    expect(keymap.isReserved('mod+shift+k')).toBe(false);
  });

  it('validate: shell command requires a modifier', async () => {
    const { keymap } = await freshKeymap();
    expect(keymap.validate('shell.toggleSidebar', 'x')).toEqual({ ok: false, reason: 'modifier' });
    expect(keymap.validate('diff.comment', 'x').ok).toBe(true); // context cmd may be bare
  });

  it('validate: non-diff surfaces require a modifier (session and palette included)', async () => {
    const { keymap } = await freshKeymap();
    expect(keymap.validate('session.promoteToJob', 'p')).toEqual({ ok: false, reason: 'modifier' });
    expect(keymap.validate('palette.cycleModel', 'x')).toEqual({ ok: false, reason: 'modifier' });
    expect(keymap.validate('diff.comment', 'c').ok).toBe(true); // diff commands may stay bare
  });

  it('validate: reserved rejected, conflict rejected with conflictId, valid passes', async () => {
    const { keymap } = await freshKeymap();
    expect(keymap.validate('shell.toggleSidebar', 'mod+w')).toEqual({ ok: false, reason: 'reserved' });
    expect(keymap.validate('palette.cycleModel', 'mod+o')).toEqual({ ok: false, reason: 'conflict', conflictId: 'palette.newProject' });
    expect(keymap.validate('shell.toggleSidebar', 'mod+shift+j')).toEqual({ ok: true });
  });

  it('setBinding records + pushes only when valid', async () => {
    const { keymap, pushSpy } = await freshKeymap();
    expect(keymap.setBinding('shell.toggleSidebar', 'mod+w').ok).toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(keymap.setBinding('shell.toggleSidebar', 'mod+shift+j').ok).toBe(true);
    expect(pushSpy).toHaveBeenCalledWith('hotkeys', { 'shell.toggleSidebar': 'mod+shift+j' });
  });

  it('resetBinding / resetAll drop overrides and push', async () => {
    const { keymap, pushSpy } = await freshKeymap();
    keymap.setBinding('shell.toggleSidebar', 'mod+shift+j');
    keymap.resetBinding('shell.toggleSidebar');
    expect(keymap.bindingFor('shell.toggleSidebar')).toBe('mod+b');
    keymap.setBinding('shell.toggleSidebar', 'mod+shift+j');
    keymap.resetAll();
    expect(keymap.bindingFor('shell.toggleSidebar')).toBe('mod+b');
    expect(pushSpy).toHaveBeenLastCalledWith('hotkeys', {});
  });

  it('applyOverrides sets the map without pushing (no write-echo)', async () => {
    const { keymap, applyForTest, pushSpy } = await freshKeymap();
    applyForTest({ 'shell.toggleSidebar': 'mod+shift+j' });
    expect(keymap.bindingFor('shell.toggleSidebar')).toBe('mod+shift+j');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('unknown override id is ignored (no crash)', async () => {
    const { keymap, applyForTest } = await freshKeymap();
    applyForTest({ 'nope.gone': 'mod+z' });
    expect(keymap.bindingFor('shell.toggleSidebar')).toBe('mod+b');
    expect(keymap.matches(ev({ key: 'z', metaKey: true }), 'shell.toggleSidebar')).toBe(false);
  });

  it('all catalog defaults pass validate against the defaults (self-consistent)', async () => {
    const { keymap } = await freshKeymap();
    // @ts-expect-error runtime JS import
    const { KEYMAP_COMMANDS } = await import('../../src/pwa/state/keymap-commands.js');
    for (const c of KEYMAP_COMMANDS) {
      expect(keymap.validate(c.id, c.defaultBinding)).toEqual({ ok: true });
    }
  });
});
