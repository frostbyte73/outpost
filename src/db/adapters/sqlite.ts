import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { AdapterOptions, Backend } from '../backend.js';
import { BOOTSTRAP_SQL } from '../migrate.js';
import { serialize, sqlBackend, type SqlConn, type SqlDialect, type SqlTx } from './sql.js';

const PRAGMAS: Array<[name: string, set: string, want: string | number]> = [
  ['journal_mode', 'WAL', 'wal'],
  ['synchronous', 'FULL', 2],
  ['fullfsync', 'ON', 1],
  ['checkpoint_fullfsync', 'ON', 1],
  ['busy_timeout', '5000', 5000],
];

const DIALECT: SqlDialect = {
  kind: 'sqlite',
  migrations: 'sqlite',
  migrationMode: 'tx',
  beginMigration: 'BEGIN IMMEDIATE',
  beginCommit: 'BEGIN IMMEDIATE',
  beginRead: 'BEGIN',
  fenceSql: 'SELECT * FROM cp_lease WHERE id = 1',
  leaseLockSql: 'SELECT * FROM cp_lease WHERE id = 1',
  jsonCast: '',
  parseJson: (v) => JSON.parse(String(v)),
  async insertMany(tx, table, cols, rows, onConflict = '') {
    const sql = `INSERT INTO ${table} (${cols.map(([c]) => c).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${onConflict}`;
    for (const row of rows) await tx.query(sql, row);
  },
};

// Opens (creating if needed) a sqlite store at `path`, or an in-memory one for ':memory:'.
export async function openSqlite(path: string, opts?: AdapterOptions): Promise<Backend> {
  const db = new DatabaseSync(path);
  for (const [name, set, want] of PRAGMAS) {
    db.exec(`PRAGMA ${name} = ${set}`);
    if (name === 'journal_mode' && path === ':memory:') continue;
    const got = Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    if (got !== want) {
      db.close();
      throw new Error(`sqlite pragma ${name} is ${String(got)}, want ${String(want)}`);
    }
  }
  db.exec(BOOTSTRAP_SQL);
  return sqlBackend(sqliteConn(db), DIALECT, opts);
}

function sqliteConn(db: DatabaseSync): SqlConn {
  const statements = new Map<string, StatementSync>();
  const tx: SqlTx = {
    async query(sql, params = []) {
      let stmt = statements.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
        statements.set(sql, stmt);
      }
      return stmt.all(...params.map((p) => (p ?? null) as SQLInputValue));
    },
    async exec(sql) { db.exec(sql); },
  };
  const locked = serialize();
  return {
    query: (sql, params) => locked(() => tx.query(sql, params)),
    exec: (sql) => locked(() => tx.exec(sql)),
    withTx: (begin, fn) => locked(async () => {
      db.exec(begin);
      try {
        const result = await fn(tx);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    }),
    close: async () => locked(async () => db.close()),
  };
}
