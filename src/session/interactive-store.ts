import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

// Which daemon-spawned sessions the user has taken the wheel on. Persisted because a
// kickstart landing mid-conversation must not bring the daemon back up resuming autopilot
// underneath a conversation the user thinks is still theirs.
export class InteractiveStore {
  private readonly on = new Set<string>();

  // path is optional so tests can use an in-memory store; the daemon always passes one.
  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: unknown };
      if (Array.isArray(parsed.sessions)) {
        for (const id of parsed.sessions) if (typeof id === 'string') this.on.add(id);
      }
    } catch {
      // Malformed file — start empty; the next persist overwrites cleanly.
    }
  }

  isInteractive(sessionId?: string): boolean {
    return !!sessionId && this.on.has(sessionId);
  }

  set(sessionId: string, on: boolean): void {
    const had = this.on.has(sessionId);
    if (on) this.on.add(sessionId);
    else this.on.delete(sessionId);
    if (had !== on) this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    atomicWrite(this.path, JSON.stringify({ sessions: [...this.on] }, null, 2) + '\n');
  }
}
