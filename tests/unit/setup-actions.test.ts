import { describe, it, expect } from 'vitest';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleActions } from '../../src/setup-actions.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeAction(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# stub\n');
}

describe('pruneStaleActions', () => {
  it('removes an installed action whose repo source is gone, plus its owned skill symlink', () => {
    const srcDir = tempDir('outpost-src-');
    const dstDir = tempDir('outpost-dst-');
    const skillsDir = tempDir('outpost-skills-');

    makeAction(join(srcDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'plan-job'));
    symlinkSync(join(dstDir, 'meta', 'orchestrate'), join(skillsDir, 'meta.orchestrate'), 'dir');
    symlinkSync(join(dstDir, 'meta', 'plan-job'), join(skillsDir, 'meta.plan-job'), 'dir');

    pruneStaleActions(srcDir, dstDir, skillsDir);

    expect(existsSync(join(dstDir, 'meta', 'plan-job'))).toBe(false);
    expect(existsSync(join(skillsDir, 'meta.plan-job'))).toBe(false);
  });

  it('leaves actions that still exist in the repo source untouched', () => {
    const srcDir = tempDir('outpost-src-');
    const dstDir = tempDir('outpost-dst-');
    const skillsDir = tempDir('outpost-skills-');

    makeAction(join(srcDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'orchestrate'));
    symlinkSync(join(dstDir, 'meta', 'orchestrate'), join(skillsDir, 'meta.orchestrate'), 'dir');

    pruneStaleActions(srcDir, dstDir, skillsDir);

    expect(existsSync(join(dstDir, 'meta', 'orchestrate'))).toBe(true);
    expect(existsSync(join(skillsDir, 'meta.orchestrate'))).toBe(true);
  });

  it('leaves an unrelated existing action in another category untouched', () => {
    const srcDir = tempDir('outpost-src-');
    const dstDir = tempDir('outpost-dst-');
    const skillsDir = tempDir('outpost-skills-');

    makeAction(join(srcDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'plan-job'));
    makeAction(join(srcDir, 'read', 'investigate'));
    makeAction(join(dstDir, 'read', 'investigate'));

    pruneStaleActions(srcDir, dstDir, skillsDir);

    expect(existsSync(join(dstDir, 'meta', 'plan-job'))).toBe(false);
    expect(existsSync(join(dstDir, 'read', 'investigate'))).toBe(true);
  });

  it('leaves a foreign symlink alone even if the action dir it named is pruned', () => {
    const srcDir = tempDir('outpost-src-');
    const dstDir = tempDir('outpost-dst-');
    const skillsDir = tempDir('outpost-skills-');
    const foreignDir = tempDir('outpost-foreign-');

    makeAction(join(srcDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'orchestrate'));
    makeAction(join(dstDir, 'meta', 'plan-job'));
    symlinkSync(foreignDir, join(skillsDir, 'meta.plan-job'), 'dir');

    pruneStaleActions(srcDir, dstDir, skillsDir);

    expect(existsSync(join(dstDir, 'meta', 'plan-job'))).toBe(false);
    const link = lstatSync(join(skillsDir, 'meta.plan-job'));
    expect(link.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(skillsDir, 'meta.plan-job'))).toBe(foreignDir);

    rmSync(foreignDir, { recursive: true, force: true });
  });

  it('prunes nothing when srcDir is missing', () => {
    const dstDir = tempDir('outpost-dst-');
    const skillsDir = tempDir('outpost-skills-');
    makeAction(join(dstDir, 'meta', 'plan-job'));

    pruneStaleActions(join(dstDir, 'does-not-exist'), dstDir, skillsDir);

    expect(existsSync(join(dstDir, 'meta', 'plan-job'))).toBe(true);
  });

  it('prunes nothing when srcDir is empty', () => {
    const srcDir = tempDir('outpost-src-');
    const dstDir = tempDir('outpost-dst-');
    const skillsDir = tempDir('outpost-skills-');
    makeAction(join(dstDir, 'meta', 'plan-job'));

    pruneStaleActions(srcDir, dstDir, skillsDir);

    expect(existsSync(join(dstDir, 'meta', 'plan-job'))).toBe(true);
  });
});
