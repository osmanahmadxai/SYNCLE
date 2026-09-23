/**
 * A table row, in Redis.
 *
 * A Redis destination had one shape — a column mapped onto `key`, a column
 * mapped onto `value`, `SET` — which keeps ONE column of a row. What a row is
 * put in Redis for is a hash per row, or the row as a JSON document, under the
 * key the application already builds, often with an expiry. And a row read
 * FROM Redis that was not a string (a hash, a list, a set, a sorted set)
 * arrived in another Redis as the text "[object Object]".
 *
 * What is looked at here is Redis itself, with a client of its own: the type
 * of each key, its fields, its expiry.
 */
import 'reflect-metadata';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sleep, uniqueTable, waitFor, withAdapter } from './harness';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

let app: AppHandle;
let controller: any;
let jobs: any;
/** the destination database (db 1), and the source one (db 0) */
let dest: Redis;
let src: Redis;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  controller = app.ctx.get(BridgesController);
  jobs = app.ctx.get(BridgeJobService);
  dest = new Redis({ host: '127.0.0.1', port: 56379, db: 1 });
  src = new Redis({ host: '127.0.0.1', port: 56379, db: 0 });
}, 120_000);

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse())
    await fn().catch(() => undefined);
});

afterAll(async () => {
  await dest?.quit().catch(() => undefined);
  await src?.quit().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const pg = (sql: string) => withAdapter('postgres', (a) => a.query(sql));

/** a source table with one of everything a row tends to hold */
async function people(): Promise<{ table: string; prefix: string }> {
  const table = uniqueTable('rd_people');
  await pg(
    `CREATE TABLE "${table}" (id integer PRIMARY KEY, name text, note text, balance numeric(12,2), active boolean, prefs jsonb, seen timestamptz, avatar bytea)`,
  );
  await pg(
    `INSERT INTO "${table}" VALUES
       (1, 'Ada', 'first', 12.50, true, '{"theme":"dark","tags":["a","b"]}', '2026-03-01 10:20:30.123+00', '\\x00ff10'),
       (2, 'Grace', NULL, 0, false, NULL, NULL, NULL)`,
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
  );
  const prefix = `rd:${table}`;
  cleanups.push(async () => {
    const keys = await dest.keys(`${prefix}:*`);
    if (keys.length) await dest.del(...keys);
  });
  return { table, prefix };
}

async function bridge(
  table: string,
  redis: Record<string, unknown> | undefined,
  extra: {
    trigger?: Record<string, unknown>;
    target?: Record<string, unknown>;
    delivery?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const created = await controller.create(
    bridgeInputSchema.parse({
      name: `it-rd-${table}-${Math.random().toString(36).slice(2, 7)}`,
      source: {
        kind: 'table',
        connectionId: await connectionFor(app, 'postgres'),
        table,
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: await connectionFor(app, 'redis_dest'),
            table: 'keys',
            ...(redis ? { redis } : {}),
            ...extra.target,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: extra.trigger ?? { kind: 'replay' },
      ...(extra.delivery ? { delivery: extra.delivery } : {}),
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(created.id).catch(() => undefined);
    await app.cdc.cleanup(created.id).catch(() => undefined);
    await controller.remove(created.id).catch(() => undefined);
  });
  return created.id as string;
}

async function replay(bridgeId: string): Promise<any> {
  const job = await jobs.start(bridgeId, { fresh: true });
  return waitFor('the replay', async () => {
    const j = await app.prisma.bridgeJob.findUnique({ where: { id: job.id } });
    return j && ['completed', 'failed'].includes(j.status) ? j : null;
  });
}

describe('a hash per row', () => {
  it('holds every column as a field, NULL as no field, and expires when it was told to', async () => {
    const { table, prefix } = await people();
    const id = await bridge(table, {
      keyTemplate: `${prefix}:{{id}}`,
      type: 'hash',
      ttlSeconds: 300,
    });
    expect(await replay(id)).toMatchObject({
      status: 'completed',
      sentCount: 2,
      failedCount: 0,
    });

    expect(await dest.type(`${prefix}:1`)).toBe('hash');
    // (the picture is bytes, and is looked at as bytes below)
    const { avatar: _bytes, ...fields } = await dest.hgetall(`${prefix}:1`);
    expect(fields).toEqual({
      id: '1',
      name: 'Ada',
      note: 'first',
      balance: '12.50',
      active: 'true',
      prefs: '{"tags":["a","b"],"theme":"dark"}',
      // ISO-8601, to the microsecond the source keeps: what any date parser takes
      seen: '2026-03-01T10:20:30.123000Z',
    });
    expect(await dest.hgetBuffer(`${prefix}:1`, 'avatar')).toEqual(
      Buffer.from([0x00, 0xff, 0x10]),
    );
    // NULL columns are not fields: HGET says nil, as SQL says NULL
    expect(await dest.hgetall(`${prefix}:2`)).toEqual({
      id: '2',
      name: 'Grace',
      balance: '0.00',
      active: 'false',
    });
    const ttl = await dest.ttl(`${prefix}:1`);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  }, 120_000);

  it('follows the row: a value that becomes NULL is a field that goes, and what the application added stays', async () => {
    const { table, prefix } = await people();
    const id = await bridge(table, { keyTemplate: `${prefix}:{{id}}` });
    await replay(id);
    // (something the application keeps beside the row's columns)
    await dest.hset(`${prefix}:1`, 'last_login_ip', '10.0.0.7');

    await pg(
      `UPDATE "${table}" SET note = NULL, name = 'Ada L.', balance = 99 WHERE id = 1`,
    );
    await replay(id);
    const hash = await dest.hgetall(`${prefix}:1`);
    expect(hash.name).toBe('Ada L.');
    expect(hash.balance).toBe('99.00');
    expect(hash).not.toHaveProperty('note');
    expect(hash.last_login_ip).toBe('10.0.0.7');
    // no expiry was asked for: the key has none
    expect(await dest.ttl(`${prefix}:1`)).toBe(-1);
  }, 120_000);

  it('takes over a key that is there as something else', async () => {
    const { table, prefix } = await people();
    await dest.set(
      `${prefix}:1`,
      'left over from an earlier setup',
      'EX',
      1000,
    );
    const id = await bridge(table, { keyTemplate: `${prefix}:{{id}}` });
    expect(await replay(id)).toMatchObject({
      status: 'completed',
      failedCount: 0,
    });
    expect(await dest.type(`${prefix}:1`)).toBe('hash');
    expect((await dest.hgetall(`${prefix}:1`)).name).toBe('Ada');
    expect(await dest.ttl(`${prefix}:1`)).toBe(-1);
  }, 120_000);
});

describe('the row as one JSON document, or one column as a string', () => {
  it('json: what the application reads back is the row', async () => {
    const { table, prefix } = await people();
    const id = await bridge(table, {
      keyTemplate: `${prefix}:{{id}}`,
      type: 'json',
      ttlSeconds: 60,
    });
    await replay(id);
    expect(await dest.type(`${prefix}:1`)).toBe('string');
    expect(JSON.parse((await dest.get(`${prefix}:1`))!)).toEqual({
      id: 1,
      name: 'Ada',
      note: 'first',
      balance: '12.50',
      active: true,
      prefs: { theme: 'dark', tags: ['a', 'b'] },
      seen: '2026-03-01T10:20:30.123000Z',
      avatar: 'AP8Q',
    });
    expect(JSON.parse((await dest.get(`${prefix}:2`))!)).toMatchObject({
      id: 2,
      note: null,
      prefs: null,
    });
    expect(await dest.ttl(`${prefix}:1`)).toBeGreaterThan(50);
  }, 120_000);

  it('string: the one column, under a key built from two', async () => {
    const { table, prefix } = await people();
    const id = await bridge(table, {
      keyTemplate: `${prefix}:{{active}}:{{id}}`,
      type: 'string',
      valueColumn: 'name',
    });
    await replay(id);
    expect(await dest.get(`${prefix}:true:1`)).toBe('Ada');
    expect(await dest.get(`${prefix}:false:2`)).toBe('Grace');
  }, 120_000);

  it('a mapping renames the fields, and the key is built from the names the target has', async () => {
    const { table, prefix } = await people();
    const id = await bridge(
      table,
      { keyTemplate: `${prefix}:{{user_id}}` },
      {
        target: {
          mapping: [
            { source: 'id', target: 'user_id' },
            { source: 'name', target: 'full_name' },
          ],
        },
      },
    );
    await replay(id);
    expect(await dest.hgetall(`${prefix}:1`)).toEqual({
      user_id: '1',
      full_name: 'Ada',
    });
  }, 120_000);
});

describe('a live bridge into Redis', () => {
  it('writes, rewrites, MOVES and removes keys as rows are inserted, updated, re-keyed and deleted', async () => {
    const { table, prefix } = await people();
    const id = await bridge(
      table,
      { keyTemplate: `${prefix}:{{id}}`, ttlSeconds: 500 },
      {
        trigger: {
          kind: 'cdc',
          operations: ['insert', 'update', 'delete'],
          startFrom: 'now',
        },
      },
    );
    await app.cdc.start(id);

    await pg(
      `INSERT INTO "${table}" (id, name, balance) VALUES (3, 'Linus', 1)`,
    );
    await waitFor('the new key', async () =>
      (await dest.exists(`${prefix}:3`)) ? true : null,
    );
    expect(await dest.hgetall(`${prefix}:3`)).toEqual({
      id: '3',
      name: 'Linus',
      balance: '1.00',
    });

    await pg(
      `UPDATE "${table}" SET name = 'Linus T.', note = 'kernel' WHERE id = 3`,
    );
    await waitFor('the update', async () =>
      (await dest.hget(`${prefix}:3`, 'note')) === 'kernel' ? true : null,
    );
    expect(await dest.hget(`${prefix}:3`, 'name')).toBe('Linus T.');
    // every write renews the expiry
    expect(await dest.ttl(`${prefix}:3`)).toBeGreaterThan(490);

    // the row's key changes: the key it WAS under must not be left behind
    await pg(`UPDATE "${table}" SET id = 30 WHERE id = 3`);
    await waitFor('the move', async () =>
      (await dest.exists(`${prefix}:30`)) ? true : null,
    );
    expect(await dest.exists(`${prefix}:3`)).toBe(0);
    expect(await dest.hget(`${prefix}:30`, 'name')).toBe('Linus T.');

    await pg(`DELETE FROM "${table}" WHERE id = 30`);
    await waitFor('the delete', async () =>
      (await dest.exists(`${prefix}:30`)) ? null : true,
    );
  }, 120_000);

  it('a target that keeps what it was sent (onDelete: ignore) keeps the key', async () => {
    const { table, prefix } = await people();
    const id = await bridge(
      table,
      { keyTemplate: `${prefix}:{{id}}` },
      {
        target: { onDelete: 'ignore' },
        trigger: {
          kind: 'cdc',
          operations: ['insert', 'update', 'delete'],
          startFrom: 'now',
        },
      },
    );
    await app.cdc.start(id);
    await pg(`INSERT INTO "${table}" (id, name) VALUES (5, 'kept')`);
    await waitFor('the key', async () =>
      (await dest.exists(`${prefix}:5`)) ? true : null,
    );
    await pg(`DELETE FROM "${table}" WHERE id = 5`);
    await pg(`INSERT INTO "${table}" (id, name) VALUES (6, 'after')`);
    await waitFor('what came after the delete', async () =>
      (await dest.exists(`${prefix}:6`)) ? true : null,
    );
    expect(await dest.hget(`${prefix}:5`, 'name')).toBe('kept');
  }, 120_000);
});

describe('what cannot become a key', () => {
  it('a row with no value for a key column fails — it is not written under half a key', async () => {
    const table = uniqueTable('rd_nokey');
    await pg(
      `CREATE TABLE "${table}" (id integer PRIMARY KEY, tenant text, name text)`,
    );
    await pg(
      `INSERT INTO "${table}" VALUES (1, 'acme', 'ok'), (2, NULL, 'no tenant')`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
    );
    const prefix = `rd:${table}`;
    cleanups.push(async () => {
      const keys = await dest.keys(`${prefix}:*`);
      if (keys.length) await dest.del(...keys);
    });
    const id = await bridge(
      table,
      { keyTemplate: `${prefix}:{{tenant}}:{{id}}` },
      { delivery: { batchSize: 1, onError: 'continue' } },
    );
    const job = await replay(id);
    expect(job).toMatchObject({ sentCount: 1, failedCount: 1 });
    expect(await dest.keys(`${prefix}:*`)).toEqual([`${prefix}:acme:1`]);
    const failed = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: job.id, status: 'failed' },
    });
    expect(failed?.error).toMatch(/no value for "tenant"/);
  }, 120_000);

  it('a key template on a target that is not Redis is refused when the bridge is saved', async () => {
    const { table } = await people();
    const { bridgeInputSchema } = await import('@syncle/core');
    await expect(
      controller.create(
        bridgeInputSchema.parse({
          name: `it-rd-wrong-${table}`,
          source: {
            kind: 'table',
            connectionId: await connectionFor(app, 'postgres'),
            table,
          },
          destination: {
            kind: 'database',
            targets: [
              {
                connectionId: await connectionFor(app, 'postgres_dest'),
                table: 'copy',
                redis: { keyTemplate: 'u:{{id}}' },
              },
            ],
          },
          transform: { template: '{{$row}}' },
          trigger: { kind: 'replay' },
        }),
      ),
    ).rejects.toThrow(/is not a Redis connection/);
  }, 120_000);
});

describe('a target without a key template is what it always was', () => {
  it('`key` and `value` columns, a string — and a column that happens to be called "type" or "ttl" is somebody’s data', async () => {
    const table = uniqueTable('rd_legacy');
    await pg(
      `CREATE TABLE "${table}" (key text PRIMARY KEY, value text, type text, ttl integer)`,
    );
    const prefix = `rd:${table}`;
    await pg(
      `INSERT INTO "${table}" VALUES ('${prefix}:a', 'one', 'premium', 5), ('${prefix}:b', 'two', NULL, NULL)`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
    );
    cleanups.push(async () => {
      const keys = await dest.keys(`${prefix}:*`);
      if (keys.length) await dest.del(...keys);
    });
    const id = await bridge(table, undefined, {
      target: { keyColumns: ['key'] },
    });
    expect(await replay(id)).toMatchObject({
      status: 'completed',
      failedCount: 0,
    });
    expect(await dest.get(`${prefix}:a`)).toBe('one');
    expect(await dest.ttl(`${prefix}:a`)).toBe(-1);
    expect(await dest.get(`${prefix}:b`)).toBe('two');
  }, 120_000);
});

describe('Redis to Redis', () => {
  it('a hash arrives as a hash, a list as a list, a set as a set, a sorted set as one — with the time each has left', async () => {
    const prefix = `rr:${uniqueTable('k')}`;
    await src.set(`${prefix}:s`, 'plain');
    await src.set(`${prefix}:exp`, 'expiring', 'EX', 1000);
    await src.hset(`${prefix}:h`, { name: 'Ada', role: 'admin' });
    await src.rpush(
      `${prefix}:l`,
      ...Array.from({ length: 40 }, (_, i) => `item-${i}`),
    );
    await src.sadd(`${prefix}:set`, 'x', 'y', 'z');
    await src.zadd(`${prefix}:z`, 1, 'low', 2.5, 'mid', 10, 'high');
    // what the destination held before: a field, and a member, the source no longer has
    await dest.hset(`${prefix}:h`, { name: 'old', gone: 'at the source' });
    await dest.sadd(`${prefix}:set`, 'stale');
    cleanups.push(async () => {
      for (const client of [src, dest]) {
        const keys = await client.keys(`${prefix}:*`);
        if (keys.length) await client.del(...keys);
      }
    });

    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await controller.create(
      bridgeInputSchema.parse({
        name: `it-rr-${prefix}`,
        source: {
          kind: 'table',
          connectionId: await connectionFor(app, 'redis'),
          table: 'keys',
          filters: [
            { column: 'key', operator: 'startsWith', value: `${prefix}:` },
          ],
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: await connectionFor(app, 'redis_dest'),
              table: 'keys',
              keyColumns: ['key'],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
      }),
    );
    cleanups.push(() => controller.remove(created.id).then(() => undefined));
    expect(await replay(created.id)).toMatchObject({
      status: 'completed',
      sentCount: 6,
      failedCount: 0,
    });

    expect(await dest.get(`${prefix}:s`)).toBe('plain');
    expect(await dest.ttl(`${prefix}:s`)).toBe(-1);
    expect(await dest.get(`${prefix}:exp`)).toBe('expiring');
    expect(await dest.ttl(`${prefix}:exp`)).toBeGreaterThan(900);
    expect(await dest.type(`${prefix}:h`)).toBe('hash');
    expect(await dest.hgetall(`${prefix}:h`)).toEqual({
      name: 'Ada',
      role: 'admin',
    });
    expect(await dest.lrange(`${prefix}:l`, 0, -1)).toEqual(
      Array.from({ length: 40 }, (_, i) => `item-${i}`),
    );
    expect((await dest.smembers(`${prefix}:set`)).sort()).toEqual([
      'x',
      'y',
      'z',
    ]);
    expect(await dest.zrange(`${prefix}:z`, 0, -1, 'WITHSCORES')).toEqual([
      'low',
      '1',
      'mid',
      '2.5',
      'high',
      '10',
    ]);

    // again: the same keys, not a list twice as long
    await replay(created.id);
    expect(await dest.llen(`${prefix}:l`)).toBe(40);
    expect(await dest.zcard(`${prefix}:z`)).toBe(3);
    await sleep(10);
  }, 120_000);
});
