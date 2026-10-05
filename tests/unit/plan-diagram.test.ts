// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { checkPlanDiagram, D2_SLOTS, d2ThemeFor, diagramRefusal, renderDiagram, themeOverrides } from '../../src/work/plan-diagram.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { DIAGRAM_TOKENS } from '../../src/pwa/components/work/finding.js';

const hasD2 = (() => { try { execFileSync('d2', ['--version']); return true; } catch { return false; } })();

describe('diagramRefusal', () => {
  it('refuses every d2 import spelling, since `..` walks out of any cwd', () => {
    for (const src of ['x: @../secret', 'x:@f', '...@f', 'x: {...@f}', '@f', 'a -> b\n  @f']) {
      expect(diagramRefusal(src), src).toMatch(/imports/);
    }
  });

  it('refuses icons, which d2 fetches over the network', () => {
    expect(diagramRefusal('a: {icon: https://example.com/x.svg}')).toMatch(/icon/);
    expect(diagramRefusal('a.icon: https://example.com/x.svg')).toMatch(/icon/);
  });

  it('lets an @ inside ordinary label text through', () => {
    expect(diagramRefusal('a: "user@host"\nb: mail me @ noon\na -> b')).toBeNull();
  });

  it('caps the source length', () => {
    expect(diagramRefusal('a\n'.repeat(10_001))).toMatch(/cap/);
  });
});

describe('theme palette', () => {
  const tokens = [...new Set(Object.values(D2_SLOTS))];

  it('asks the PWA for exactly the tokens the slots read', () => {
    expect([...DIAGRAM_TOKENS].sort()).toEqual([...tokens].sort());
  });

  it('finds every token as #rrggbb in every theme + mode block of base.css', () => {
    const css = readFileSync('src/pwa/css/base.css', 'utf8');
    const blocks = [...css.matchAll(/\[data-theme="(\w+)"\]\[data-mode="(\w+)"\]\s*\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, theme, mode, body] of blocks) {
      for (const t of tokens) expect(body, `${theme}/${mode} --${t}`).toMatch(new RegExp(`--${t}:\\s*#[0-9a-fA-F]{6};`));
    }
  });

  it('keeps only #rrggbb values, leaving the rest of the slots to the base theme', () => {
    const o = themeOverrides((t) => ({ text: '#ffffff', bg: 'red"}}}\nx: @../s', accent: '#1fd5f9' } as Record<string, string>)[t] ?? null);
    expect(o).toEqual({ N1: '#ffffff', B1: '#1fd5f9', B2: '#1fd5f9' });
  });

  it('bases only terminal on its own d2 theme', () => {
    expect(d2ThemeFor('terminal')).toBe(300);
    expect(d2ThemeFor('plasma')).toBe(0);
    expect(d2ThemeFor(null)).toBe(0);
  });
});

describe('checkPlanDiagram', () => {
  it('leaves findings without a diagram alone', async () => {
    const f: { findings: string; diagram?: unknown } = { findings: 'x' };
    await checkPlanDiagram(f);
    expect(f).toEqual({ findings: 'x' });
  });

  it('drops a blank diagram rather than storing it', async () => {
    const f: { diagram?: unknown } = { diagram: '  ' };
    await checkPlanDiagram(f);
    expect('diagram' in f).toBe(false);
  });

  it('rejects a refused source before d2 runs', async () => {
    await expect(checkPlanDiagram({ diagram: 'x: @../s' })).rejects.toThrow(/did not compile: .*imports/);
  });

  it.skipIf(!hasD2)('rejects a source that does not compile, carrying d2\'s line:col', async () => {
    await expect(checkPlanDiagram({ diagram: 'a -> b: {\n' })).rejects.toThrow(/did not compile: .*-:1:\d+/);
  });

  it.skipIf(!hasD2)('accepts a valid source unchanged', async () => {
    const f = { diagram: 'a -> b: submit_plan' };
    await checkPlanDiagram(f);
    expect(f.diagram).toBe('a -> b: submit_plan');
  });

  it.skipIf(!hasD2)('paints the slots in the given colours, over the model\'s own override', async () => {
    const src = 'vars: {d2-config: {theme-overrides: {N7: "#111111"}}}\na -> b';
    const svg = await renderDiagram(src, 0, { N7: '#faf7ef', N1: '#1c1814', B1: '#9a6300' });
    expect(svg).toContain('.fill-N7{fill:#faf7ef;}');
    expect(svg).toContain('.fill-N1{fill:#1c1814;}');
    expect(svg).toContain('.stroke-B1{stroke:#9a6300;}');
  });
});
