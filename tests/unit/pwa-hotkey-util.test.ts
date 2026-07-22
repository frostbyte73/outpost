// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { normalizeEvent, formatCombo } from '../../src/pwa/utils/hotkey.js';

function ev(init: any) { return new KeyboardEvent('keydown', init); }

describe('normalizeEvent', () => {
  it('maps mod to metaKey on mac and ctrlKey off mac', () => {
    expect(normalizeEvent(ev({ key: 'k', metaKey: true }), true)).toBe('mod+k');
    expect(normalizeEvent(ev({ key: 'k', ctrlKey: true }), false)).toBe('mod+k');
    // metaKey on non-mac is not "mod"
    expect(normalizeEvent(ev({ key: 'k', metaKey: true }), false)).toBe('k');
  });

  it('emits modifiers in canonical order mod, alt, shift then key, lowercased', () => {
    expect(normalizeEvent(ev({ key: 'P', metaKey: true, shiftKey: true }), true)).toBe('mod+shift+p');
    expect(normalizeEvent(ev({ key: 'Enter', metaKey: true, shiftKey: true }), true)).toBe('mod+shift+enter');
    expect(normalizeEvent(ev({ key: 'k', metaKey: true, altKey: true, shiftKey: true }), true)).toBe('mod+alt+shift+k');
  });

  it('normalizes special keys', () => {
    expect(normalizeEvent(ev({ key: ' ', metaKey: true }), true)).toBe('mod+space');
    expect(normalizeEvent(ev({ key: 'Tab', metaKey: true }), true)).toBe('mod+tab');
  });

  it('allows a bare context key (no modifier)', () => {
    expect(normalizeEvent(ev({ key: 'c' }), true)).toBe('c');
  });

  it('returns null for a modifier-only keydown', () => {
    expect(normalizeEvent(ev({ key: 'Meta', metaKey: true }), true)).toBeNull();
    expect(normalizeEvent(ev({ key: 'Shift', shiftKey: true }), true)).toBeNull();
  });
});

describe('formatCombo', () => {
  it('renders mac glyphs', () => {
    expect(formatCombo('mod+shift+k', true)).toBe('⌘⇧K');
    expect(formatCombo('mod+enter', true)).toBe('⌘↵');
    expect(formatCombo('c', true)).toBe('C');
  });
  it('renders non-mac form', () => {
    expect(formatCombo('mod+shift+k', false)).toBe('Ctrl⇧K');
  });
  it('round-trips normalizeEvent -> formatCombo', () => {
    const combo = normalizeEvent(ev({ key: 'B', metaKey: true, shiftKey: true }), true)!;
    expect(formatCombo(combo, true)).toBe('⌘⇧B');
  });
});
