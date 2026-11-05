import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../../src/db/adapters/sqlite.js';

const FIXTURE = new URL('./fixtures/sqlite-commit-loop.ts', import.meta.url).pathname;
const K = 5;
const dir = mkdtempSync(join(tmpdir(), 'outpost-crash-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// SIGKILLs a process mid-commit-loop and returns the highest commit it reported done.
async function killMidLoop(file: string): Promise<number> {
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let acked = -1;
  let seen = 0;
  let isKilling = false;
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      for (const m of d.toString().matchAll(/ok (\d+)/g)) { acked = Number(m[1]); seen++; }
      if (seen < 20 || isKilling) return;
      isKilling = true;
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, Math.random() * 30);
    });
    child.on('exit', (code) => { if (seen < 20) reject(new Error(`commit loop exited early (${code}): ${stderr}`)); });
  });
  await new Promise((r) => child.once('close', r));
  return acked;
}

describe('sqlite crash durability', () => {
  it('leaves every commit whole or absent, and keeps every acked one, after SIGKILL', async () => {
    for (let run = 0; run < 3; run++) {
      const file = join(dir, `crash-${run}.db`);
      const acked = await killMidLoop(file);

      const b = await openSqlite(file);
      const records = [];
      for await (const r of b.dump()) records.push(r);
      await b.close();

      const receipts = new Set(records.flatMap((r) => r.t === 'receipt' ? [r.receipt.commandId] : []));
      const rows = records.flatMap((r) => r.t === 'row' ? [r.row.key] : []);
      const events = records.flatMap((r) => r.t === 'event' ? [r.event] : []);

      for (let i = 0; i <= acked; i++) expect(receipts.has(`c${i}`)).toBe(true);
      for (const id of receipts) {
        expect(rows.filter((k) => k.startsWith(`${id}-`))).toHaveLength(K);
        expect(events.filter((e) => e.commandId === id)).toHaveLength(K);
      }
      for (const key of rows) expect(receipts.has(key.split('-')[0]!)).toBe(true);
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, k) => k + 1));
    }
  }, 60_000);
});
