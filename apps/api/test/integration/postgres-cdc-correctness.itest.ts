/**
 * The corners of PostgreSQL logical replication that a change stream gets wrong
 * quietly — nothing errors, the destination is simply no longer the source:
 *
 *  - an UPDATE that does not touch a large (TOASTed) column omits that column
 *    from the message; treating "omitted" as NULL wipes it downstream
 *  - an UPDATE of the primary key is a row MOVING: the old key has to go
 *  - TRUNCATE is a message of its own
 *  - a partitioned table's changes are reported under its PARTITIONS' names
 *    unless the publication asks otherwise
 *  - publishing UPDATE/DELETE for a table with no replica identity makes those
 *    statements FAIL at the source — starting a bridge must never do that
 *  - a DELETE carries only the replica-identity columns, so a destination keyed
 *    on anything else cannot be told which row to remove
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter, sleep } from './harness';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

let app: AppHandle;
let srcConn: string;
let dstConn: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  srcConn = await connectionFor(app, 'postgres');
  dstConn = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string, params?: unknown[]) =>
  withAdapter('postgres', (a) => a.query(sql, params));
const dst = (sql: string, params?: unknown[]) =>
  withAdapter('postgres_dest', (a) => a.query(sql, params));

/** rows of a destination table, [] while it does not exist yet */
const dstRows = (table: string, orderBy = 'id') =>
  dst(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).then(
    (r) => r.rows,
    () => [] as Record<string, unknown>[],
  );

async function bridge(opts: {
  ddl: string;
  table?: string;
  operations?: string[];
  keyColumns?: string[];
  mapping?: Array<{ source: string; target: string }>;
  start?: boolean;
}): Promise<{ bridgeId: string; source: string; dest: string }> {
  const source = opts.table ?? uniqueTable('pgc_src');
  const dest = uniqueTable('pgc_dst');
  await src(opts.ddl.replaceAll('$TABLE', `"${source}"`));
  cleanups.push(() =>
    src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
  );
  cleanups.push(() =>
    dst(`DROP TABLE IF EXISTS "${dest}"`).then(() => undefined),
  );

  const { bridgeInputSchema } = await import('@syncle/core');
  const created = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-pgc-${source}`,
      source: { kind: 'table', connectionId: srcConn, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: dstConn,
            table: dest,
            keyColumns: opts.keyColumns ?? ['id'],
            mapping: opts.mapping ?? [],
          },
        ],
      },
      transform: {},
      trigger: {
        kind: 'cdc',
        operations: opts.operations ?? ['insert', 'update', 'delete'],
      },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(created.id).catch(() => undefined);
    await app.cdc.cleanup(created.id).catch(() => undefined);
  });
  if (opts.start !== false) await app.cdc.start(created.id);
  return { bridgeId: created.id, source, dest };
}

const job = (bridgeId: string) =>
  app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });

/** ~13 KB that does not compress, so Postgres stores it out of line (TOAST) */
const BIG = `(SELECT string_agg(md5(g::text), '') FROM generate_series(1, 400) g)`;

describe('an UPDATE that leaves a large column alone', () => {
  it('does not wipe that column at the destination', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, status text, body text)',
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'new', ${BIG})`);
    await waitFor('the row', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );

    // touches `status` only: Postgres sends `body` as "unchanged, not included"
    await src(`UPDATE "${b.source}" SET status = 'done' WHERE id = 1`);
    await waitFor('the update', async () =>
      (await dstRows(b.dest))[0]?.status === 'done' ? true : null,
    );

    const want = (
      await src(`SELECT md5(body) AS h, length(body) AS n FROM "${b.source}"`)
    ).rows[0];
    const got = (
      await dst(`SELECT md5(body) AS h, length(body) AS n FROM "${b.dest}"`)
    ).rows[0];
    expect(got).toEqual(want); // it used to be { h: null, n: null }
    expect(Number(got!.n)).toBeGreaterThan(10_000);
  });

  it('nor when the columns are renamed by an explicit mapping', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, status text, body text)',
      mapping: [
        { source: 'id', target: 'id' },
        { source: 'status', target: 'state' },
        { source: 'body', target: 'payload' },
      ],
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'new', ${BIG})`);
    await waitFor('the row', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );
    await src(`UPDATE "${b.source}" SET status = 'done' WHERE id = 1`);
    await waitFor('the update', async () =>
      (await dstRows(b.dest))[0]?.state === 'done' ? true : null,
    );

    const got = (await dst(`SELECT length(payload) AS n FROM "${b.dest}"`))
      .rows[0];
    expect(Number(got!.n)).toBeGreaterThan(10_000);
  });

  it('still writes a large column that really was set to NULL', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, status text, body text)',
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'new', ${BIG})`);
    await waitFor('the row', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );
    await src(`UPDATE "${b.source}" SET body = NULL WHERE id = 1`);
    await waitFor('the null', async () =>
      (await dstRows(b.dest))[0]?.body === null ? true : null,
    );
  });
});

