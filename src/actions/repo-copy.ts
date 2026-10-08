import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionDirFor } from './registry.js';

// Mirrors a daemon-made SKILL.md write into the repo's working tree — but only when the repo copy
// still reads `expected`. The two trees diverge on purpose for some actions (runtime-only steps that
// must never reach the shared repo), so a write over a copy that differs would port that content.
export function syncRepoCopy(repoActionsDir: string, action: string, expected: string, next: string): boolean {
  const path = join(actionDirFor(repoActionsDir, action).dir, 'SKILL.md');
  let current: string;
  try { current = readFileSync(path, 'utf8'); } catch { return false; }
  if (current === next) return true;
  if (current !== expected) return false;
  writeFileSync(path, next);
  return true;
}
