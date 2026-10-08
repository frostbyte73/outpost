import type { RecordedRead } from '../storage/action-runs-store.js';
import type { RunOutput } from './run-output.js';

// A live replay. Registered for the life of one `claude --print`, so the hook and MCP routes
// can tell an eval session from a real one by id alone.
export interface EvalSession {
  sessionId: string;
  evalId: string;
  action: string;
  worktree?: string;
  scratchDir: string;
  reads: Map<string, RecordedRead>;
  misses: number;
  captured: RunOutput[];
}

export class EvalSessions {
  private readonly byId = new Map<string, EvalSession>();

  register(s: EvalSession): void { this.byId.set(s.sessionId, s); }
  get(sessionId: string): EvalSession | undefined { return this.byId.get(sessionId); }
  drop(sessionId: string): void { this.byId.delete(sessionId); }
}
