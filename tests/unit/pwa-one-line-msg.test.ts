// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { oneLineMsgHtml } from '../../src/pwa/components/session-view/message-html.js';

describe('oneLineMsgHtml', () => {
  it('assistant: collapses newlines, truncates to 120 chars', () => {
    const text = 'first line\nsecond line\n' + 'x'.repeat(200);
    const html = oneLineMsgHtml({ role: 'assistant', text });
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain('first line second line');
    const body = html.match(/<span class="inline-line-body">([\s\S]*?)<\/span>/)?.[1] ?? '';
    expect(body.length).toBeLessThanOrEqual(121);
    expect(body.endsWith('…')).toBe(true);
  });

  it('tool_use Read: renders the read tile with the file path', () => {
    const html = oneLineMsgHtml({ role: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a/b/c/foo.ts' } });
    expect(html).toContain('msg-read');
    expect(html).toContain('foo.ts');
  });

  it('tool_use Bash: renders the shell tile with the command', () => {
    const html = oneLineMsgHtml({ role: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo hello' } });
    expect(html).toContain('msg-shell');
    expect(html).toContain('shell-cmd');
    expect(html).toContain('echo hello');
  });

  it('tool_use Grep: renders the shell tile with the pattern', () => {
    const html = oneLineMsgHtml({ role: 'tool_use', toolName: 'Grep', toolInput: { pattern: 'foo' } });
    expect(html).toContain('msg-shell');
    expect(html).toContain('foo');
  });

  it('tool_use unknown: renders JSON preview', () => {
    const html = oneLineMsgHtml({ role: 'tool_use', toolName: 'CustomThing', toolInput: { anything: 42 } });
    expect(html).toContain('→ CustomThing');
    expect(html).toContain('42');
  });

  it('user: prefixes with » and truncates', () => {
    const html = oneLineMsgHtml({ role: 'user', text: 'hello' });
    expect(html).toContain('» hello');
  });

  it('ask: prefixes with ?', () => {
    const html = oneLineMsgHtml({ role: 'ask', questions: [{ question: 'proceed?' }] });
    expect(html).toContain('? proceed?');
  });

  it('error: prefixes with !', () => {
    const html = oneLineMsgHtml({ role: 'error', text: 'oh no' });
    expect(html).toContain('! oh no');
  });

  it('tool_result: returns empty string', () => {
    expect(oneLineMsgHtml({ role: 'tool_result', text: 'output' })).toBe('');
  });

  it('user with only command scaffolding: returns empty', () => {
    const scaffolding = '<local-command-stdout>x</local-command-stdout>';
    expect(oneLineMsgHtml({ role: 'user', text: scaffolding })).toBe('');
  });

  it('escapes HTML in text', () => {
    const html = oneLineMsgHtml({ role: 'assistant', text: '<script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
