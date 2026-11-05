import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEvent } from './types.js';

// A session's native and canonical streams, appended side by side for debugging a runtime adapter.
export interface NdjsonLog {
  native(frame: unknown): void;
  canonical(e: CanonicalEvent): void;
  close(): void;
}

const NOOP: NdjsonLog = { native() {}, canonical() {}, close() {} };
const SUFFIXES = ['.native.ndjson', '.canonical.ndjson'] as const;

export function openNdjsonLog(dir: string, sessionId: string): NdjsonLog {
  if (!/^[\w-]+$/.test(sessionId)) return NOOP;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    console.warn(`[runtime-log] ${sessionId.slice(0, 8)}: ${(e as Error).message} — logging off for this session`);
    return NOOP;
  }
  let broken = false;
  const streams = SUFFIXES.map((suffix) => {
    const s = createWriteStream(join(dir, `${sessionId}${suffix}`), { flags: 'a', mode: 0o600 });
    s.on('error', (e) => {
      if (broken) return;
      broken = true;
      console.warn(`[runtime-log] ${sessionId.slice(0, 8)}: ${e.message} — logging off for this session`);
    });
    return s;
  });
  let seq = 0;
  const append = (s: WriteStream, value: unknown) => {
    if (!broken) s.write(`${JSON.stringify({ ts: Date.now(), seq: seq++, value })}\n`);
  };
  return {
    native: (frame) => append(streams[0]!, frame),
    canonical: (e) => append(streams[1]!, e),
    close: () => { for (const s of streams) s.end(); },
  };
}

export function pruneNdjsonLogs(dir: string, maxAgeMs: number): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!SUFFIXES.some((s) => name.endsWith(s))) continue;
    const path = join(dir, name);
    try { if (statSync(path).mtimeMs < cutoff) rmSync(path); } catch { /* raced a delete */ }
  }
}

export function removeNdjsonLogs(dir: string, sessionId: string): void {
  if (!/^[\w-]+$/.test(sessionId)) return;
  for (const s of SUFFIXES) rmSync(join(dir, `${sessionId}${s}`), { force: true });
}
