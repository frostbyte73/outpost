import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export function screenshotsDir(runtimeDir: string): string {
  return join(runtimeDir, 'screenshots');
}

// Always overwritten: a stale or tampered copy must not survive a restart.
export function installScreenshotTool(runtimeDir: string, repoDir: string): string {
  const bin = join(runtimeDir, 'bin');
  const shots = screenshotsDir(runtimeDir);
  mkdirSync(bin, { recursive: true });
  mkdirSync(shots, { recursive: true, mode: 0o700 });
  const playwright = createRequire(join(repoDir, 'package.json')).resolve('@playwright/test');
  const script = join(bin, 'outpost-screenshot.mjs');
  writeAtomic(script, readFileSync(join(repoDir, 'src/permissions/screenshot/capture.mjs'), 'utf8'), 0o644);
  writeAtomic(join(bin, 'outpost-screenshot'), [
    '#!/bin/sh',
    `OUTPOST_SCREENSHOT_PLAYWRIGHT=${sq(playwright)} OUTPOST_SCREENSHOTS_DIR=${sq(shots)} exec ${sq(process.execPath)} ${sq(script)} "$@"`,
    '',
  ].join('\n'), 0o755);
  return bin;
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
