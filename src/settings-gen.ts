import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface DaemonSettingsOpts {
  outPath: string;
  hookPort: number;
}

// Loopback HTTP hook entry; claude refuses non-loopback URLs for SSRF safety.
function loopbackHook(hookPort: number, route: string, timeout: number) {
  return {
    matcher: '',
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${hookPort}${route}`,
        timeout,
        headers: { 'X-Daemon-Auth': '$DAEMON_AUTH' },
        allowedEnvVars: ['DAEMON_AUTH'],
      },
    ],
  };
}

export function writeDaemonSettings(opts: DaemonSettingsOpts): void {
  const cfg = {
    hooks: {
      PreToolUse: [loopbackHook(opts.hookPort, '/hook/pretool', 600)],
      Stop: [loopbackHook(opts.hookPort, '/hook/stop', 30)],
    },
  };
  writeFileSync(opts.outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
