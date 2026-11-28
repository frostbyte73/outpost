// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { renderMarkdown } from '../../src/pwa/markdown.js';

const NAME = '1795000000000-abcdef12.png';
const ROUTE = `/api/screenshots/${NAME}`;

function parse(md: string, opts?: { allowHtml?: boolean }): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md, opts);
  return el;
}

describe('renderMarkdown — screenshots', () => {
  it('renders a cited screenshot, by route or by the path the tool prints, as a labelled route image', () => {
    for (const src of [ROUTE, `/Users/x/.outpost/screenshots/${NAME}`]) {
      const el = parse(`![Home](${src})`);
      const img = el.querySelector('figure.md-shot a[data-shot] img')!;
      expect(img.getAttribute('src')).toBe(ROUTE);
      expect(img.closest('a')!.getAttribute('href')).toBe(ROUTE);
      expect(el.querySelector('figcaption')!.textContent).toBe('Home');
    }
  });

  it('never renders any other image URL as an image', () => {
    const md = [
      '![x](https://evil.example/a.png)',
      '![y](javascript:alert(1))',
      '![z](/api/screenshots/../../etc/passwd)',
      '![w](/api/other.png)',
    ].join('\n\n');
    const html = renderMarkdown(md);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(parse(md).querySelector('a.md-link')!.getAttribute('href')).toBe('https://evil.example/a.png');
  });

  it('keeps a hostile label inert, including raw HTML and code spans filled in after the image pass', () => {
    const cases: Array<[string, { allowHtml?: boolean }?]> = [
      [`![a" onerror="alert(1)](${ROUTE})`],
      [`![<a title="x onerror=alert(1) y">](${ROUTE})`, { allowHtml: true }],
      [`![\`a" onerror="alert(1)\`](${ROUTE})`],
      [`<a href="https://x onerror=alert(1)//">x</a> ![\x00\x00HTML0\x00HTML0\x00](${ROUTE})`, { allowHtml: true }],
    ];
    for (const [md, opts] of cases) {
      const imgs = parse(md, opts).querySelectorAll('img');
      expect(imgs, md).toHaveLength(1);
      expect(imgs[0]!.hasAttribute('onerror'), md).toBe(false);
      expect(imgs[0]!.getAttribute('src'), md).toBe(ROUTE);
    }
  });

  it('never lets a raw tag substituted after the link passes break out of an href', () => {
    for (const md of [
      '![l](/x<img alt="a onmouseover=alert(1) b">)',
      '[l](/x<img alt="a onmouseover=alert(1) b">)',
      'https://x.example/<img alt="a onmouseover=alert(1) b">',
    ]) {
      const el = parse(md, { allowHtml: true });
      expect(el.querySelector('[onmouseover]'), md).toBeNull();
    }
  });

  it('keeps a screenshot inside a link as itself, and a linked badge pointing at the outer link', () => {
    const html = renderMarkdown(`[![a](${ROUTE})](/y)`);
    expect(html).not.toContain('\x00');
    expect(parse(`[![a](${ROUTE})](/y)`).querySelector('a[data-shot] img')).not.toBeNull();

    const badge = parse('[![build](https://img.example/b.svg)](https://ci.example/y)').querySelectorAll('a');
    expect(badge).toHaveLength(1);
    expect(badge[0]!.getAttribute('href')).toBe('https://ci.example/y');
    expect(badge[0]!.textContent).toBe('build');
  });

  it('lays out a paragraph of only screenshots side by side, and keeps one in prose inside its paragraph', () => {
    const group = parse(`![A — current](${ROUTE})\n![B — proposed](${ROUTE})`);
    expect(group.querySelectorAll('.md-shots > figure.md-shot')).toHaveLength(2);
    expect(group.querySelector('p')).toBeNull();

    const prose = parse(`see ![A](${ROUTE}) here`);
    expect(prose.querySelector('.md-shots, figure')).toBeNull();
    const p = prose.querySelector('p')!;
    expect(p.querySelector('a[data-shot] img')).not.toBeNull();
    expect(p.textContent).toContain('here');
  });
});
