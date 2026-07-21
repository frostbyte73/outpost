import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../../src/git/diff-parser.js';

describe('parseUnifiedDiff', () => {
  it('parses a single-file single-hunk modify', () => {
    const text = [
      'diff --git a/foo.txt b/foo.txt',
      'index 1111111..2222222 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+line two changed',
      ' line three',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(text);

    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('foo.txt');
    expect(f.oldPath).toBeUndefined();
    expect(f.status).toBe('modified');
    expect(f.binary).toBe(false);
    expect(f.truncated).toBe(false);
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0]!;
    expect(h).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(h.rows).toEqual([
      { op: ' ', content: 'line one', oldLine: 1, newLine: 1 },
      { op: '-', content: 'line two', oldLine: 2 },
      { op: '+', content: 'line two changed', newLine: 2 },
      { op: ' ', content: 'line three', oldLine: 3, newLine: 3 },
    ]);
  });

  it('parses an added file', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f!.status).toBe('added');
    expect(f!.path).toBe('new.txt');
    expect(f!.hunks[0]!.rows).toEqual([
      { op: '+', content: 'hello', newLine: 1 },
      { op: '+', content: 'world', newLine: 2 },
    ]);
  });

  it('parses a deleted file', () => {
    const text = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-goodbye',
      '-world',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f!.status).toBe('deleted');
    expect(f!.path).toBe('old.txt');
    expect(f!.hunks[0]!.rows).toEqual([
      { op: '-', content: 'goodbye', oldLine: 1 },
      { op: '-', content: 'world', oldLine: 2 },
    ]);
  });

  it('parses a pure rename', () => {
    const text = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f!.status).toBe('renamed');
    expect(f!.oldPath).toBe('old.txt');
    expect(f!.path).toBe('new.txt');
    expect(f!.hunks).toEqual([]);
  });

  it('parses a binary diff with no hunks', () => {
    const text = [
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f!.binary).toBe(true);
    expect(f!.hunks).toEqual([]);
  });

  it('drops "no newline" markers', () => {
    const text = [
      'diff --git a/foo.txt b/foo.txt',
      'index 1111111..2222222 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f!.hunks[0]!.rows).toEqual([
      { op: '-', content: 'old', oldLine: 1 },
      { op: '+', content: 'new', newLine: 1 },
    ]);
  });

  it('parses multiple files in one diff', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.txt b/b.txt',
      'index 3333333..4444444 100644',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-b',
      '+B',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('treats missing line counts as 1', () => {
    const text = [
      'diff --git a/foo.txt b/foo.txt',
      'index 1111111..2222222 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -5 +5 @@',
      '-five',
      '+FIVE',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(text);
    expect(f!.hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('truncates hunks past MAX_ROWS_PER_FILE and sets truncated', () => {
    const header = [
      'diff --git a/big.txt b/big.txt',
      'index 1111111..2222222 100644',
      '--- a/big.txt',
      '+++ b/big.txt',
      `@@ -0,0 +1,5001 @@`,
    ];
    const body = Array.from({ length: 5001 }, (_, i) => `+line ${i}`);
    const text = [...header, ...body, ''].join('\n');

    const [f] = parseUnifiedDiff(text);
    expect(f!.truncated).toBe(true);
    expect(f!.hunks[0]!.rows).toHaveLength(5000);
  });
});
