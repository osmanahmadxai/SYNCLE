/**
 * A replay FROM Redis, deeper than one page.
 *
 * Redis has no order to page by. The replay paged it like a table anyway —
 * "keys greater than the last one" — and the Redis adapter reads any filter on
 * `key` as a glob, so page two was "the keys that contain the last key of page
 * one": that one key. The job then finished, `completed`, with the first 200
 * keys of the database copied and not a word about the rest. The pair matrix
 * never saw it because it replays five rows.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let jobs: any;
let redis: string;
let pgDest: string;
let redisDest: string;
const cleanups: Array<() => Promise<void>> = [];

const source = (commands: string[]) =>
  withAdapter('redis', (a) => a.query(commands.join('\n')));

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  jobs = app.ctx.get(BridgeJobService);
  redis = await connectionFor(app, 'redis');
  pgDest = await connectionFor(app, 'postgres_dest');
  redisDest = await connectionFor(app, 'redis_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function seed(prefix: string, count: number): Promise<void> {
  const lines = Array.from(
    { length: count },
    (_, i) => `SET ${prefix}:${String(i).padStart(5, '0')} v${i}`,
  );
  for (let i = 0; i < lines.length; i += 100)
    await source(lines.slice(i, i + 100));
  cleanups.push(async () => {
    const keys = Array.from(
      { length: count },
      (_, i) => `${prefix}:${String(i).padStart(5, '0')}`,
    );
    for (let i = 0; i < keys.length; i += 100)
      await source([`DEL ${keys.slice(i, i + 100).join(' ')}`]);
  });
}

async function replay(input: Record<string, unknown>): Promise<any> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      transform: { template: '{{$row}}' },
      trigger: { kind: 'replay' },
      ...input,
    }),
  );
  const started = await jobs.start(bridge.id);
  return waitFor(
    `replay ${started.id}`,
    async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j && ['completed', 'failed'].includes(j.status) ? j : null;
    },
    { timeoutMs: 90_000 },
  );
}

describe('a replay from Redis', () => {
  it('copies every key, however many pages that is — and none of Syncle’s own', async () => {
    const prefix = uniqueTable('rr');
    await seed(prefix, 1250);
    const dest = uniqueTable('rr_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );

    const job = await replay({
      name: `it-${dest}`,
      // a filter on `key` is a glob for Redis: only this test's keys
      source: {
        kind: 'table',
        connectionId: redis,
        table: 'keys',
        filters: [{ column: 'key', operator: 'contains', value: `${prefix}:` }],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            keyColumns: ['id'],
            mapping: [
              { source: 'key', target: 'id' },
              { source: 'value', target: 'name' },
            ],
            createMissingTable: true,
          },
        ],
      },
      delivery: { batchSize: 100, pageSize: 200 },
    });
    expect(job.status).toBe('completed');
    expect(job.failedCount).toBe(0);

    const rows = await withAdapter('postgres_dest', (a) =>
      a.query(`SELECT id, name FROM "${dest}" ORDER BY id`),
    );
    expect(rows.rows).toHaveLength(1250);
    expect(rows.rows[0]).toMatchObject({ id: `${prefix}:00000`, name: 'v0' });
    expect(rows.rows[1249]).toMatchObject({
      id: `${prefix}:01249`,
      name: 'v1249',
    });
  }, 180_000);

  it('with no key filter, leaves out the queues Syncle keeps in the same Redis', async () => {
    const prefix = uniqueTable('ro');
    await seed(prefix, 30);
    const dest = uniqueTable('ro_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    // the test app runs its job queue on this very Redis: by now it holds bull:* keys
    const own = await withAdapter('redis', (a) =>
      a.query('KEYS bull:bridge-jobs:*'),
    );
    expect(String(own.rows[0]?.reply ?? '')).toContain('bull:bridge-jobs:');

    await replay({
      name: `it-${dest}`,
      source: { kind: 'table', connectionId: redis, table: 'keys' },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            keyColumns: ['id'],
            mapping: [{ source: 'key', target: 'id' }],
            createMissingTable: true,
          },
        ],
      },
      delivery: { batchSize: 100 },
    });
    const ids = (await destRows('postgres_dest', dest)).map((r) =>
      String(r.id),
    );
    expect(ids.filter((id) => id.startsWith(`${prefix}:`))).toHaveLength(30);
    expect(
      ids.filter((id) => id.startsWith('bull:') || id.startsWith('syncle:')),
    ).toEqual([]);
  }, 180_000);

  it('copies a list and a sorted set WHOLE: the grid’s 25-entry preview is not what gets replayed', async () => {
    const prefix = uniqueTable('rl');
    const members = Array.from({ length: 60 }, (_, i) => `m${i}`);
    await source([
      `RPUSH ${prefix}:list ${members.join(' ')}`,
      `ZADD ${prefix}:zset ${members.map((m, i) => `${i} ${m}`).join(' ')}`,
    ]);
    cleanups.push(() =>
      source([`DEL ${prefix}:list ${prefix}:zset`]).then(() => undefined),
    );
    const dest = uniqueTable('rl_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );

    // an HTTP-shaped look at the rows would do too; a jsonb column keeps the arrays as arrays
    await withAdapter('postgres_dest', (a) =>
      a.query(`CREATE TABLE "${dest}" (id text PRIMARY KEY, body jsonb)`),
    );
    const job = await replay({
      name: `it-${dest}`,
      source: {
        kind: 'table',
        connectionId: redis,
        table: 'keys',
        filters: [{ column: 'key', operator: 'contains', value: `${prefix}:` }],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            keyColumns: ['id'],
            mapping: [
              { source: 'key', target: 'id' },
              { source: 'value', target: 'body' },
            ],
            createMissingTable: false,
          },
        ],
      },
    });
    expect(job.status, job.error).toBe('completed');
    expect(job.failedCount).toBe(0);
    const rows = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT id, jsonb_array_length(body) AS n FROM "${dest}" ORDER BY id`,
      ),
    );
    expect(rows.rows.map((r) => [r.id, Number(r.n)])).toEqual([
      [`${prefix}:list`, 60],
      // members and scores, interleaved
      [`${prefix}:zset`, 120],
    ]);
  }, 180_000);

  it('into Redis, too', async () => {
    const prefix = uniqueTable('r2r');
    await seed(prefix, 430);
    await withAdapter('redis_dest', (a) => a.query('FLUSHDB'));
    const job = await replay({
      name: `it-${prefix}`,
      source: {
        kind: 'table',
        connectionId: redis,
        table: 'keys',
        filters: [{ column: 'key', operator: 'contains', value: `${prefix}:` }],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: redisDest,
            table: 'keys',
            keyColumns: ['key'],
            mapping: [],
            createMissingTable: true,
          },
        ],
      },
      delivery: { batchSize: 50 },
    });
    expect(job.status, job.error).toBe('completed');
    const size = await withAdapter('redis_dest', (a) => a.query('DBSIZE'));
    expect(Number(size.rows[0]?.reply)).toBe(430);
  }, 180_000);
});
