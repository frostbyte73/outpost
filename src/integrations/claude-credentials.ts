import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface StoredOAuth {
  serverName?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface ClaudeCredentials {
  claudeAiOauth?: { accessToken?: string };
  mcpOAuth?: Record<string, StoredOAuth>;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// A keychain ACL prompt would otherwise hold this open indefinitely.
const KEYCHAIN_TIMEOUT_MS = 3000;

const execFileAsync = promisify(execFile);

// Reads Claude Code's stored OAuth blob: the login keychain on macOS, a plain file elsewhere
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  try {
    const raw = process.platform === 'darwin' ? await readKeychain() : await readCredentialsFile();
    return JSON.parse(raw) as ClaudeCredentials;
  } catch {
    return null;
  }
}

async function readKeychain(): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS },
  );
  return stdout;
}

function readCredentialsFile(): Promise<string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return readFile(join(configDir, '.credentials.json'), 'utf8');
}
