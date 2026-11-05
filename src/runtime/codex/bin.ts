import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// launchd strips the shell PATH, so the usual install locations are searched explicitly.
export function resolveCodexBin(): string | null {
  const override = process.env.OUTPOST_CODEX_BIN;
  if (override && existsSync(override)) return override;
  const dirs = [
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'codex');
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
