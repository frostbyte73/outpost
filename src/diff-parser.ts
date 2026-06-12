export type DiffOp = ' ' | '+' | '-';

export interface DiffRow {
  op: DiffOp;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: DiffRow[];
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  truncated: boolean;
  hunks: DiffHunk[];
}

const MAX_ROWS_PER_FILE = 5000;

export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split('\n');
  const files: DiffFile[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git ')) { i++; continue; }
    const header = parseGitHeader(lines[i]!);
    i++;

    let status: DiffFileStatus = 'modified';
    let oldPath: string | undefined;
    let path = header.newPath;
    let binary = false;

    // Pre-hunk metadata: `new file mode`, `deleted file mode`, `rename from/to`,
    // `copy from/to`, `Binary files … differ`, `index …`, `--- …`, `+++ …`.
    while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('diff --git ')) {
      const line = lines[i]!;
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename from ')) { status = 'renamed'; oldPath = line.slice('rename from '.length); }
      else if (line.startsWith('rename to ')) { path = line.slice('rename to '.length); }
      else if (line.startsWith('copy from ')) { status = 'copied'; oldPath = line.slice('copy from '.length); }
      else if (line.startsWith('copy to ')) { path = line.slice('copy to '.length); }
      else if (line.startsWith('Binary files ')) binary = true;
      i++;
    }

    const hunks: DiffHunk[] = [];
    let truncated = false;
    let rowCount = 0;

    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const hunkHeader = parseHunkHeader(lines[i]!);
      i++;
      const rows: DiffRow[] = [];
      let oldLine = hunkHeader.oldStart;
      let newLine = hunkHeader.newStart;

      while (i < lines.length
          && !lines[i]!.startsWith('@@')
          && !lines[i]!.startsWith('diff --git ')) {
        const raw = lines[i]!;
        i++;
        if (raw.startsWith('\\ ')) continue; // "\ No newline at end of file"
        if (raw === '') {
          // Blank line outside a hunk body (trailing newline split artifact) — stop this hunk.
          break;
        }
        if (rowCount >= MAX_ROWS_PER_FILE) { truncated = true; continue; }
        const op = raw[0];
        const content = raw.slice(1);
        if (op === ' ') {
          rows.push({ op: ' ', content, oldLine, newLine });
          oldLine++; newLine++;
        } else if (op === '-') {
          rows.push({ op: '-', content, oldLine });
          oldLine++;
        } else if (op === '+') {
          rows.push({ op: '+', content, newLine });
          newLine++;
        } else {
          // Unknown — bail on this hunk body.
          break;
        }
        rowCount++;
      }
      hunks.push({ ...hunkHeader, rows });
    }

    files.push({ path, oldPath, status, binary, truncated, hunks });
  }
  return files;
}

interface GitHeader { oldPath: string; newPath: string; }

function parseGitHeader(line: string): GitHeader {
  // `diff --git a/<old> b/<new>` — git quotes paths containing special chars with C-style escapes.
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const first = readCQuoted(rest, 0);
    const second = readCQuoted(rest, first.next + 1);
    return { oldPath: stripPrefix(first.value, 'a/'), newPath: stripPrefix(second.value, 'b/') };
  }
  // Unquoted: split on the ` b/` midpoint. For identical-path-on-both-sides (the common case)
  // this is unambiguous; for rename headers git uses different paths but the same prefix shape.
  const idx = rest.indexOf(' b/');
  if (idx === -1) return { oldPath: rest, newPath: rest };
  const left = rest.slice(0, idx);
  const right = rest.slice(idx + 1);
  return { oldPath: stripPrefix(left, 'a/'), newPath: stripPrefix(right, 'b/') };
}

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function readCQuoted(s: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let out = '';
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1]!;
      out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '0' ? '\0' : c;
      i += 2;
    } else {
      out += s[i]!;
      i++;
    }
  }
  return { value: out, next: i };
}

function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  };
}
