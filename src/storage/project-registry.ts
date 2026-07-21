import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RegisteredProject {
  cwd: string;       // absolute path
  addedAt: number;   // epoch ms
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
    this.projects.push({ cwd, addedAt: Date.now() });
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
    }
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
