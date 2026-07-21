import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader for the daemon's runtime env. Looks for `<runtimeDir>/.env`
// and merges any KEY=VALUE lines into `process.env`, without overwriting anything
// already set (env passed via plist or shell still wins). This exists so users on
// macOS launchd — which doesn't inherit shell env — can hand the daemon things
// like GITHUB_TOKEN without editing the plist.
//
// Supported syntax (dotenv-compatible subset):
//   KEY=value
//   KEY="quoted value"   (double quotes stripped; \n becomes newline)
//   KEY='single quoted'  (single quotes stripped, no escapes)
//   # comment lines and blank lines ignored
//   Lines without `=` or with empty keys are ignored.
//
// Returns the number of keys loaded so the caller can log a one-liner.

export interface LoadEnvFileOptions {
  // When true, replaces existing process.env values; defaults to false so a plist /
  // shell-level setting still beats the file.
  override?: boolean;
}

export function loadEnvFile(path: string, opts: LoadEnvFileOptions = {}): number {
  if (!existsSync(path)) return 0;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return 0; }
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (!opts.override && process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded++;
  }
  return loaded;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
  // Tolerate `export KEY=value` since users copy-paste from shell rc files.
  const stripped = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const eq = stripped.indexOf('=');
  if (eq <= 0) return null;
  const key = stripped.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = stripped.slice(eq + 1).trim();
  // Strip a trailing inline comment if the value isn't quoted. dotenv does the same.
  if (!isQuoted(value)) {
    const commentIdx = findUnquotedHash(value);
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trimEnd();
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function isQuoted(v: string): boolean {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
}

// A `#` inside a quoted-or-unfinished string isn't a comment marker. This is a
// best-effort scan: walk the string, track whether we're inside `"` or `'`, and
// return the index of the first `#` that's preceded by whitespace (or start).
function findUnquotedHash(v: string): number {
  let inDouble = false, inSingle = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '#' && !inDouble && !inSingle) {
      if (i === 0 || /\s/.test(v[i - 1]!)) return i;
    }
  }
  return -1;
}
