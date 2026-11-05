import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findOnPath } from '../bin.js';

export function resolveCodexBin(): string | null {
  const override = process.env.OUTPOST_CODEX_BIN;
  if (override && existsSync(override)) return override;
  return findOnPath('codex');
}

// The installed version, or null when the binary doesn't answer like the Codex CLI.
export function codexVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return /codex-cli (\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}
