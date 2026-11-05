import pg from 'pg';
import type { AdapterOptions, Backend } from '../backend.js';
import { BOOTSTRAP_SQL } from '../migrate.js';
import { serialize, sqlBackend, type SqlConn, type SqlDialect, type SqlTx } from './sql.js';

// CockroachDB becomes a sibling of this object: SERIALIZABLE, a 40001 retry, 'statements' migrations.
const POSTGRES: SqlDialect = {
  kind: 'postgres',
  migrations: 'pg',
  migrationMode: 'tx',
  beginMigration: 'BEGIN',
  beginCommit: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  beginRead: 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  fenceSql: 'SELECT * FROM cp_lease WHERE id = 1 FOR SHARE',
  leaseLockSql: 'SELECT * FROM cp_lease WHERE id = 1 FOR UPDATE',
  jsonCast: '::text::jsonb',
  parseJson: (v) => v,
  async insertMany(tx, table, cols, rows, onConflict = '') {
    if (rows.length === 0) return;
    const names = cols.map(([c]) => c).join(', ');
    const arrays = cols.map(([, type], i) => `$${i + 1}::${type === 'bigint' ? 'bigint' : 'text'}[]`).join(', ');
    const select = cols.map(([c, type]) => type === 'json' ? `${c}::jsonb` : c).join(', ');
    await tx.query(
      `INSERT INTO ${table} (${names}) SELECT ${select} FROM unnest(${arrays}) AS u(${names}) ${onConflict}`,
      cols.map((_, i) => rows.map((row) => row[i])));
  },
};

// Opens a Postgres store at a postgres:// URL; Neon must be its direct (non-pooler) endpoint.
export async function openPg(url: string, opts?: AdapterOptions): Promise<Backend> {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  // An idle client the server drops (Neon suspending, a restart) emits here; unhandled, it kills the process.
  pool.on('error', (err) => console.warn(`[store] idle postgres connection lost: ${err.message}`));
  const conn: SqlConn = {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => { await pool.query(sql); },
    async withTx(begin, fn) {
      const client = await pool.connect();
      const tx: SqlTx = {
        query: async (sql, params) => (await client.query(sql, params)).rows,
        exec: async (sql) => { await client.query(sql); },
      };
      try {
        await client.query(begin);
        const result = await fn(tx);
        await client.query('COMMIT');
        client.release();
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release(true);
        throw err;
      }
    },
    close: () => pool.end(),
  };
  await conn.exec(BOOTSTRAP_SQL);
  return sqlBackend(conn, POSTGRES, opts);
}

// Runs the same adapter SQL on PGlite (in-process, single connection, fsync off): tests only.
export async function openPglite(dataDir: string | undefined, opts?: AdapterOptions): Promise<Backend> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  const tx: SqlTx = {
    query: async (sql, params) => (await db.query<Record<string, unknown>>(sql, params)).rows,
    exec: async (sql) => { await db.exec(sql); },
  };
  const locked = serialize();
  const conn: SqlConn = {
    query: (sql, params) => locked(() => tx.query(sql, params)),
    exec: (sql) => locked(() => tx.exec(sql)),
    withTx: (begin, fn) => locked(async () => {
      await db.query(begin);
      try {
        const result = await fn(tx);
        await db.query('COMMIT');
        return result;
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
    }),
    close: () => locked(() => db.close()),
  };
  await conn.exec(BOOTSTRAP_SQL);
  return sqlBackend(conn, POSTGRES, opts);
}
