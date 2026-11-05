import { openSqlite } from '../../../../src/db/adapters/sqlite.js';

const K = 5;
const backend = await openSqlite(process.argv[2]!);
await backend.migrate();
const { epoch } = await backend.acquireLease({ holderId: 'crash', holderAddr: 'x' }, { force: false });

for (let i = 0; ; i++) {
  const keys = Array.from({ length: K }, (_, k) => `c${i}-${k}`);
  await backend.commit({
    epoch,
    receipt: { commandId: `c${i}`, kind: 'test', issuerKind: 'system', issuerId: 'crash', receivedAt: i, status: 'ok', result: null },
    puts: keys.map((key) => ({ collection: 'jobs', key, doc: { i } })),
    deletes: [],
    events: keys.map((key) => ({ aggregate: 'job', aggregateId: key, kind: 'k', who: 'crash', body: { i }, at: i })),
    changes: [],
  });
  process.stdout.write(`ok ${i}\n`);
}
