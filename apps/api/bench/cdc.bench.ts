/**
 * End-to-end change data capture: a row committed on a source database, read
 * from that database's own change log, and written to a destination — measured
 * from the moment the writes begin until the last row has landed.
 *
 * The mode comes from BENCH_MODE, because the settings under test are read once
 * at import: the runner invokes this file twice with different environments and
 * each pass contributes its rows to the same suite.
 *
 *   batched  (defaults)                — the shipped configuration
 *   spool    SYNCLE_CDC_SPOOL=on       — the same, with the durable spool on
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  bootstrapApp,
  connectionFor,
  makeBridge,
  rowsFor,
  writeSourceRows,
  type AppHandle,
} from '../test/integration/app-harness';
import { TEST_CONNECTIONS, waitFor, withAdapter } from '../test/integration/harness';
import { bootstrapDrivers, createAdapter } from '@syncle/core/adapters';
import { MongoClient } from 'mongodb';
import {
  captureEnvironment,
  makeResult,
  publishSuite,
  resourceDetail,
  ResourceSampler,
  type BenchResult,
} from './harness';

type Engine = 'postgres' | 'mysql' | 'mongodb' | 'redis';
/** destinations use their own databases — see TEST_CONNECTIONS for why */
type Dest = 'postgres_dest' | 'mysql_dest' | 'mongodb' | 'sqlite' | 'redis_dest';

const LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgres_dest: 'PostgreSQL',
  mysql: 'MySQL',
  mysql_dest: 'MySQL',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  redis: 'Redis',
  redis_dest: 'Redis',
};

const MODE = (process.env.BENCH_MODE ?? 'batched') as 'batched' | 'spool';
const ROWS = Number(process.env.BENCH_ROWS ?? 1_000_000);
const CHUNK = 25_000;

let app: AppHandle;
let mongo: MongoClient | null = null;
const results: BenchResult[] = [];

/**
 * Document count. `exact` runs countDocuments, which is a COLLECTION SCAN —
 * fine once at the end, ruinous as a progress check: polling it every 100ms
 * against a growing collection had MongoDB scanning hundreds of thousands of
 * documents continuously while it was being measured, which distorts the
 * result and contributed to an OOM. Progress uses the O(1) metadata estimate
 * instead, and the exact count is taken once, at the end.
 */
async function mongoCount(collection: string, exact = false): Promise<number> {
  const conn = TEST_CONNECTIONS.mongodb!;
  mongo ??= await new MongoClient(
    `mongodb://${conn.host}:${conn.port}/?directConnection=true`,
  ).connect();
  const c = mongo.db(conn.database).collection(collection);
  return exact ? c.countDocuments() : c.estimatedDocumentCount();
}
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
}, 300_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await mongo?.close().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  publishSuite(
    MODE === 'spool'
      ? {
          id: 'cdc-spool',
          name: 'With the durable spool',
          description:
            'The same sync, with SYNCLE_CDC_SPOOL=on. Changes go to a Redis ' +
            'stream first and the source is acknowledged as soon as they are ' +
            'durably spooled, so a slow destination cannot hold the source’s ' +
            'log open. It costs throughput; that is the trade it exists to make.',
          results,
        }
      : {
      id: 'cdc-throughput',
      name: 'Change data capture, end to end',
      description:
        'A row is committed on the source, picked up from that database’s own ' +
        'change log (Postgres logical replication, MySQL binlog) and written to ' +
        'the destination. Timing starts when the writes begin and stops when the ' +
        'last row has landed, so it includes reading the log, delivery and the ' +
        'destination write. Every run is verified complete and duplicate-free ' +
        'before its time is recorded.',
      results,
    },
    await captureEnvironment(),
  );
});

