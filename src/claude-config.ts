import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// claude code persists per-project metadata under projects[<cwd>] in ~/.claude.json.
// The bit we care about is `lastModelUsage`, whose KEYS are the model ids the user has
// run in that project (e.g. "claude-opus-4-7", "claude-opus-4-7[1m]"). The `[1m]`
// suffix marks the 1M-context variant of Opus — but it appears only in this config
// file, not in the streaming API responses, which strip it. So this is the only signal
// we have from outside the running claude process for picking 200k vs 1M when no
// statusLine payload exists (the statusLine hook doesn't fire in --print mode, which
// is how the daemon spawns claude).
//
// Read lazily and cached against the file's mtime so the daemon doesn't re-parse a
// ~100KB JSON blob on every /api/sessions call but still picks up new [1m] entries
// claude writes when a session ends.

const CLAUDE_JSON = join(homedir(), '.claude.json');

interface ProjectsMap {
  [cwd: string]: { lastModelUsage?: Record<string, unknown> } | undefined;
}

let cached: { mtimeMs: number; ctxWindowByCwd: Map<string, number> } | null = null;

function load(): Map<string, number> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(CLAUDE_JSON).mtimeMs;
  } catch {
    return new Map();
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.ctxWindowByCwd;

  const out = new Map<string, number>();
  try {
    const raw = readFileSync(CLAUDE_JSON, 'utf8');
    const obj = JSON.parse(raw) as { projects?: ProjectsMap };
    const projects = obj.projects ?? {};
    for (const [cwd, proj] of Object.entries(projects)) {
      if (!proj?.lastModelUsage) continue;
      const usesOneM = Object.keys(proj.lastModelUsage).some((id) => id.endsWith('[1m]'));
      if (usesOneM) out.set(cwd, 1_000_000);
    }
  } catch {
    // Bad JSON or unreadable — return whatever we had; PWA will fall back to the
    // per-model default (200k) so a corrupt config never breaks the meter.
    if (cached) return cached.ctxWindowByCwd;
  }
  cached = { mtimeMs, ctxWindowByCwd: out };
  return out;
}

export function readProjectContextWindow(cwd: string): number | null {
  return load().get(cwd) ?? null;
}
