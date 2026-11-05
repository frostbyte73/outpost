import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RegisteredProject {
  cwd: string;       // absolute path
  addedAt: number;   // epoch ms
  // `<host>/<owner>/<repo>` from the origin remote; absent when the project has no origin.
  projectKey?: string;
}

// Normalizes a git remote URL (scp-style, ssh://, https://) to a lowercase `<host>/<path>` key.
export function projectKeyFromRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { return undefined; }
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(parsed.protocol)) return undefined;
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\/+/, '');
  }
  if (!host || path.split('/').filter(Boolean).length < 2) return undefined;
  return `${host}/${path}`.toLowerCase();
}

interface PersistedShape {
  projects: RegisteredProject[];
}

export class ProjectRegistry {
  private projects: RegisteredProject[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  list(): RegisteredProject[] {
    return [...this.projects];
  }

  // Returns true if newly added; false if cwd was already present (idempotent).
  add(cwd: string): boolean {
    if (this.projects.some((p) => p.cwd === cwd)) return false;
    const projectKey = originKey(cwd);
    this.projects.push({ cwd, addedAt: Date.now(), ...(projectKey ? { projectKey } : {}) });
    this.persist();
    return true;
  }

  // Returns true if removed; false if cwd was not in the registry.
  remove(cwd: string): boolean {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.cwd !== cwd);
    if (this.projects.length === before) return false;
    this.persist();
    return true;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (Array.isArray(parsed?.projects)) {
        this.projects = parsed.projects.filter(
          (p): p is RegisteredProject =>
            typeof p?.cwd === 'string' && typeof p?.addedAt === 'number',
        );
      }
    } catch {
      // Malformed file → treat as empty. Will be overwritten on next add().
      return;
    }
    let isBackfilled = false;
    for (const p of this.projects) {
      if (typeof p.projectKey === 'string') continue;
      const projectKey = originKey(p.cwd);
      if (projectKey) { p.projectKey = projectKey; isBackfilled = true; }
    }
    if (isBackfilled) this.persist();
  }

  // Atomic write: tmp file + renameSync, with 0o600 mode for security parity
  // with the allowlist files (these gate which projects the daemon will spawn into).
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    const payload: PersistedShape = { projects: this.projects };
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

function originKey(cwd: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return projectKeyFromRemote(url);
  } catch {
    return undefined;
  }
}
