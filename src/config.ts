import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonConfig {
  runtimeDir: string;
  projectsRoot: string;
  httpsPort: number;
  hookPort: number;
  host: string | undefined;
  bindAddress: string | undefined;
  certPath: string | undefined;
  keyPath: string | undefined;
  approvalTimeoutMs: number;
  allowlistPath: string | undefined;
}

function readPort(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${envName} must be an integer in [1, 65535], got ${JSON.stringify(raw)}`);
  }
  return n;
}

function readMs(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${envName} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(): DaemonConfig {
  return {
    runtimeDir: process.env.OUTPOST_RUNTIME_DIR ?? join(homedir(), '.outpost'),
    projectsRoot: process.env.OUTPOST_PROJECTS_ROOT ?? join(homedir(), '.claude', 'projects'),
    httpsPort: readPort('OUTPOST_HTTPS_PORT', 8443),
    hookPort: readPort('OUTPOST_HOOK_PORT', 8444),
    host: process.env.OUTPOST_HOST,
    bindAddress: process.env.OUTPOST_BIND_ADDRESS,
    certPath: process.env.OUTPOST_CERT_PATH,
    keyPath: process.env.OUTPOST_KEY_PATH,
    approvalTimeoutMs: readMs('OUTPOST_APPROVAL_TIMEOUT_MS', 10 * 60 * 1000),
    allowlistPath: process.env.OUTPOST_ALLOWLIST_PATH,
  };
}
