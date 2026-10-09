import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updater, isSupervised, type UpdaterDeps } from '../../src/update/updater.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function commit(dir: string, file: string, body: string, msg: string): void {
  writeFileSync(join(dir, file), body);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
}

let root: string;
let origin: string;
let upstream: string;
let install: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-updater-'));
  origin = join(root, 'origin.git');
  upstream = join(root, 'upstream');
  install = join(root, 'install');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
  git(upstream, 'remote', 'add', 'origin', origin);
  commit(upstream, 'a.txt', '1', 'first');
  commit(upstream, 'package-lock.json', '{}', 'lock');
  git(upstream, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install]);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function make(over: Partial<UpdaterDeps> = {}) {
  let auto = false;
  const deps = {
    repoDir: install,
    supervised: true,
    getAuto: () => auto,
    setAuto: (v: boolean) => { auto = v; },
    busyCount: () => 0,
    restart: vi.fn(),
    onChange: vi.fn(),
    installDeps: vi.fn(async () => {}),
    ...over,
  };
  return { updater: new Updater(deps), deps };
}

describe('Updater', () => {
  it('reports how far behind origin/main the checkout is', async () => {
    commit(upstream, 'a.txt', '2', 'second');
    commit(upstream, 'a.txt', '3', 'third');
    git(upstream, 'push', '-q', 'origin', 'main');
    const { updater } = make();
    const s = await updater.check();
    expect(s.behind).toBe(2);
    expect(s.latestSubject).toBe('third');
    expect(s.blocked).toBeNull();
  });

  it('blocks on uncommitted changes, a non-main branch, or local commits', async () => {
    commit(upstream, 'a.txt', '2', 'second');
    git(upstream, 'push', '-q', 'origin', 'main');
    const { updater } = make();

    writeFileSync(join(install, 'a.txt'), 'dirty');
    expect((await updater.check()).blocked).toMatch(/uncommitted/);
    git(install, 'checkout', '-q', '--', 'a.txt');

    git(install, 'checkout', '-q', '-b', 'feature');
    expect((await updater.check()).blocked).toMatch(/feature/);
    git(install, 'checkout', '-q', 'main');

    commit(install, 'b.txt', 'x', 'local');
    const s = await updater.check();
    expect(s.blocked).toMatch(/commits/);
    expect((await updater.apply()).phase).toBe('idle');
  });

  it('fast-forwards, installs only when the lockfile moved, then restarts once idle', async () => {
    commit(upstream, 'a.txt', '2', 'second');
    git(upstream, 'push', '-q', 'origin', 'main');
    let busy = 1;
    const { updater, deps } = make({ busyCount: () => busy });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await updater.check();
    const s = await updater.apply();
    expect(s.phase).toBe('restart-pending');
    expect(s.waitingOn).toBe(1);
    expect(git(install, 'rev-parse', 'HEAD')).toBe(git(upstream, 'rev-parse', 'HEAD'));
    expect(deps.installDeps).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();

    busy = 0;
    vi.advanceTimersByTime(30_000);
    expect(deps.restart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(deps.restart).toHaveBeenCalledTimes(1);

    commit(upstream, 'package-lock.json', '{"v":2}', 'bump');
    git(upstream, 'push', '-q', 'origin', 'main');
    await updater.check();
    await updater.apply();
    expect(deps.installDeps).toHaveBeenCalledTimes(1);
  });

  it('pulls but never exits when unsupervised', async () => {
    commit(upstream, 'a.txt', '2', 'second');
    git(upstream, 'push', '-q', 'origin', 'main');
    const { updater, deps } = make({ supervised: false });
    await updater.check();
    expect((await updater.apply()).phase).toBe('restart-pending');
    expect(deps.restart).not.toHaveBeenCalled();
  });

  it('applies on check when auto-update is on, and on enabling it while behind', async () => {
    commit(upstream, 'a.txt', '2', 'second');
    git(upstream, 'push', '-q', 'origin', 'main');
    const { updater, deps } = make();
    expect((await updater.check()).phase).toBe('idle');
    expect((await updater.setAuto(true)).phase).toBe('restart-pending');
    expect(deps.restart).toHaveBeenCalledTimes(1);

    commit(upstream, 'a.txt', '3', 'third');
    git(upstream, 'push', '-q', 'origin', 'main');
    await updater.check();
    expect(git(install, 'rev-parse', 'HEAD')).toBe(git(upstream, 'rev-parse', 'HEAD'));
  });

  it('surfaces a fetch failure as an error, not a throw', async () => {
    git(install, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const s = await make().updater.check();
    expect(s.error).toMatch(/check failed/);
    expect(s.phase).toBe('idle');
  });
});

describe('isSupervised', () => {
  it('reads launchd and systemd markers', () => {
    expect(isSupervised({ XPC_SERVICE_NAME: 'local.outpost.dc' })).toBe(true);
    expect(isSupervised({ XPC_SERVICE_NAME: '0' })).toBe(false);
    expect(isSupervised({ INVOCATION_ID: 'abc' })).toBe(true);
    expect(isSupervised({})).toBe(false);
    expect(isSupervised({ XPC_SERVICE_NAME: 'local.outpost.dc', OUTPOST_API_URL: 'http://127.0.0.1:8080' })).toBe(false);
  });
});
