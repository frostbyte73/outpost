import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// launchd strips the shell PATH, so a bare `spawn('claude')` can ENOENT even though the
// binary is installed (e.g. Homebrew's /opt/homebrew/bin). Resolve an absolute path from
// an explicit override or the usual install locations, re-checked on every spawn so a
// `claude-code` cask upgrade that relocates the symlink is picked up on the next session.
export function resolveClaudeBin(): string {
  const override = process.env.OUTPOST_CLAUDE_BIN;
  if (override && existsSync(override)) return override;
  const dirs = [
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
    join(homedir(), '.claude/local'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return 'claude'; // last resort: let spawn search PATH; a miss surfaces via the 'error' handler
}

// Sessions run the SDK's bundled binary, which speaks its exact control protocol, unless overridden
export function sdkExecutable(): { pathToClaudeCodeExecutable?: string } {
  const override = process.env.OUTPOST_CLAUDE_BIN;
  return override && existsSync(override) ? { pathToClaudeCodeExecutable: override } : {};
}
