import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// launchd strips the shell PATH, so the usual install locations are searched explicitly.
export function findOnPath(name: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const dirs = [
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
