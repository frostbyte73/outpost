import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CURSOR_ALLOW = '{"permission":"allow"}';

export function cursorDeny(reason: string): string {
  return JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason });
}

// No `'` (it sits in sh -c '…'), and no `//` or `/*`: hooks.json is parsed as JSONC, and a stripped "comment" loads no hooks at all.
export const CURSOR_HOOK_SCRIPT = `if [ -z "\${DAEMON_AUTH:-}" ] || [ -z "\${OUTPOST_HOOK_PORT:-}" ]; then exit 1; fi
out=$(curl -sS -o - -w "\\n%{http_code}" --max-time "\${OUTPOST_HOOK_CURL_TIMEOUT_S:-600}" -H "x-daemon-auth: $DAEMON_AUTH" -H "x-outpost-session: \${OUTPOST_CURSOR_SESSION:-}" -H "content-type: application/json" --data-binary @- "127.0.0.1:$OUTPOST_HOOK_PORT/hook/cursor" 2>/dev/null)
if [ $? -ne 0 ]; then exit 1; fi
code=\${out##*
}
body=\${out%
*}
if [ "$code" != 200 ]; then exit 1; fi
case "$body" in
  "{\\"permission\\":\\"allow\\"}"|"{\\"permission\\":\\"deny\\""*) printf "%s\\n" "$body"; exit 0 ;;
esac
exit 1`;

export const CURSOR_HOOK_COMMAND = `sh -c '${CURSOR_HOOK_SCRIPT}'`;

// `^(?!MCP:)` leaves MCP to beforeMCPExecution, the one step that names the server.
export function hooksJson(timeoutSec: number): string {
  const hook = (extra: object) => [{ command: CURSOR_HOOK_COMMAND, ...extra, failClosed: true, timeout: timeoutSec }];
  return `${JSON.stringify({
    version: 1,
    hooks: {
      preToolUse: hook({ matcher: '^(?!MCP:)' }),
      beforeMCPExecution: hook({}),
      subagentStart: hook({}),
    },
  }, null, 2)}\n`;
}

// Must match the slug Cursor derives from the session cwd byte for byte, or it never finds the hooks file.
export function cursorProjectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

// `agent acp` reads project hooks from its data dir, not the workspace, keyed by the slug of the cwd it was given.
export function hookFilePaths(dataDir: string, cwd: string): string[] {
  return [...new Set([cwd, realpathSync(cwd)])].map((d) => join(dataDir, 'projects', cursorProjectSlug(d), '.cursor', 'hooks.json'));
}

export function installHooks(dataDir: string, cwd: string, text: string): void {
  for (const path of hookFilePaths(dataDir, cwd)) {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8');
      if (existing === text) continue;
      if (!isOurs(existing)) throw new Error(`a different Cursor hooks file is already at ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  }
}

export function hooksIntact(dataDir: string, cwd: string, text: string): boolean {
  return hookFilePaths(dataDir, cwd).every((p) => existsSync(p) && readFileSync(p, 'utf8') === text);
}

// A file whose every hook runs our command is ours, from an earlier launch with a different timeout.
function isOurs(text: string): boolean {
  try {
    const hooks = Object.values((JSON.parse(text) as { hooks?: Record<string, { command?: string }[]> }).hooks ?? {}).flat();
    return hooks.length > 0 && hooks.every((h) => h.command === CURSOR_HOOK_COMMAND);
  } catch {
    return false;
  }
}
