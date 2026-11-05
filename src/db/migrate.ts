import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { SqlConn } from './adapters/sql.js';

export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS cp_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1), holder_id TEXT NOT NULL, holder_addr TEXT NOT NULL,
  epoch BIGINT NOT NULL, acquired_at BIGINT NOT NULL);
`;

export interface MigrationDialect {
  migrations: 'sqlite' | 'pg';
  // 'statements' is CockroachDB's mode: it can't run mixed DDL in one transaction.
  migrationMode: 'tx' | 'statements';
  beginMigration: string;
}

// Applies pending migrations/<dialect>/NNNN_*.sql in order, one transaction each, refusing any drift.
export async function runMigrations(conn: SqlConn, d: MigrationDialect): Promise<void> {
  const dir = new URL(`./migrations/${d.migrations}/`, import.meta.url);
  const files = readdirSync(dir)
    .map((name) => ({ name, m: /^(\d{4})_(.+)\.sql$/.exec(name) }))
    .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, m }) => {
      const sql = readFileSync(new URL(name, dir), 'utf8');
      return { version: Number(m[1]), name: m[2]!, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });

  const applied = new Map((await conn.query('SELECT version, checksum FROM schema_migrations'))
    .map((r) => [Number(r.version), String(r.checksum)]));
  for (const version of applied.keys()) {
    if (!files.some((f) => f.version === version)) {
      throw new Error(`database has migration ${version} this build doesn't know; it was migrated by a newer outpost`);
    }
  }

  for (const f of files) {
    const prior = applied.get(f.version);
    if (prior !== undefined) {
      if (prior !== f.checksum) {
        throw new Error(`migration ${f.version}_${f.name} checksum changed (applied ${prior}, file ${f.checksum}); migrations are forward-only`);
      }
      continue;
    }
    if (d.migrationMode === 'statements') throw new Error('statement-by-statement migrations (cockroachdb) are not implemented');
    await conn.withTx(d.beginMigration, async (tx) => {
      await tx.exec(f.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
        [f.version, f.name, f.checksum, Date.now()]);
    });
  }
}
