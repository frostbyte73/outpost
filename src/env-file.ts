import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
// A value starting with `op://` is a 1Password reference, resolved via `op read`
// (OUTPOST_ENV_STRICT=1 makes an unresolvable one fatal instead of a warning).
//
// Returns the number of keys loaded so the caller can log a one-liner.

export interface LoadEnvFileOptions {
  // When true, replaces existing process.env values; defaults to false so a plist /
  // shell-level setting still beats the file.
  override?: boolean;
  opBin?: string;
  opTimeoutMs?: number;
}

const OP_READ_TIMEOUT_MS = 60_000;
const OP_INSTALL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

// launchd doesn't inherit the shell PATH, so a bare `op` can be invisible.
export function resolveOpBin(): string {
  const override = process.env.OUTPOST_OP_BIN;
  if (override && existsSync(override)) return override;
  const dirs = [
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    ...OP_INSTALL_DIRS,
    join(homedir(), '.local/bin'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'op');
    if (existsSync(candidate)) return candidate;
  }
  return 'op';
}

function isReference(value: string): boolean {
  return value.startsWith('op://');
}

function describeOpFailure(err: unknown, opTimeoutMs: number): string {
  const e = err as { code?: string; signal?: string; stderr?: string | Buffer; message?: string } | null;
  if (e?.code === 'ENOENT') {
    return '1Password CLI not found (install it, or set OUTPOST_OP_BIN to its path)';
  }
  // A timeout surfaces as a signal, not a status.
  if (e?.signal) {
    return `timed out after ${opTimeoutMs / 1000}s (is 1Password unlocked?)`;
  }
  const stderr = typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString() ?? '';
  const reason = stderr.split('\n').map((l) => l.trim()).find(Boolean);
  if (reason) return reason;
  return e?.message ?? 'unknown error';
}

export function loadEnvFile(path: string, opts: LoadEnvFileOptions = {}): number {
  if (!existsSync(path)) return 0;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return 0; }

  const pairs: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed) pairs.push(parsed);
  }

  // First occurrence wins, as it did when this wrote straight to process.env.
  const claimed = new Set(Object.keys(process.env));
  const entries: [string, string][] = [];
  for (const [key, value] of pairs) {
    if (!opts.override && claimed.has(key)) continue;
    claimed.add(key);
    entries.push([key, value]);
  }

  // One op read per distinct reference, not per key.
  const keysByRef = new Map<string, string[]>();
  for (const [key, value] of entries) {
    if (!isReference(value)) continue;
    const keys = keysByRef.get(value) ?? [];
    keys.push(key);
    keysByRef.set(value, keys);
  }

  // Plain values first, so a file can set OUTPOST_OP_BIN / OUTPOST_ENV_STRICT for its own load.
  let loaded = 0;
  for (const [key, value] of entries) {
    if (isReference(value)) continue;
    process.env[key] = value;
    loaded++;
  }

  const opBin = opts.opBin ?? resolveOpBin();
  const opTimeoutMs = opts.opTimeoutMs ?? OP_READ_TIMEOUT_MS;
  const strict = process.env.OUTPOST_ENV_STRICT === '1';
  const secrets = new Map<string, string>();
  for (const ref of keysByRef.keys()) {
    try {
      const out = execFileSync(opBin, ['read', ref], {
        encoding: 'utf8',
        timeout: opTimeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // One trailing newline only: a secret may legitimately end in whitespace.
      secrets.set(ref, out.replace(/\r?\n$/, ''));
    } catch (err) {
      const message = `[env] could not resolve ${ref} for ${keysByRef.get(ref)!.join(', ')}: ${describeOpFailure(err, opTimeoutMs)}`;
      if (strict) throw new Error(message);
      console.warn(message);
    }
  }

  for (const [key, value] of entries) {
    if (!isReference(value)) continue;
    const secret = secrets.get(value);
    if (secret === undefined) continue;
    process.env[key] = secret;
    loaded++;
  }

  // Key names only — never the values.
  const resolved = entries.filter(([, value]) => isReference(value) && secrets.has(value));
  if (resolved.length > 0) {
    console.log(`[env] resolved ${resolved.length} secret${resolved.length === 1 ? '' : 's'} from 1Password (${resolved.map(([key]) => key).join(', ')})`);
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
