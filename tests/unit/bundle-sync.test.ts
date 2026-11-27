import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureActionsInstalled } from '../../src/actions/install.js';
import { readBundleState, readLocalEdits } from '../../src/actions/bundle-sync.js';
import { ActionRevisionsStore } from '../../src/storage/action-revisions-store.js';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

let repo: string;
let runtime: string;
const srcAction = () => join(repo, 'actions', 'meta', 'orchestrate');
const dstAction = () => join(runtime, 'actions', 'meta', 'orchestrate');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bundle-repo-'));
  runtime = mkdtempSync(join(tmpdir(), 'bundle-rt-'));
  writeAction(srcAction(), 'v1', '{"bash":["git status"]}');
});

function writeAction(dir: string, skill: string, allowlist: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `${skill}\n`);
  writeFileSync(join(dir, 'allowlist.json'), `${allowlist}\n`);
}

const sync = () => ensureActionsInstalled(repo, runtime, () => {}, new ActionRevisionsStore(join(runtime, 'action-revisions')));
const installed = (f: string) => readFileSync(join(dstAction(), f), 'utf8');

describe('bundled action sync', () => {
  it('updates an unedited copy when only allowlist.json changed upstream', () => {
    sync();
    writeFileSync(join(srcAction(), 'allowlist.json'), '{"bash":["git log"]}\n');
    sync();
    expect(installed('allowlist.json')).toBe('{"bash":["git log"]}\n');
    expect(readLocalEdits(runtime)).toEqual([]);
  });

  it('keeps an edited copy, reporting it only once the repo has moved past it', () => {
    sync();
    writeFileSync(join(dstAction(), 'allowlist.json'), '{"bash":["mine"]}\n');
    sync();
    expect(readLocalEdits(runtime)).toEqual([]);

    writeFileSync(join(srcAction(), 'SKILL.md'), 'v2\n');
    sync();
    expect(installed('allowlist.json')).toBe('{"bash":["mine"]}\n');
    expect(installed('SKILL.md')).toBe('v1\n');
    expect(readLocalEdits(runtime)).toEqual(['meta.orchestrate']);
  });

  it('re-seeds rather than reports a copy swapped in before the state was written', () => {
    sync();
    const before = readBundleState(runtime).baselines['meta/orchestrate'];
    writeFileSync(join(srcAction(), 'SKILL.md'), 'v2\n');
    rmSync(dstAction(), { recursive: true });
    cpSync(srcAction(), dstAction(), { recursive: true });
    sync();
    expect(readLocalEdits(runtime)).toEqual([]);
    expect(readBundleState(runtime).baselines['meta/orchestrate']).not.toBe(before);
  });

  it.skipIf(!hasGit)('on first boot, updates a copy matching a committed bundle and reports one that matches none', () => {
    const git = (...args: string[]) => execFileSync('git', [
      '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'v1');
    const v1 = mkdtempSync(join(tmpdir(), 'bundle-v1-'));
    cpSync(srcAction(), v1, { recursive: true });
    writeFileSync(join(srcAction(), 'SKILL.md'), 'v2\n');
    git('commit', '-qam', 'v2');

    cpSync(v1, dstAction(), { recursive: true });
    sync();
    expect(installed('SKILL.md')).toBe('v2\n');

    const other = join(runtime, 'actions', 'meta', 'other');
    writeAction(join(repo, 'actions', 'meta', 'other'), 'o2', '{}');
    git('add', '-A');
    git('commit', '-qm', 'other');
    writeAction(other, 'hand-written', '{}');
    sync();
    expect(readFileSync(join(other, 'SKILL.md'), 'utf8')).toBe('hand-written\n');
    expect(readLocalEdits(runtime)).toEqual(['meta.other']);
  });
});
