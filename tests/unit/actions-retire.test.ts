import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureActionsInstalled } from '../../src/actions/install.js';
import { bundleHash, readBundleState, writeBundleState } from '../../src/actions/bundle-sync.js';
import { ActionRevisionsStore } from '../../src/storage/action-revisions-store.js';
import { ActionRegistry } from '../../src/actions/registry.js';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

let repo: string;
let runtime: string;
const dstWait = () => join(runtime, 'actions', 'meta', 'wait');
const retired = () => join(runtime, 'actions', '.retired', 'meta', 'wait');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'retire-repo-'));
  runtime = mkdtempSync(join(tmpdir(), 'retire-rt-'));
  mkdirSync(join(repo, 'actions', 'meta'), { recursive: true });
});

// What an older daemon left behind: an installed copy, with or without its baseline recorded.
function installOld(skill: string, baseline?: string): void {
  mkdirSync(dstWait(), { recursive: true });
  writeFileSync(join(dstWait(), 'SKILL.md'), skill);
  writeBundleState(runtime, { version: 1, baselines: baseline ? { 'meta/wait': baseline } : {}, editedLocally: [] });
}

const sync = () => ensureActionsInstalled(repo, runtime, () => {}, new ActionRevisionsStore(join(runtime, 'action-revisions')));

describe('retiring meta.wait', () => {
  it('removes an unedited copy and forgets its baseline', () => {
    installOld('v1\n');
    writeBundleState(runtime, { version: 1, baselines: { 'meta/wait': bundleHash(dstWait()) }, editedLocally: [] });
    sync();
    expect(existsSync(dstWait())).toBe(false);
    expect(existsSync(retired())).toBe(false);
    expect(readBundleState(runtime).baselines['meta/wait']).toBeUndefined();
  });

  it('moves an edited copy to .retired, keeping the edit, and forgets its baseline', () => {
    installOld('mine\n', 'baseline-of-v1');
    sync();
    expect(existsSync(dstWait())).toBe(false);
    expect(readFileSync(join(retired(), 'SKILL.md'), 'utf8')).toBe('mine\n');
    expect(readBundleState(runtime).baselines['meta/wait']).toBeUndefined();
  });

  it.skipIf(!hasGit)('with no baseline, removes a copy matching a version the repo once committed', () => {
    const git = (...args: string[]) => execFileSync('git', [
      '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { stdio: 'ignore' });
    mkdirSync(join(repo, 'actions', 'meta', 'wait'));
    writeFileSync(join(repo, 'actions', 'meta', 'wait', 'SKILL.md'), 'v1\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'v1');
    git('rm', '-rq', 'actions/meta/wait');
    git('commit', '-qm', 'drop');
    mkdirSync(join(repo, 'actions'), { recursive: true });
    installOld('v1\n');

    sync();
    expect(existsSync(dstWait())).toBe(false);
    expect(existsSync(retired())).toBe(false);
  });

  it('never loads a .retired copy as an action', () => {
    installOld('mine\n', 'baseline-of-v1');
    sync();
    expect(new ActionRegistry(join(runtime, 'actions')).load().actions).toBe(0);
  });
});
