import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const BRANCH = 'main';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const IDLE_POLL_MS = 30 * 1000;

export type UpdatePhase = 'idle' | 'checking' | 'applying' | 'restart-pending';

export interface UpdateStatus {
  phase: UpdatePhase;
  current: string | null;
  latest: string | null;
  latestSubject: string | null;
  behind: number;
  // Why the checkout can't fast-forward; null when it can.
  blocked: string | null;
  error: string | null;
  checkedAt: number | null;
  // Running sessions/evals the queued restart is waiting out.
  waitingOn: number;
  // False under `npm start`: nothing would bring the daemon back, so it pulls but never exits.
  supervised: boolean;
  autoUpdate: boolean;
}

type CoreStatus = Omit<UpdateStatus, 'waitingOn' | 'supervised' | 'autoUpdate'>;

export interface UpdaterDeps {
  repoDir: string;
  supervised: boolean;
  getAuto: () => boolean;
  setAuto: (v: boolean) => void;
  busyCount: () => number;
  restart: () => void;
  onChange: (s: UpdateStatus) => void;
  installDeps?: (repoDir: string) => Promise<void>;
}

// Whether an exit is a restart (KeepAlive / Restart=always); an inherited $OUTPOST_API_URL means a nested dev daemon
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OUTPOST_API_URL) return false;
  return (!!env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0') || !!env.INVOCATION_ID;
}

// Keeps the daemon's checkout on origin/main, restarting once no session is mid-turn
export class Updater {
  private s: CoreStatus = {
    phase: 'idle', current: null, latest: null, latestSubject: null, behind: 0,
    blocked: null, error: null, checkedAt: null,
  };
  private timers: NodeJS.Timeout[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UpdaterDeps) {}

  start(): void {
    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS).unref());
    this.timers.push(setInterval(() => void this.check(), CHECK_INTERVAL_MS).unref());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.clearIdleTimer();
  }

  status(): UpdateStatus {
    return {
      ...this.s,
      waitingOn: this.s.phase === 'restart-pending' ? this.deps.busyCount() : 0,
      supervised: this.deps.supervised,
      autoUpdate: this.deps.getAuto(),
    };
  }

  async check(): Promise<UpdateStatus> {
    if (this.s.phase === 'checking' || this.s.phase === 'applying') return this.status();
    const prev = this.s.phase;
    this.set({ phase: 'checking' });
    try {
      await this.git('fetch', '--quiet', 'origin', BRANCH);
      const [current, latest, latestSubject, behind, blocked] = await Promise.all([
        this.git('rev-parse', '--short', 'HEAD'),
        this.git('rev-parse', '--short', `origin/${BRANCH}`),
        this.git('log', '-1', '--format=%s', `origin/${BRANCH}`),
        this.git('rev-list', '--count', `HEAD..origin/${BRANCH}`).then(Number),
        this.blockedReason(),
      ]);
      this.set({ phase: prev, current, latest, latestSubject, behind, blocked, error: null, checkedAt: Date.now() });
    } catch (e) {
      this.set({ phase: prev, error: `check failed: ${(e as Error).message}`, checkedAt: Date.now() });
      return this.status();
    }
    if (this.deps.getAuto() && this.canApply()) await this.apply();
    return this.status();
  }

  async apply(): Promise<UpdateStatus> {
    if (!this.canApply()) return this.status();
    const prev = this.s.phase;
    this.set({ phase: 'applying' });
    try {
      // Re-read: the tree may have changed since the last check.
      const blocked = await this.blockedReason();
      if (blocked) {
        this.set({ phase: prev, blocked });
        return this.status();
      }
      const before = await this.git('rev-parse', 'HEAD');
      await this.git('merge', '--ff-only', '--quiet', `origin/${BRANCH}`);
      const changed = await this.git('diff', '--name-only', before, 'HEAD', '--', 'package-lock.json');
      if (changed) await (this.deps.installDeps ?? npmCi)(this.deps.repoDir);
      const current = await this.git('rev-parse', '--short', 'HEAD');
      this.set({ phase: 'restart-pending', current, behind: 0, error: null });
    } catch (e) {
      this.set({ phase: prev, error: `update failed: ${(e as Error).message}` });
      return this.status();
    }
    this.armRestart();
    return this.status();
  }

  async setAuto(on: boolean): Promise<UpdateStatus> {
    this.deps.setAuto(on);
    this.emit();
    if (on && this.canApply()) return this.apply();
    return this.status();
  }

  private canApply(): boolean {
    return this.s.behind > 0 && !this.s.blocked && (this.s.phase === 'idle' || this.s.phase === 'restart-pending');
  }

  private async blockedReason(): Promise<string | null> {
    const branch = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== BRANCH) return `checkout is on ${branch}, not ${BRANCH}`;
    if (await this.git('status', '--porcelain', '--untracked-files=no')) return 'checkout has uncommitted changes';
    try {
      await this.git('merge-base', '--is-ancestor', 'HEAD', `origin/${BRANCH}`);
    } catch {
      return `checkout has commits that aren't on origin/${BRANCH}`;
    }
    return null;
  }

  private armRestart(): void {
    if (!this.deps.supervised || this.idleTimer) return;
    const tick = (): void => {
      const busy = this.deps.busyCount();
      if (busy === 0) {
        this.clearIdleTimer();
        this.deps.restart();
        return;
      }
      this.emit();
    };
    this.idleTimer = setInterval(tick, IDLE_POLL_MS);
    this.idleTimer.unref();
    tick();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private set(patch: Partial<CoreStatus>): void {
    this.s = { ...this.s, ...patch };
    this.emit();
  }

  private emit(): void {
    this.deps.onChange(this.status());
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileP('git', args, {
      cwd: this.deps.repoDir,
      timeout: 60_000,
      // A credential or host-key prompt would hang the fetch forever under launchd.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
    });
    return stdout.trim();
  }
}

async function npmCi(repoDir: string): Promise<void> {
  // launchd's PATH may not carry npm; it sits next to the node binary running us.
  const PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`;
  await execFileP('npm', ['ci', '--no-audit', '--no-fund'], { cwd: repoDir, timeout: 10 * 60_000, env: { ...process.env, PATH } });
}
