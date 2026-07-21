import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalStore } from '../../src/storage/journal-store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'outpost-journal-'));
}

function entry(lesson: string, at: number) {
  return JSON.stringify({ at, jobId: 'j1', action: 'meta.plan-job', outcome: 'ok', lesson });
}

describe('JournalStore legacy meta.plan-job migration', () => {
  it('renames the legacy journal to the new action name when only the legacy one exists', () => {
    const dir = tempDir();
    const legacyPath = join(dir, 'meta.plan-job.jsonl');
    writeFileSync(legacyPath, entry('old lesson 1', 1) + '\n' + entry('old lesson 2', 2) + '\n');

    const store = new JournalStore(dir);

    expect(existsSync(legacyPath)).toBe(false);
    const recent = store.recent('meta.orchestrate');
    expect(recent.map((e) => e.lesson)).toEqual(['old lesson 1', 'old lesson 2']);
  });

  it('appends legacy lessons onto an existing new-name journal and removes the legacy file', () => {
    const dir = tempDir();
    const legacyPath = join(dir, 'meta.plan-job.jsonl');
    const currentPath = join(dir, 'meta.orchestrate.jsonl');
    writeFileSync(legacyPath, entry('legacy lesson', 1) + '\n');
    writeFileSync(currentPath, entry('new lesson', 2) + '\n');

    const store = new JournalStore(dir);

    expect(existsSync(legacyPath)).toBe(false);
    const recent = store.recent('meta.orchestrate');
    expect(recent.map((e) => e.lesson)).toEqual(['new lesson', 'legacy lesson']);
    expect(readFileSync(currentPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('is a no-op when no legacy journal exists', () => {
    const dir = tempDir();
    const store = new JournalStore(dir);
    expect(store.recent('meta.orchestrate')).toEqual([]);
  });
});