/** run one source → destination pass and record it */
async function measure(
  source: Engine,
  dest: Dest,
  label: string,
  rowCount: number = ROWS,
): Promise<void> {
  console.log(`  → ${label}: preparing bridge…`);
  const srcConn = await connectionFor(app, source);
  const dstConn = await connectionFor(app, dest);
  const s = await makeBridge(app, {
    sourceEngine: source,
    destEngine: dest,
    sourceConnId: srcConn,
    destConnId: dstConn,
    cleanups,
  });

  let peakSpool = 0;
  let spool: any = null;
  if (MODE === 'spool') {
    const { CdcSpoolService } = await import('../src/bridges/cdc/cdc-spool.service');
    spool = app.ctx.get(CdcSpoolService);
    cleanups.push(() => spool.clear(s.bridgeId).catch(() => undefined));
  }
  const watch = spool
    ? setInterval(() => {
        void spool
          .depth(s.bridgeId)
          .then((d: number) => {
            if (d > peakSpool) peakSpool = d;
          })
          .catch(() => undefined);
      }, 200)
    : null;

  const sampler = new ResourceSampler();
  sampler.start();
  // ONE long-lived connection for polling. Opening a fresh adapter per poll
  // (which withAdapter does) costs a connect and a close every time — on
  // Postgres that dominated the measurement and made a 0.2s sync look like 60s.
  bootstrapDrivers();
  const probe = createAdapter(TEST_CONNECTIONS[dest]!);
  await probe.connect();
  // An EXACT count. browse()'s total is an estimate on MySQL — it reads
  // information_schema.table_rows, which the adapter honestly flags as
  // estimated — so waiting for it to equal the row count never succeeds.
  const landedCount = async (): Promise<number> => {
    try {
      if (dest === 'mongodb') return await mongoCount(s.destTable);
      if (dest === 'redis_dest') {
        // { command, reply } — the count is the reply, not the first value
        const res = await probe.query('DBSIZE');
        const row = res.rows[0] as { reply?: unknown } | undefined;
        return Number(row?.reply ?? 0);
      }
      const q = dest.startsWith('mysql') ? '`' : '"';
      const res = await probe.query(`SELECT COUNT(*) AS c FROM ${q}${s.destTable}${q}`);
      return Number(Object.values(res.rows[0] ?? {})[0] ?? 0);
    } catch {
      return 0; // the sink creates the target on first write
    }
  };

  // Redis rows land as bare keys, so the key count is the row count — flush
  // first or a previous scenario's keys would be counted as this one's
  if (dest === 'redis_dest') {
    await withAdapter('redis_dest', (a) => a.query('FLUSHDB'));
  }

  console.log(`  → ${label}: writing ${rowCount} rows…`);
  const started = performance.now();
  for (let start = 0; start < rowCount; start += CHUNK) {
    const size = Math.min(CHUNK, rowCount - start);
    await writeSourceRows(source, s.sourceTable, rowsFor(source, size, start));
  }
  await waitFor(
    `${rowCount} rows to reach ${dest}`,
    async () => ((await landedCount()) === rowCount ? true : null),
    // Mongo's estimate updates lazily, and every poll is a round trip; a
    // slower cadence measures the pipeline rather than the polling
    { timeoutMs: 3_000_000, intervalMs: dest === 'mongodb' ? 1_000 : 100 },
  );
  const ms = Math.round(performance.now() - started);
  const usage = sampler.stop();
  if (watch) clearInterval(watch);

  // a throughput number is worthless if the data is wrong, so verify first
  const landed =
    dest === 'mongodb' ? await mongoCount(s.destTable, true) : await landedCount();
  await probe.close().catch(() => undefined);
  if (landed !== rowCount) throw new Error(`expected ${rowCount} rows, found ${landed}`);

  const detail: Record<string, string | number> = {
    verified: `${landed} rows, exactly once`,
    ...resourceDetail(usage, [source, dest]),
  };
  if (spool) detail['peak spool depth'] = peakSpool;
  results.push(makeResult(label, rowCount, ms, detail));
  console.log(`  ✓ ${label}: ${rowCount} rows in ${ms}ms (${Math.round(rowCount / (ms / 1000))}/s)`);

  // Stop this bridge before the next scenario starts. A stream left running
  // keeps decoding its source's log, so without this each scenario competes
  // with every scenario before it and the later numbers measure contention
  // rather than throughput.
  await app.cdc.stop(s.bridgeId).catch(() => undefined);
  await app.cdc.cleanup(s.bridgeId).catch(() => undefined);

  // And drop the data. Twenty scenarios of a million rows each, all left in
  // place until the end of the run, is tens of millions of rows sitting in
  // engines that share one host — it exhausted MongoDB's memory and had it
  // OOM-killed mid-run. Dropping here also keeps each measurement independent
  // of how much the scenarios before it left behind.
  await withAdapter(source, (a) => a.dropTable(s.sourceTable)).catch(() => undefined);
  if (dest === 'redis_dest') {
    await withAdapter(dest, (a) => a.query('FLUSHDB')).catch(() => undefined);
  } else {
    await withAdapter(dest, (a) => a.dropTable(s.destTable)).catch(() => undefined);
  }
}

describe(`cdc throughput — ${MODE}`, () => {
  if (MODE === 'spool') {
    it('postgres to postgres through the durable spool', async () => {
      await measure('postgres', 'postgres_dest', 'PostgreSQL → PostgreSQL');
    });
    return;
  }

  /**
   * Every source engine against every destination engine.
   *
   * SQLite is a destination only: it has no change-capture path for external
   * writers, so it cannot drive a bridge.
   *
   * Redis as a SOURCE rides keyspace notifications, which are fire-and-forget
   * pub/sub with no backlog — under a firehose the server drops what the
   * subscriber has not taken yet. It is therefore measured at a lower volume,
   * and the figure says what that path can carry rather than pretending it is
   * comparable to a durable log.
   */
  const SOURCES: Engine[] = ['postgres', 'mysql', 'mongodb', 'redis'];
  const DESTS: Dest[] = [
    'postgres_dest',
    'mysql_dest',
    'mongodb',
    'sqlite',
    'redis_dest',
  ];

  for (const source of SOURCES) {
    for (const dest of DESTS) {
      it(`${source} to ${dest}`, async () => {
        const rows = source === 'redis' ? Math.min(ROWS, 100_000) : ROWS;
        await measure(
          source,
          dest,
          `${LABEL[source]} → ${LABEL[dest]}`,
          rows,
        );
      });
    }
  }

});
