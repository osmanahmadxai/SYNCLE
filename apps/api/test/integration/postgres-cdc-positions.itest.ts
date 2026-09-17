/**
 * Where a Postgres change "is" in the stream — the thing the cursor records,
 * the dedupe compares and the server is told to forget up to. Every test here
 * is a way that went wrong with nothing erroring:
 *
 *  - rows loaded by COPY share ONE position per WAL record (a couple of hundred
 *    rows each). a cursor that is just that position cannot tell them apart, so
 *    once a batch boundary fell inside a record the rest of it read as "already
 *    processed"
 *  - the replication client confirms `lsn + 1`. a transaction's end position is
 *    already "one past its last byte", so the extra byte reaches INTO whatever
 *    comes next — and when that is another transaction's commit record,
 *    Postgres considers that transaction confirmed too and never sends it again
 *  - a stop in the middle of a large transaction has to resume in the middle:
 *    the server re-sends the whole transaction, and only the part not yet
 *    delivered may go through
 *
 * Small batches throughout, so a few hundred rows span many deliveries.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter, sleep } from './harness';

const ENV_BEFORE = { batch: process.env.SYNCLE_CDC_BATCH_SIZE };
process.env.SYNCLE_CDC_BATCH_SIZE = '50';

import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

const PG = {
  host: '127.0.0.1',
  port: 55432,
  user: 'syncle',
  password: 'syncle',
  database: 'syncle_test',
};
const POISON = 'POISON';

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
  if (ENV_BEFORE.batch === undefined) delete process.env.SYNCLE_CDC_BATCH_SIZE;
  else process.env.SYNCLE_CDC_BATCH_SIZE = ENV_BEFORE.batch;
});

const src = (sql: string, params?: unknown[]) =>
  withAdapter('postgres', (a) => a.query(sql, params));
const dst = (sql: string, params?: unknown[]) =>
  withAdapter('postgres_dest', (a) => a.query(sql, params));

const dstIds = (table: string): Promise<number[]> =>
  dst(`SELECT id FROM "${table}" ORDER BY id`).then(
    (r) => r.rows.map((row) => Number(row.id)),
    () => [],
  );

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * a bridge into a destination table created up front, so it can carry a CHECK
 * constraint: the way to make one particular write fail, on demand
 */
async function bridge(opts: { rejectPoison?: boolean } = {}): Promise<{
  bridgeId: string;
  source: string;
  dest: string;
}> {
  const source = uniqueTable('pgp_src');
  const dest = uniqueTable('pgp_dst');
  await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
  await dst(
    `CREATE TABLE "${dest}" (id integer PRIMARY KEY, name text` +
      (opts.rejectPoison
        ? `, CONSTRAINT "${dest}_ok" CHECK (name <> '${POISON}')`
        : '') +
      ')',
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
      name: `it-pgp-${source}`,
      source: { kind: 'table', connectionId: srcConn, table: source },
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
  return { bridgeId: created.id, source, dest };
}

const job = (bridgeId: string) =>
  app.prisma.bridgeJob.findFirstOrThrow({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });

const paused = (bridgeId: string) =>
  waitFor('the bridge to pause', async () => {
    const j = await job(bridgeId);
    return j.status === 'paused' ? j : null;
  });

/** rows written by successful deliveries — more than the table holds = re-sent */
const deliveredRows = async (bridgeId: string): Promise<number> => {
  const jobs = await app.prisma.bridgeJob.findMany({
    where: { bridgeId },
    select: { id: true },
  });
  const sum = await app.prisma.bridgeDelivery.aggregate({
    where: { jobId: { in: jobs.map((j) => j.id) }, status: 'success' },
    _sum: { rowCount: true },
  });
  return sum._sum.rowCount ?? 0;
};

describe('rows that share one position', () => {
  it('delivers every row of a COPY, which writes hundreds of rows per WAL record', async () => {
    const b = await bridge();
    // the test database's user is a superuser, so the server can run `seq`
    await src(`COPY "${b.source}" (id) FROM PROGRAM 'seq 1 3000'`);

    const ids = await waitFor(
      'all 3000 rows',
      async () => {
        const got = await dstIds(b.dest);
        return got.length >= 3000 ? got : null;
      },
      { timeoutMs: 60_000 },
    ).catch(async () => dstIds(b.dest));
    // 3000 rows in batches of 50: nearly every boundary falls inside a record
    expect(ids.length).toBe(3000);
    expect(ids).toEqual(range(1, 3000));
    // and each was delivered once, not re-sent to make the number come out
    expect(await deliveredRows(b.bridgeId)).toBe(3000);
  });

  it('resumes inside a COPY after a stop, without losing or repeating rows', async () => {
    const b = await bridge({ rejectPoison: true });
    // one transaction: 400 good rows by COPY, then a row the destination refuses
    const { Client } = await import('pg');
    const c = new Client(PG);
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`COPY "${b.source}" (id) FROM PROGRAM 'seq 1 400'`);
      await c.query(`INSERT INTO "${b.source}" VALUES (401, '${POISON}')`);
      await c.query(`COPY "${b.source}" (id) FROM PROGRAM 'seq 402 600'`);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }

    await paused(b.bridgeId);
    // everything before the bad batch is in; nothing from beyond it
    const before = await dstIds(b.dest);
    expect(before).toEqual(range(1, 400));

    await dst(`ALTER TABLE "${b.dest}" DROP CONSTRAINT "${b.dest}_ok"`);
    await app.cdc.start(b.bridgeId);
    const ids = await waitFor('all 600 rows', async () => {
      const got = await dstIds(b.dest);
      return got.length >= 600 ? got : null;
    });
    expect(ids).toEqual(range(1, 600));
    // the server re-sent the transaction from its start. rows 1..400 were
    // already delivered and must have been recognised, not written again
    expect(await deliveredRows(b.bridgeId)).toBe(600);
  });
});