describe('an UPDATE that changes the primary key', () => {
  it('moves the row instead of leaving the old one behind', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, name text)',
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a'), (5, 'keep')`);
    await waitFor('two rows', async () =>
      (await dstRows(b.dest)).length === 2 ? true : null,
    );

    await src(`UPDATE "${b.source}" SET id = 2, name = 'moved' WHERE id = 1`);
    await waitFor('the move', async () => {
      const r = await dstRows(b.dest);
      return r.some((x) => Number(x.id) === 2) ? r : null;
    });
    await sleep(500);
    expect((await dstRows(b.dest)).map((r) => [Number(r.id), r.name])).toEqual([
      [2, 'moved'],
      [5, 'keep'],
    ]);
  });

  it('also under REPLICA IDENTITY FULL, where the old row arrives whole', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, name text); ALTER TABLE $TABLE REPLICA IDENTITY FULL',
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a')`);
    await waitFor('the row', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );
    await src(`UPDATE "${b.source}" SET id = 9 WHERE id = 1`);
    await waitFor('the move', async () => {
      const r = await dstRows(b.dest);
      return r.length === 1 && Number(r[0]!.id) === 9 ? r : null;
    });
    // an ordinary update must not be mistaken for a move. (it was: PostgreSQL
    // marks EVERY column of such a table as an identity column, so every update
    // "changed the identity" and was delivered as a DELETE followed by the
    // update — the end state the same, which is all this test used to look at)
    const opsSoFar = async () => {
      const j = await job(b.bridgeId);
      const all = await app.prisma.bridgeDelivery.findMany({
        where: { jobId: j.id },
        orderBy: { sequence: 'asc' },
      });
      return all.map((d: { op: string | null }) => d.op);
    };
    expect(await opsSoFar()).toEqual(['insert', 'delete', 'update']);
    await src(`UPDATE "${b.source}" SET name = 'b' WHERE id = 9`);
    await waitFor('the update', async () =>
      (await dstRows(b.dest))[0]?.name === 'b' ? true : null,
    );
    expect(await dstRows(b.dest)).toHaveLength(1);
    expect(await opsSoFar()).toEqual(['insert', 'delete', 'update', 'update']);
  });
});

