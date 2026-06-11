import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDaemonSettings } from '../../src/settings-gen.js';

describe('writeDaemonSettings', () => {
  it('writes a valid JSON file with the loopback hook URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'));
    const path = join(dir, 'daemon-settings.json');
    writeDaemonSettings({
      outPath: path,
      hookPort: 8444,
    });
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const entry = j.hooks.PreToolUse[0];
    expect(entry.matcher).toBe('');
    const hook = entry.hooks[0];
    expect(hook.type).toBe('http');
    expect(hook.url).toBe('http://127.0.0.1:8444/hook/pretool');
    expect(hook.headers['X-Daemon-Auth']).toBe('$DAEMON_AUTH');
    expect(hook.allowedEnvVars).toContain('DAEMON_AUTH');
    expect(hook.timeout).toBe(600);
  });
});
