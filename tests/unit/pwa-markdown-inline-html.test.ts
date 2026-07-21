// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { renderMarkdown } from '../../src/pwa/markdown.js';

describe('renderMarkdown — HTML off by default (Claude-authored text)', () => {
  it('escapes a bare allowlisted tag in prose instead of rendering it live', () => {
    const html = renderMarkdown('the collapsible <details> element');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).toContain('&lt;details&gt;');
    expect(html).toContain('element');
  });

  it('renders inline-code tags as escaped code, keeping the tail intact', () => {
    const html = renderMarkdown('passing to the collapsible `<details>` element.');
    expect(html).toContain('<code class="md-code">&lt;details&gt;</code>');
    expect(html).toContain('element.');
    expect(html).not.toContain('<details');
  });

  it('handles a double-backtick span wrapping a literal single-backtick tag', () => {
    const html = renderMarkdown('So `` `<details>` `` gets grabbed by the pass');
    expect(html).toContain('<code class="md-code">`&lt;details&gt;`</code>');
    expect(html).toContain('gets grabbed');
    expect(html).not.toContain('<details');
  });

  it('never leaks a live tag even with odd/nested backticks (the real-world regression)', () => {
    // this exact prose — a regex literal in backticks, plus nested code examples —
    // has an odd backtick count and defeated the earlier carve-based fix
    const src =
      'backtick-run-aware (`/(`+)([^\\n]*?)\\1/g`): a run of N backticks closes on ' +
      'the next run of N. Added the strip so `` `<details>` `` renders as `` `<details>` `` cleanly.';
    const html = renderMarkdown(src);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
  });

  it('leaves fenced code blocks untouched', () => {
    const html = renderMarkdown('```\n<details>raw</details>\n```');
    expect(html).toContain('<pre class="md-pre">');
    expect(html).toContain('&lt;details&gt;raw&lt;/details&gt;');
  });
});

describe('renderMarkdown — HTML on (trusted bot content)', () => {
  it('renders a bare allowlisted tag as real HTML when opted in', () => {
    const html = renderMarkdown('<details><summary>x</summary>body</details>', { allowHtml: true });
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>');
  });

  it('still escapes tags written as inline code even with HTML on', () => {
    const html = renderMarkdown('use `<script>alert(1)</script>` carefully', { allowHtml: true });
    expect(html).toContain('<code class="md-code">&lt;script&gt;alert(1)&lt;/script&gt;</code>');
    expect(html).not.toContain('<script>');
  });

  it('drops non-allowlisted tags to text even with HTML on', () => {
    const html = renderMarkdown('<script>alert(1)</script>', { allowHtml: true });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
