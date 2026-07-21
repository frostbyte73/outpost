import { homedir } from 'node:os';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// Outpost ships skills in <repo>/outpost/skills/<name>/. Spawned `claude` processes
// pick up user skills from ~/.claude/skills/<name>/SKILL.md (see daemon.ts scanSkillDir
// for the same discovery path on the daemon side). Symlinking is the simplest robust
// install: no settings.json schema dependency, and the spawned session sees the skill
// the same way any other user-installed skill is seen.
//
// Defensive: refuses to clobber a real directory or a symlink pointing somewhere else.
// Returns the list of skill names successfully installed.
export function ensureWorkSkillsInstalled(skillsDir: string): string[] {
  const userSkillsDir = join(homedir(), '.claude', 'skills');
  mkdirSync(userSkillsDir, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(skillsDir).filter((name) => {
      try { return lstatSync(join(skillsDir, name)).isDirectory(); }
      catch { return false; }
    });
  } catch {
    return [];
  }

  const installed: string[] = [];
  for (const name of entries) {
    const src = join(skillsDir, name);
    const dst = join(userSkillsDir, name);
    let existing: ReturnType<typeof lstatSync> | null = null;
    try { existing = lstatSync(dst); } catch { /* missing */ }

    if (!existing) {
      try {
        symlinkSync(src, dst, 'dir');
        installed.push(name);
        console.log(`[work] installed skill: ~/.claude/skills/${name} -> ${src}`);
      } catch (e) {
        console.warn(`[work] could not install skill ${name}: ${(e as Error).message}`);
      }
      continue;
    }

    if (existing.isSymbolicLink()) {
      try {
        const target = readlinkSync(dst);
        if (target === src) {
          installed.push(name);
        } else {
          console.warn(`[work] skill ${name}: existing symlink points elsewhere (${target}) — leaving alone`);
        }
      } catch {
        console.warn(`[work] skill ${name}: could not read existing symlink — leaving alone`);
      }
    } else {
      console.warn(`[work] skill ${name}: ~/.claude/skills/${name} exists and is not a symlink — leaving alone`);
    }
  }

  return installed;
}

// Returns the absolute path to the bundled skills directory, regardless of whether
// it currently exists (the skills land in later tasks). daemon.ts calls this once.
export function bundledSkillsDir(srcDir: string): string {
  return join(srcDir, '..', 'outpost', 'skills');
}

// Internal helper for tests — exposes the resolved user skills dir.
export function userSkillsDir(): string {
  return join(homedir(), '.claude', 'skills');
}

// Surfaced as a re-export so callers don't need a separate import.
export { existsSync };