describe('a restart between two transactions that committed back to back', () => {
  it('still receives the second one', async () => {
    const b = await bridge({ rejectPoison: true });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'already there')`);
    await waitFor('row 1', async () =>
      (await dstIds(b.dest)).length === 1 ? true : null,
    );

    // T1 inserts, T2 updates (a different operation, so a separate delivery).
    // both are fully written before either commits, and the two COMMITs go out
    // together: their commit records sit next to each other in the WAL
    const { Client } = await import('pg');
    const t1 = new Client(PG);
    const t2 = new Client(PG);
    await t1.connect();
    await t2.connect();
    try {
      await t1.query('BEGIN');
      await t1.query(`INSERT INTO "${b.source}" VALUES (2, 'first to commit')`);
      await t2.query('BEGIN');
      await t2.query(
        `UPDATE "${b.source}" SET name = '${POISON}' WHERE id = 1`,
      );
      await t1.query('COMMIT');
      await t2.query('COMMIT');
    } finally {
      await t1.end();
      await t2.end();
    }

    // T1 is delivered and confirmed to the server; T2 fails and stops the bridge
    await paused(b.bridgeId);
    expect(await dstIds(b.dest)).toEqual([1, 2]);

    // confirming one byte past T1 told Postgres that T2 was done as well. it
    // was not: it has to come back after the restart
    await dst(`ALTER TABLE "${b.dest}" DROP CONSTRAINT "${b.dest}_ok"`);
    await app.cdc.start(b.bridgeId);
    await waitFor(
      'the second transaction',
      async () => {
        const r = await dst(`SELECT name FROM "${b.dest}" WHERE id = 1`);
        return r.rows[0]?.name === POISON ? true : null;
      },
      { timeoutMs: 15_000 },
    );
  });
});

describe('a bridge that has been idle since it started', () => {
  it('keeps its connection: the server is answered even with nothing to confirm yet', async () => {
    const b = await bridge();
    const errors: string[] = [];
    const logger = (
      app.cdc as unknown as { logger: { warn: (m: string) => void } }
    ).logger;
    const warn = logger.warn.bind(logger);
    logger.warn = (m: string) => {
      if (m.includes(b.bridgeId)) errors.push(m);
      warn(m);
    };
    try {
      // wal_sender_timeout is 5s in the test server: two timeouts' worth of idle
      await sleep(11_000);
    } finally {
      logger.warn = warn;
    }
    expect(errors).toEqual([]);

    await src(`INSERT INTO "${b.source}" VALUES (1, 'after the quiet')`);
    await waitFor('the row', async () =>
      (await dstIds(b.dest)).length === 1 ? true : null,
    );
  });
});
