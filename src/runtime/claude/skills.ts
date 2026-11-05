import { homedir } from 'node:os';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDir, safeReaddir } from '../../actions/install.js';

// Claude Code loads skills from ~/.claude/skills, so each action is linked in as `<category>.<name>`.
export function deliverActionsAsSkills(actionsDir: string): void {
  const skillsDir = join(homedir(), '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const category of safeReaddir(actionsDir)) {
    const catDir = join(actionsDir, category);
    if (!isDir(catDir)) continue;
    for (const name of safeReaddir(catDir)) {
      const src = join(catDir, name);
      if (!isDir(src)) continue;
      linkOrLeaveAlone(src, join(skillsDir, `${category}.${name}`), `${category}.${name}`);
    }
  }
}

// Removes the flat skills symlink for a pruned action, but only if it's a symlink
// we created (points somewhere under ownedRoot) — real dirs or foreign symlinks are
// left alone.
export function pruneSkillSymlink(skillsDir: string, category: string, name: string, ownedRoot: string): void {
  const linkPath = join(skillsDir, `${category}.${name}`);
  let stat: ReturnType<typeof lstatSync> | null = null;
  try { stat = lstatSync(linkPath); } catch { return; }
  if (!stat.isSymbolicLink()) return;
  let target = '';
  try { target = readlinkSync(linkPath); } catch { return; }
  if (resolve(target) !== ownedRoot && !resolve(target).startsWith(ownedRoot + '/')) return;
  try {
    unlinkSync(linkPath);
    console.log(`[work] pruned stale skill symlink: ${linkPath}`);
  } catch (e) {
    console.warn(`[work] could not remove stale skill symlink ${linkPath}: ${(e as Error).message}`);
  }
}

// Force-resymlinks stale links we own; leaves real dirs alone.
function linkOrLeaveAlone(src: string, dst: string, label: string): void {
  let existing: ReturnType<typeof lstatSync> | null = null;
  try { existing = lstatSync(dst); } catch { /* missing */ }

  if (!existing) {
    try {
      symlinkSync(src, dst, 'dir');
      console.log(`[work] linked: ~/.claude/skills/${label} -> ${src}`);
    } catch (e) {
      console.warn(`[work] could not link ${label}: ${(e as Error).message}`);
    }
    return;
  }

  if (existing.isSymbolicLink()) {
    let target = '';
    try { target = readlinkSync(dst); } catch { /* unreadable */ }
    if (target === src) return;
    try {
      unlinkSync(dst);
      symlinkSync(src, dst, 'dir');
      console.log(`[work] relinked: ~/.claude/skills/${label} -> ${src} (was ${target || 'unreadable'})`);
    } catch (e) {
      console.warn(`[work] ${label}: could not replace stale symlink (${(e as Error).message}) — leaving alone`);
    }
    return;
  }

  console.warn(`[work] ${label}: ~/.claude/skills/${label} exists and is not a symlink — leaving alone`);
}
