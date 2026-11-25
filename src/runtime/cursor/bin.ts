import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findOnPath } from '../bin.js';

export function resolveCursorBin(): string | null {
  const override = process.env.OUTPOST_CURSOR_BIN;
  if (override && existsSync(override)) return override;
  return findOnPath('agent');
}

// The installed version, or null when the binary doesn't answer like the Cursor CLI.
export function cursorVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    return /^\d{4}\.\d+\.\d+-[0-9a-f]+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
