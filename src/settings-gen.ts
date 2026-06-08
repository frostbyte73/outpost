import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface DaemonSettingsOpts {
  outPath: string;
  hookPort: number;
}

export function writeDaemonSettings(opts: DaemonSettingsOpts): void {
  const cfg = {
    hooks: {
      PreToolUse: [
        {
          // Empty matcher = match every tool (regex matchers are anchored against the tool name).
          matcher: '',
          hooks: [
            {
              // Loopback HTTP — claude's hook system refuses non-loopback URLs for SSRF safety,
              // so the hook callback runs against a plain-HTTP listener on 127.0.0.1 only.
              type: 'http',
              url: `http://127.0.0.1:${opts.hookPort}/hook/pretool`,
              timeout: 600,
              headers: { 'X-Daemon-Auth': '$DAEMON_AUTH' },
              allowedEnvVars: ['DAEMON_AUTH'],
            },
          ],
        },
      ],
    },
  };
  writeFileSync(opts.outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