describe('TRUNCATE', () => {
  it('is not mirrored unless asked for — but it is never silent', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, name text)',
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a'), (2, 'b')`);
    await waitFor('two rows', async () =>
      (await dstRows(b.dest)).length === 2 ? true : null,
    );

    await src(`TRUNCATE "${b.source}"`);
    const notice = await waitFor('a notice on the timeline', async () => {
      const j = await job(b.bridgeId);
      return app.prisma.bridgeDelivery.findFirst({
        where: {
          jobId: j.id,
          status: 'skipped',
          error: { contains: 'TRUNCATE' },
        },
      });
    });
    expect(notice.error).toMatch(/not applied to the destination/i);
    // destructive, and off by default: the destination keeps its rows
    expect(await dstRows(b.dest)).toHaveLength(2);
    // and the bridge goes on
    await src(`INSERT INTO "${b.source}" VALUES (3, 'c')`);
    await waitFor('the next row', async () =>
      (await dstRows(b.dest)).length === 3 ? true : null,
    );
  });

  it('empties the destination when the bridge captures truncates', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, name text)',
      operations: ['insert', 'update', 'delete', 'truncate'],
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a'), (2, 'b')`);
    await waitFor('two rows', async () =>
      (await dstRows(b.dest)).length === 2 ? true : null,
    );

    await src(`TRUNCATE "${b.source}"`);
    await waitFor('an empty destination', async () =>
      (await dstRows(b.dest)).length === 0 ? true : null,
    );

    // order holds around it: a row inserted after the truncate survives it
    await src(`INSERT INTO "${b.source}" VALUES (7, 'after')`);
    await waitFor('the row after', async () => {
      const r = await dstRows(b.dest);
      return r.length === 1 && Number(r[0]!.id) === 7 ? true : null;
    });
  });

  it('keeps its place among the rows of ONE transaction', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, name text)',
      operations: ['insert', 'update', 'delete', 'truncate'],
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'old')`);
    await waitFor('row 1', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );

    // a reload, the way people write it: empty the table and fill it again
    await src(
      `BEGIN; INSERT INTO "${b.source}" VALUES (2, 'gone too'); TRUNCATE "${b.source}"; ` +
        `INSERT INTO "${b.source}" VALUES (3, 'kept'), (4, 'kept'); COMMIT`,
    );
    const rows = await waitFor('the reloaded table', async () => {
      const r = await dstRows(b.dest);
      return r.length === 2 && Number(r[0]!.id) === 3 ? r : null;
    });
    expect(rows.map((r) => Number(r.id))).toEqual([3, 4]);
  });

  it('reaches an HTTP destination as an operation of its own', async () => {
    const http = await import('node:http');
    const seen: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        seen.push(JSON.parse(data));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;

    const source = uniqueTable('pgc_src');
    await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-pgc-${source}`,
        source: { kind: 'table', connectionId: srcConn, table: source },
        destination: { kind: 'http', url: `http://127.0.0.1:${port}/hook` },
        transform: { template: '{"op": "{{$op}}", "row": "{{$row}}"}' },
        trigger: { kind: 'cdc', operations: ['insert', 'truncate'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);

    await src(`INSERT INTO "${source}" VALUES (1, 'a')`);
    await src(`TRUNCATE "${source}"`);
    await waitFor('both deliveries', async () =>
      seen.length === 2 ? true : null,
    );
    expect(seen.map((b) => b.op)).toEqual(['insert', 'truncate']);
  });

  it('is refused on an engine that never reports one, instead of waiting for ever', async () => {
    const mysqlConn = await connectionFor(app, 'mysql');
    const table = uniqueTable('pgc_my');
    await withAdapter('mysql', (a) =>
      a.query(
        `CREATE TABLE \`${table}\` (id int PRIMARY KEY, name varchar(20))`,
      ),
    );
    cleanups.push(() =>
      withAdapter('mysql', (a) =>
        a.query(`DROP TABLE IF EXISTS \`${table}\``),
      ).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-pgc-${table}`,
        source: { kind: 'table', connectionId: mysqlConn, table },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: dstConn,
              table: uniqueTable('pgc_dst'),
              keyColumns: ['id'],
              mapping: [],
            },
          ],
        },
        transform: {},
        trigger: { kind: 'cdc', operations: ['insert', 'truncate'] },
      }),
    );
    cleanups.push(() => app.cdc.cleanup(created.id).catch(() => undefined));
    await expect(app.cdc.start(created.id)).rejects.toThrow(
      /does not report a TRUNCATE/,
    );
  });
});

describe('a partitioned table', () => {
  it('streams rows written to any of its partitions', async () => {
    const parent = uniqueTable('pgc_part');
    const b = await bridge({
      table: parent,
      ddl: `CREATE TABLE $TABLE (id integer, region text, name text, PRIMARY KEY (id, region)) PARTITION BY LIST (region);
            CREATE TABLE "${parent}_eu" PARTITION OF $TABLE FOR VALUES IN ('eu');
            CREATE TABLE "${parent}_us" PARTITION OF $TABLE FOR VALUES IN ('us')`,
      keyColumns: ['id', 'region'],
    });
    // changes are logged against the PARTITIONS; without
    // publish_via_partition_root they carry the partition's name and were
    // dropped as "another table", so a partitioned source streamed nothing
    await src(`INSERT INTO "${parent}" VALUES (1, 'eu', 'a'), (2, 'us', 'b')`);
    const rows = await waitFor('both rows', async () => {
      const r = await dstRows(b.dest, 'id');
      return r.length === 2 ? r : null;
    });
    expect(rows.map((r) => r.region)).toEqual(['eu', 'us']);

    await src(`UPDATE "${parent}" SET name = 'changed' WHERE id = 2`);
    await waitFor('the update', async () =>
      (await dstRows(b.dest, 'id'))[1]?.name === 'changed' ? true : null,
    );
    await src(`DELETE FROM "${parent}" WHERE id = 1`);
    await waitFor('the delete', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );
  });
});

describe('a table with no primary key', () => {
  const DDL = 'CREATE TABLE $TABLE (id integer, name text)';

  it('is refused for UPDATE/DELETE capture, and the source keeps working', async () => {
    const b = await bridge({ ddl: DDL, start: false });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a')`);

    await expect(app.cdc.start(b.bridgeId)).rejects.toThrow(
      /replica identity|primary key/i,
    );
    // the dangerous part: a publication that publishes updates for this table
    // makes THIS statement fail, in the user's own application
    await expect(
      src(`UPDATE "${b.source}" SET name = 'b' WHERE id = 1`),
    ).resolves.toBeDefined();
    await expect(
      src(`DELETE FROM "${b.source}" WHERE id = 1`),
    ).resolves.toBeDefined();
  });

  it('can still capture INSERTs, without breaking UPDATE and DELETE at the source', async () => {
    const b = await bridge({
      ddl: DDL,
      operations: ['insert'],
      keyColumns: ['id'],
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a')`);
    await waitFor('the insert', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );
    await expect(
      src(`UPDATE "${b.source}" SET name = 'b' WHERE id = 1`),
    ).resolves.toBeDefined();
    await expect(
      src(`DELETE FROM "${b.source}" WHERE id = 1`),
    ).resolves.toBeDefined();
  });
});

