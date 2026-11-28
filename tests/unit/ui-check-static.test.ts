import { describe, it, expect } from 'vitest';
import { scanCss, scanSource, type Finding } from '../ui-check/static.js';
import { diffBaseline } from '../ui-check/baseline.js';

const rules = (fs: Finding[]) => fs.map((f) => f.rule).sort();

describe('scanCss', () => {
  it('fires each rule on its positive case', () => {
    const css = `
      .a { color: #fff; background: rgba(0,0,0,.5); border-color: white; }
      .b { padding: 8px; margin: 6px; border-radius: 6px; }
      .c { background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
      .d { box-shadow: 0 6px 20px rgb(0 0 0 / .25); }
      .e { backdrop-filter: blur(2px); }
      .f { box-shadow: inset 12px 12px 0 var(--x); }
    `;
    expect(rules(scanCss('x.css', css))).toEqual([
      'backdrop-filter', 'gradient', 'hex-color', 'named-color', 'off-grid-px',
      'off-scale-radius', 'raw-spacing-px', 'rgb-color', 'rgb-color', 'shadow', 'shadow',
    ]);
  });

  it('locates a declaration by its full nested selector chain', () => {
    const [f] = scanCss('x.css', '@media (max-width: 600px) { .a { .b { color: #f00; } } }');
    expect(f?.locator).toBe('@media (max-width: 600px) .a .b { color }');
    expect(f?.line).toBe(1);
  });

  it('exempts only the token file\'s custom properties', () => {
    const css = ':root { --accent: #f00; } .a { color: #0f0; }';
    expect(scanCss('src/pwa/css/base.css', css).map((f) => f.detail)).toEqual(['#0f0']);
  });

  it('stays silent on tokens, hairlines, rails, rings, stripes and masks', () => {
    const css = `
      .a { border: 1px solid var(--line); padding: 0 2px; border-radius: var(--r-control); }
      .b { box-shadow: var(--shadow-pop); }
      .c { box-shadow: inset 2px 0 0 var(--ok); }
      .d { box-shadow: 0 0 0 4px var(--warn-soft), var(--shadow-pop); }
      .d2 { box-shadow: inset 0 0 0 2px var(--accent-soft), inset -2px 0 0 var(--ok), inset 0 -1px 0 var(--line); }
      .e { background-image: linear-gradient(45deg, transparent 50%, currentColor 50%); }
      .f { mask-image: linear-gradient(to bottom, black calc(100% - 20px), transparent); }
      .g { background: linear-gradient(to bottom, var(--bg-elev), transparent); }
      .h { content: "#fff"; background: url(#grad); }
    `;
    expect(scanCss('x.css', css)).toEqual([]);
  });
});

describe('scanSource', () => {
  it('fires on emoji icons and inline-style colours', () => {
    const js = [
      'function render() {',
      '  return `<span>&#128193; Browse</span><b>🚀</b><div style="color:#f00">x</div>`;',
      '}',
      'el.style.color = \'#f00\';',
      'const paint = (el) => {',
      '  const label = 1;',
      '  el.style.background = \'white\';',
      '};',
    ].join('\n');
    const fs = scanSource('x.js', js);
    expect(rules(fs)).toEqual(['emoji-icon', 'emoji-icon', 'hex-color', 'hex-color', 'named-color']);
    expect(fs[0]?.locator).toBe('render');
    expect(fs.at(-1)?.locator).toBe('paint');
  });

  it('ignores id selectors, typographic entities and geometric glyphs', () => {
    const js = [
      "sheet.querySelector('#add-project-input');",
      'const x = `<button aria-label="Close">&#10005;</button><span>&#8984;O</span>`;',
      "const tabs = [{ icon: '◈' }, { icon: '↻' }, { icon: '↗' }, { icon: '⚠' }];",
    ].join('\n');
    expect(scanSource('x.js', js)).toEqual([]);
  });
});

describe('diffBaseline', () => {
  const f: Finding = { category: 'off-token', rule: 'hex-color', where: 'a.css', locator: '.a { color }', detail: '#fff' };
  const k = 'off-token|hex-color|a.css|.a { color }|#fff';

  it('fails only the instances beyond the baselined count', () => {
    const { fresh, known } = diffBaseline([f, f, f], { [k]: 2 });
    expect([fresh.length, known.length]).toEqual([1, 2]);
  });

  it('reports fixed violations as stale without failing', () => {
    const { fresh, stale } = diffBaseline([f], { [k]: 3 });
    expect(fresh).toEqual([]);
    expect(stale).toEqual([[k, 2]]);
  });
});
