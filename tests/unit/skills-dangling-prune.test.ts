import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverActionsAsSkills } from '../../src/runtime/claude/skills.js';

// The prune runs in the user's real ~/.claude/skills, so it must only ever take links it made.
let home: string;
let actionsDir: string;
let skillsDir: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skills-home-'));
  process.env.HOME = home;
  actionsDir = join(mkdtempSync(join(tmpdir(), 'skills-actions-')), 'actions');
  mkdirSync(join(actionsDir, 'meta', 'session'), { recursive: true });
  skillsDir = join(home, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => { process.env.HOME = savedHome; });

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

describe('deliverActionsAsSkills', () => {
  it('removes a dangling link into the actions dir, and leaves live and foreign links alone', () => {
    symlinkSync(join(actionsDir, 'meta', 'wait'), join(skillsDir, 'meta.wait'), 'dir');
    const foreign = mkdtempSync(join(tmpdir(), 'skills-foreign-'));
    symlinkSync(join(foreign, 'gone'), join(skillsDir, 'mine'), 'dir');

    deliverActionsAsSkills(actionsDir);

    expect(isLink(join(skillsDir, 'meta.wait'))).toBe(false);
    expect(isLink(join(skillsDir, 'mine'))).toBe(true);
    expect(existsSync(join(skillsDir, 'meta.session'))).toBe(true);
  });
});
