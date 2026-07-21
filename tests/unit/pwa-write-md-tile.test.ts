// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { editWriteTileHtml, isMarkdownPath, MD_RENDER_MAX_LINES } from '../../src/pwa/components/tool-use-tile.js';

const expanded = (id: string) => ({ expandedTools: new Set([id]), ctx: { cwd: '/tmp/proj' } });

describe('editWriteTileHtml — markdown Write body', () => {
  it('renders a .md Write as formatted markdown, not numbered code rows', () => {
    const m = {
      toolName: 'Write',
      toolUseId: 't1',
      toolInput: { file_path: '/tmp/proj/spec.md', content: '# Title\n\n- one\n- two' },
    };
    const html = editWriteTileHtml(m, expanded('t1'));
    expect(html).toContain('write-md');
    expect(html).toContain('<h1 class="md-h md-h1">Title</h1>');
    expect(html).toContain('<li>one</li>');
    // no numbered source-line grid
    expect(html).not.toContain('write-line');
  });

  it('keeps the numbered code view for non-markdown Writes', () => {
    const m = {
      toolName: 'Write',
      toolUseId: 't2',
      toolInput: { file_path: '/tmp/proj/foo.ts', content: 'const x = 1;\nconst y = 2;' },
    };
    const html = editWriteTileHtml(m, expanded('t2'));
    expect(html).toContain('write-line');
    expect(html).not.toContain('write-md');
  });

  it('falls back to numbered rows for a huge .md over the line cap', () => {
    const content = Array.from({ length: MD_RENDER_MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
    const m = { toolName: 'Write', toolUseId: 't3', toolInput: { file_path: '/tmp/proj/big.md', content } };
    const html = editWriteTileHtml(m, expanded('t3'));
    expect(html).toContain('write-line');
    expect(html).not.toContain('write-md');
  });

  it('isMarkdownPath matches .md/.markdown case-insensitively only', () => {
    expect(isMarkdownPath('/x/plan.md')).toBe(true);
    expect(isMarkdownPath('/x/PLAN.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('/x/readme.txt')).toBe(false);
    expect(isMarkdownPath('/x/md.ts')).toBe(false);
  });
});