describe('a destination keyed on something other than the source’s primary key', () => {
  const DDL =
    'CREATE TABLE $TABLE (id integer PRIMARY KEY, email text NOT NULL UNIQUE, name text)';

  it('is refused for DELETE capture: a delete would not say which row it means', async () => {
    const b = await bridge({ ddl: DDL, keyColumns: ['email'], start: false });
    await expect(app.cdc.start(b.bridgeId)).rejects.toThrow(
      /REPLICA IDENTITY FULL/,
    );
  });

  it('works once the table sends whole rows, and the delete finds its row by email', async () => {
    const b = await bridge({
      ddl: `${DDL}; ALTER TABLE $TABLE REPLICA IDENTITY FULL`,
      keyColumns: ['email'],
    });
    await src(
      `INSERT INTO "${b.source}" VALUES (1, 'a@x.io', 'A'), (2, 'b@x.io', 'B')`,
    );
    await waitFor('two rows', async () =>
      (await dstRows(b.dest)).length === 2 ? true : null,
    );
    await src(`DELETE FROM "${b.source}" WHERE id = 1`);
    const rows = await waitFor('the delete', async () => {
      const r = await dstRows(b.dest);
      return r.length === 1 ? r : null;
    });
    expect(rows[0]!.email).toBe('b@x.io');
  });

  it('is fine without deletes', async () => {
    const b = await bridge({
      ddl: DDL,
      keyColumns: ['email'],
      operations: ['insert', 'update'],
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'a@x.io', 'A')`);
    await waitFor('the row', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );
  });
});

describe('concurrent transactions', () => {
  it('delivers a transaction that STARTED first but COMMITTED last', async () => {
    // Postgres tags every change with the WAL position it was written at, and
    // streams transactions in COMMIT order. so a long transaction's changes
    // arrive after a short one's, carrying LOWER positions. a watermark of
    // "highest position seen" throws them away as already processed.
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, name text)',
    });
    const { Client } = await import('pg');
    const opts = {
      host: '127.0.0.1',
      port: 55432,
      user: 'syncle',
      password: 'syncle',
      database: 'syncle_test',
    };
    const slow = new Client(opts);
    const fast = new Client(opts);
    await slow.connect();
    await fast.connect();
    try {
      await slow.query('BEGIN');
      await slow.query(
        `INSERT INTO "${b.source}" VALUES (1, 'started first, committed last')`,
      );
      // written later in the WAL, committed sooner
      await fast.query(`INSERT INTO "${b.source}" VALUES (2, 'in and out')`);
      await waitFor('the fast row', async () =>
        (await dstRows(b.dest)).length === 1 ? true : null,
      );
      await slow.query(
        `INSERT INTO "${b.source}" VALUES (3, 'same slow transaction')`,
      );
      await slow.query('COMMIT');
    } finally {
      await slow.end();
      await fast.end();
    }
    const rows = await waitFor(
      'all three rows',
      async () => {
        const r = await dstRows(b.dest);
        return r.length === 3 ? r : null;
      },
      { timeoutMs: 15_000 },
    );
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2, 3]);
  });
});

/**
 * Leaving an unchanged column out of the write is right for a table — and wrong
 * wherever the VALUE is needed. There it is read back from the source.
 */
describe('an unchanged large column, where leaving it out is not enough', () => {
  it('a row that moves to a new key takes the column with it', async () => {
    const b = await bridge({
      ddl: 'CREATE TABLE $TABLE (id integer PRIMARY KEY, status text, body text)',
    });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'new', ${BIG})`);
    await waitFor('the row', async () =>
      (await dstRows(b.dest)).length === 1 ? true : null,
    );

    // the key changes, `body` does not: Postgres sends neither the old row nor
    // `body`. the old key is deleted at the destination — and with it the only
    // copy of `body` there was
    await src(`UPDATE "${b.source}" SET id = 2 WHERE id = 1`);
    await waitFor('the move', async () => {
      const rows = await dstRows(b.dest);
      return rows.length === 1 && Number(rows[0]!.id) === 2 ? true : null;
    });
    const want = (await src(`SELECT md5(body) AS h FROM "${b.source}"`))
      .rows[0];
    const got = (await dst(`SELECT md5(body) AS h FROM "${b.dest}"`)).rows[0];
    expect(got).toEqual(want);
  });

  it('a source filter on that column still decides correctly', async () => {
    const source = uniqueTable('pgc_src');
    const dest = uniqueTable('pgc_dst');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, status text, body text)`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    cleanups.push(() =>
      dst(`DROP TABLE IF EXISTS "${dest}"`).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-pgc-${source}`,
        source: {
          kind: 'table',
          connectionId: srcConn,
          table: source,
          filters: [{ column: 'body', operator: 'startsWith', value: 'keep:' }],
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: dstConn,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
            },
          ],
        },
        transform: {},
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);

    await src(
      `INSERT INTO "${source}" VALUES (1, 'new', 'keep:' || ${BIG}), (2, 'new', 'drop:' || ${BIG})`,
    );
    await waitFor('row 1', async () =>
      (await dstRows(dest)).length === 1 ? true : null,
    );

    // neither update touches `body`, so neither message carries it
    await src(`UPDATE "${source}" SET status = 'done'`);
    await waitFor('the update', async () =>
      (await dstRows(dest))[0]?.status === 'done' ? true : null,
    );
    await sleep(800);
    const rows = await dstRows(dest);
    // row 2 never matched the filter: passing it for want of the value would
    // have created it here, without its body
    expect(rows.map((r) => Number(r.id))).toEqual([1]);
    expect(String(rows[0]!.body).startsWith('keep:')).toBe(true);
  });

  it('a key-value destination keeps the value it had', async () => {
    const source = uniqueTable('pgc_src');
    const redisConn = await connectionFor(app, 'redis_dest');
    await src(
      `CREATE TABLE "${source}" (id text PRIMARY KEY, body text, status text)`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-pgc-${source}`,
        source: { kind: 'table', connectionId: srcConn, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: redisConn,
              table: 'unused',
              keyColumns: ['key'],
              mapping: [
                { source: 'id', target: 'key' },
                { source: 'body', target: 'value' },
              ],
            },
          ],
        },
        transform: {},
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);

    const key = `${source}:1`;
    const redisValue = () =>
      withAdapter('redis_dest', async (a) => {
        const res = await a.query(`GET ${key}`);
        return (res.rows[0] as { reply?: unknown } | undefined)?.reply ?? null;
      });
    cleanups.push(() =>
      withAdapter('redis_dest', (a) => a.query(`DEL ${key}`)).then(
        () => undefined,
      ),
    );

    await src(`INSERT INTO "${source}" VALUES ('${key}', ${BIG}, 'new')`);
    await waitFor('the value', async () =>
      String((await redisValue()) ?? '').length > 10_000 ? true : null,
    );

    // a marker delivery AFTER the update, so there is something to wait for
    await src(`UPDATE "${source}" SET status = 'done' WHERE id = '${key}'`);
    await src(`INSERT INTO "${source}" VALUES ('${key}:after', 'x', 'new')`);
    cleanups.push(() =>
      withAdapter('redis_dest', (a) => a.query(`DEL ${key}:after`)).then(
        () => undefined,
      ),
    );
    await waitFor('the marker', async () =>
      withAdapter('redis_dest', async (a) => {
        const res = await a.query(`GET ${key}:after`);
        return (res.rows[0] as { reply?: unknown } | undefined)?.reply === 'x'
          ? true
          : null;
      }),
    );
    // SET replaces the value whole: written without `body`, it became ''
    expect(String((await redisValue()) ?? '').length).toBeGreaterThan(10_000);
  });

  it('an HTTP payload carries the column', async () => {
    const http = await import('node:http');
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          bodies.push(JSON.parse(data));
        } catch {
          bodies.push({ unparseable: data.slice(0, 200) });
        }
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;

    const source = uniqueTable('pgc_src');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, status text, body text)`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-pgc-${source}`,
        source: { kind: 'table', connectionId: srcConn, table: source },
        destination: { kind: 'http', url: `http://127.0.0.1:${port}/hook` },
        transform: {
          template:
            '{"id": "{{id}}", "status": "{{status}}", "size": "{{body}}"}',
        },
        trigger: { kind: 'cdc', operations: ['insert', 'update'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);

    await src(`INSERT INTO "${source}" VALUES (1, 'new', ${BIG})`);
    await waitFor('the insert', async () =>
      bodies.length === 1 ? true : null,
    );
    await src(`UPDATE "${source}" SET status = 'done' WHERE id = 1`);
    await waitFor('the update', async () =>
      bodies.length === 2 ? true : null,
    );

    expect(bodies[1]!.status).toBe('done');
    // not '', and not the text of a marker
    expect(String(bodies[1]!.size).length).toBeGreaterThan(10_000);
    expect(bodies[1]!.size).toBe(bodies[0]!.size);
  });
});
