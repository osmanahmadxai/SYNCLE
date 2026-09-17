/**
 * A -> B plus B -> A.
 *
 * Two live bridges that feed each other sent one row back and forth for ever.
 * Measured on two PostgreSQL tables before there was a guard: one INSERT by a
 * person, and each bridge delivering about nine times a second, for as long as
 * both ran (an upsert of the same values is still a change as far as
 * PostgreSQL's log is concerned).
 *
 * What is asserted here is what a person would see: the row arrives on the other
 * side ONCE, and then both bridges go quiet — while a chain (A -> B -> C) still
 * carries the row all the way, and a ring (A -> B -> C -> A) stops where it began.
 */
import 'reflect-metadata';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_REDIS_URL } from './env';
import { sleep, uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
let controller: any;
let watch: any;
let echo: any;
let redis: Redis;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { BridgeWatchService } =
    await import('../../src/bridges/bridge-watch.service');
  const { EchoGuardService } =
    await import('../../src/bridges/echo-guard.service');
  controller = app.ctx.get(BridgesController);
  watch = app.ctx.get(BridgeWatchService);
  echo = app.ctx.get(EchoGuardService);
  redis = new Redis(TEST_REDIS_URL);
}, 120_000);

// after EACH test: every bridge here holds a replication slot, and the test server has twenty
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse())
    await fn().catch(() => undefined);
});

afterAll(async () => {
  await redis?.quit().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const quote = (engine: ConnKey, t: string) =>
  engine.startsWith('mysql') ? `\`${t}\`` : `"${t}"`;

const DDL = (engine: ConnKey, t: string) =>
  engine.startsWith('mysql')
    ? `CREATE TABLE \`${t}\` (id integer PRIMARY KEY, name varchar(255), qty decimal(10,2), seen datetime(6) NULL)`
    : `CREATE TABLE "${t}" (id integer PRIMARY KEY, name text, qty numeric(10,2), seen timestamptz NULL)`;

async function table(engine: ConnKey, prefix: string): Promise<string> {
  const name = uniqueTable(prefix);
  await withAdapter(engine, (a) => a.query(DDL(engine, name)));
  cleanups.push(() =>
    withAdapter(engine, (a) => a.dropTable(name)).then(() => undefined),
  );
  return name;
}

const run = (engine: ConnKey, sql: string) =>
  withAdapter(engine, (a) => a.query(sql));

async function rows(engine: ConnKey, t: string) {
  const r = await run(
    engine,
    `SELECT id, name, qty FROM ${quote(engine, t)} ORDER BY id`,
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: row.name as string | null,
    qty: row.qty === null ? null : Number(row.qty),
  }));
}

/** a live CDC bridge from one table to another — through connections of its own, as two people would set them up */
async function cdcBridge(
  from: [ConnKey, string],
  to: [ConnKey, string],
  extra: Record<string, unknown> = {},
  trigger: Record<string, unknown> = {},
  start = true,
): Promise<string> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await controller.create(
    bridgeInputSchema.parse({
      name: `it-loop-${from[1]}-to-${to[1]}`,
      source: {
        kind: 'table',
        connectionId: await connectionFor(app, from[0]),
        table: from[1],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: await connectionFor(app, to[0]),
            table: to[1],
            keyColumns: ['id'],
            ...extra,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: {
        kind: 'cdc',
        operations: ['insert', 'update', 'delete'],
        startFrom: 'now',
        ...trigger,
      },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });
  if (start) await app.cdc.start(bridge.id);
  return bridge.id as string;
}

/** deliveries a bridge's running job has made */
async function deliveries(bridgeId: string): Promise<number> {
  const job = await app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });
  return job
    ? app.prisma.bridgeDelivery.count({ where: { jobId: job.id } })
    : 0;
}

/** both bridges have gone QUIET: what they have delivered does not move for a while */
async function settled(ids: string[], quietMs = 2500): Promise<number[]> {
  let last = await Promise.all(ids.map(deliveries));
  let since = Date.now();
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    await sleep(250);
    const now = await Promise.all(ids.map(deliveries));
    if (now.some((n, i) => n !== last[i])) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return now;
  }
  throw new Error(
    `the bridges never went quiet: ${JSON.stringify(last)} deliveries and counting`,
  );
}

describe('two bridges that feed each other', () => {
  describe.each([
    ['postgres', 'postgres_dest'],
    ['mysql', 'postgres_dest'],
    ['postgres', 'mysql_dest'],
  ] as Array<[ConnKey, ConnKey]>)('%s <-> %s', (ea, eb) => {
    it('a change crosses ONCE, in either direction, and is not sent back — inserts, updates and deletes', async () => {
      const a = await table(ea, 'loop_a');
      const b = await table(eb, 'loop_b');
      const ab = await cdcBridge([ea, a], [eb, b]);
      const ba = await cdcBridge([eb, b], [ea, a]);

      // (a value every engine spells differently: 12.50 / '12.50' / 12.5, and a moment in time)
      await run(
        ea,
        `INSERT INTO ${quote(ea, a)} (id, name, qty, seen) VALUES (1, 'made at A', 12.50, '2026-03-01 10:20:30.123456')`,
      );
      await waitFor('the row at B', async () =>
        (await rows(eb, b)).length === 1 ? true : null,
      );
      expect(await settled([ab, ba])).toEqual([1, 0]);

      await run(
        eb,
        `UPDATE ${quote(eb, b)} SET name = 'changed at B', qty = 7 WHERE id = 1`,
      );
      await waitFor('the change at A', async () =>
        (await rows(ea, a))[0]?.name === 'changed at B' ? true : null,
      );
      expect(await settled([ab, ba])).toEqual([1, 1]);
      expect(await rows(ea, a)).toEqual([
        { id: 1, name: 'changed at B', qty: 7 },
      ]);

      await run(
        eb,
        `INSERT INTO ${quote(eb, b)} (id, name, qty) VALUES (2, 'made at B', 1)`,
      );
      await waitFor('the second row at A', async () =>
        (await rows(ea, a)).length === 2 ? true : null,
      );
      expect(await settled([ab, ba])).toEqual([1, 2]);

      await run(ea, `DELETE FROM ${quote(ea, a)} WHERE id = 1`);
      await waitFor('the delete at B', async () =>
        (await rows(eb, b)).length === 1 ? true : null,
      );
      expect(await settled([ab, ba])).toEqual([2, 2]);
      expect(await rows(ea, a)).toEqual(await rows(eb, b));

      // and it is said: a person wondering why a change "did not arrive" can find out
      expect(echo.droppedBy(ab) + echo.droppedBy(ba)).toBeGreaterThanOrEqual(4);
      const tied = await controller.loops(ab);
      expect(tied.guard).toBe(true);
      expect(tied.fedBy.map((p: { bridgeId: string }) => p.bridgeId)).toEqual([
        ba,
      ]);
      expect(tied.feeds.map((p: { bridgeId: string }) => p.bridgeId)).toEqual([
        ba,
      ]);
      expect(tied.heldBack).toBe(echo.droppedBy(ab));
      expect(tied.heldBack).toBeGreaterThanOrEqual(2);
    }, 120_000);
  });

  it('a row changed several times quickly still ends the same on both sides, and the bridges stop', async () => {
    const a = await table('postgres', 'loop_a');
    const b = await table('postgres_dest', 'loop_b');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const ba = await cdcBridge(['postgres_dest', b], ['postgres', a]);

    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'v0', 0)`,
    );
    for (let i = 1; i <= 25; i++)
      await run(
        'postgres',
        `UPDATE "${a}" SET name = 'v${i}', qty = ${i} WHERE id = 1`,
      );
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) SELECT g, 'bulk', g FROM generate_series(100, 399) g`,
    );
    await waitFor('everything at B', async () => {
      const got = await rows('postgres_dest', b);
      return got.length === 301 && got[0]?.name === 'v25' ? true : null;
    });
    const [, back] = await settled([ab, ba]);
    expect(back).toBe(0);
    expect(await rows('postgres', a)).toEqual(await rows('postgres_dest', b));
  }, 120_000);

  it('edits on BOTH sides at once do not start a ping-pong (the two sides may differ: verify says so)', async () => {
    const a = await table('postgres', 'loop_a');
    const b = await table('postgres_dest', 'loop_b');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const ba = await cdcBridge(['postgres_dest', b], ['postgres', a]);
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'start', 0)`,
    );
    await waitFor('the row at B', async () =>
      (await rows('postgres_dest', b)).length === 1 ? true : null,
    );
    await settled([ab, ba]);

    await Promise.all([
      run('postgres', `UPDATE "${a}" SET name = 'says A' WHERE id = 1`),
      run('postgres_dest', `UPDATE "${b}" SET name = 'says B' WHERE id = 1`),
    ]);
    const counts = await settled([ab, ba]);
    // each side's edit crossed; neither came back more than the once it takes to settle
    expect(counts[0]!).toBeLessThanOrEqual(3);
    expect(counts[1]!).toBeLessThanOrEqual(2);
  }, 120_000);

  it('a bridge keyed on something other than the primary key is recognised too', async () => {
    const ddl = (t: string) =>
      `CREATE TABLE "${t}" (pk serial PRIMARY KEY, email text UNIQUE NOT NULL, name text)`;
    const a = uniqueTable('loop_ka');
    const b = uniqueTable('loop_kb');
    await run('postgres', ddl(a));
    await run('postgres_dest', ddl(b));
    // (a delete has to carry the column the other side is keyed on)
    await run('postgres', `ALTER TABLE "${a}" REPLICA IDENTITY FULL`);
    await run('postgres_dest', `ALTER TABLE "${b}" REPLICA IDENTITY FULL`);
    cleanups.push(() =>
      withAdapter('postgres', (x) => x.dropTable(a)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (x) => x.dropTable(b)).then(() => undefined),
    );
    const mapping = [
      { source: 'email', target: 'email' },
      { source: 'name', target: 'name' },
    ];
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b], {
      keyColumns: ['email'],
      mapping,
    });
    const ba = await cdcBridge(['postgres_dest', b], ['postgres', a], {
      keyColumns: ['email'],
      mapping,
    });

    await run(
      'postgres',
      `INSERT INTO "${a}" (email, name) VALUES ('x@example.test', 'X')`,
    );
    await waitFor('the row at B', async () => {
      const r = await run('postgres_dest', `SELECT email FROM "${b}"`);
      return r.rows.length === 1 ? true : null;
    });
    expect(await settled([ab, ba])).toEqual([1, 0]);
    await run(
      'postgres_dest',
      `UPDATE "${b}" SET name = 'X2' WHERE email = 'x@example.test'`,
    );
    await waitFor('the change at A', async () => {
      const r = await run('postgres', `SELECT name FROM "${a}"`);
      return r.rows[0]?.name === 'X2' ? true : null;
    });
    expect(await settled([ab, ba])).toEqual([1, 1]);

    await run('postgres', `DELETE FROM "${a}" WHERE email = 'x@example.test'`);
    await waitFor('the delete at B', async () => {
      const r = await run('postgres_dest', `SELECT email FROM "${b}"`);
      return r.rows.length === 0 ? true : null;
    });
    expect(await settled([ab, ba])).toEqual([2, 1]);
  }, 120_000);
});

describe('two bridges that mirror TRUNCATE to each other', () => {
  it('empty each other ONCE, not for ever', async () => {
    const a = await table('postgres', 'trunc_a');
    const b = await table('postgres_dest', 'trunc_b');
    const ops = { operations: ['insert', 'update', 'delete', 'truncate'] };
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b], {}, ops);
    const ba = await cdcBridge(['postgres_dest', b], ['postgres', a], {}, ops);
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'x', 1), (2, 'y', 2)`,
    );
    await waitFor('the rows at B', async () =>
      (await rows('postgres_dest', b)).length === 2 ? true : null,
    );
    expect(await settled([ab, ba])).toEqual([1, 0]);

    await run('postgres', `TRUNCATE "${a}"`);
    await waitFor('B to be emptied', async () =>
      (await rows('postgres_dest', b)).length === 0 ? true : null,
    );
    // (PostgreSQL logs the TRUNCATE of B, and would log B -> A's TRUNCATE of the already empty A too)
    expect(await settled([ab, ba])).toEqual([2, 0]);

    // and the other way round, with rows that arrive AFTER it
    await run(
      'postgres_dest',
      `INSERT INTO "${b}" (id, name, qty) VALUES (3, 'z', 3)`,
    );
    await waitFor('the row at A', async () =>
      (await rows('postgres', a)).length === 1 ? true : null,
    );
    await run('postgres_dest', `TRUNCATE "${b}"`);
    await waitFor('A to be emptied', async () =>
      (await rows('postgres', a)).length === 0 ? true : null,
    );
    expect(await settled([ab, ba])).toEqual([2, 2]);
  }, 120_000);
});

describe('a chain and a ring', () => {
  it('A -> B -> C carries a row all the way: what B was sent is B’s to pass on', async () => {
    const a = await table('postgres', 'chain_a');
    const b = await table('postgres_dest', 'chain_b');
    const c = await table('mysql_dest', 'chain_c');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const bc = await cdcBridge(['postgres_dest', b], ['mysql_dest', c]);
    // (something reads C too, or nothing B -> C writes would be remembered at all)
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'down the chain', 3.25)`,
    );
    await waitFor('the row at C', async () =>
      (await rows('mysql_dest', c)).length === 1 ? true : null,
    );
    expect(await settled([ab, bc])).toEqual([1, 1]);
    expect(await rows('mysql_dest', c)).toEqual([
      { id: 1, name: 'down the chain', qty: 3.25 },
    ]);
  }, 120_000);

  it('A -> B -> C -> A stops where it began, whichever table the change is made in', async () => {
    const a = await table('postgres', 'ring_a');
    const b = await table('postgres_dest', 'ring_b');
    const c = await table('mysql_dest', 'ring_c');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const bc = await cdcBridge(['postgres_dest', b], ['mysql_dest', c]);
    const ca = await cdcBridge(['mysql_dest', c], ['postgres', a]);

    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'round', 1)`,
    );
    await waitFor('the row at C', async () =>
      (await rows('mysql_dest', c)).length === 1 ? true : null,
    );
    expect(await settled([ab, bc, ca])).toEqual([1, 1, 0]);

    await run('mysql_dest', `UPDATE \`${c}\` SET name = 'from C' WHERE id = 1`);
    await waitFor('the change at B', async () =>
      (await rows('postgres_dest', b))[0]?.name === 'from C' ? true : null,
    );
    // C -> A -> B, and B -> C is where it has been
    expect(await settled([ab, bc, ca])).toEqual([2, 1, 1]);
    expect(await rows('postgres', a)).toEqual(await rows('mysql_dest', c));
  }, 120_000);
});

describe('a bridge that POLLS the table another bridge writes', () => {
  it('does not send back what the poll finds the other bridge wrote', async () => {
    const ddl = (t: string) =>
      `CREATE TABLE "${t}" (id integer PRIMARY KEY, name text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
    const a = uniqueTable('poll_a');
    const b = uniqueTable('poll_b');
    await run('postgres', ddl(a));
    await run('postgres_dest', ddl(b));
    cleanups.push(() =>
      withAdapter('postgres', (x) => x.dropTable(a)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (x) => x.dropTable(b)).then(() => undefined),
    );

    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const { bridgeInputSchema } = await import('@syncle/core');
    const back = await controller.create(
      bridgeInputSchema.parse({
        name: `it-loop-poll-${b}`,
        source: {
          kind: 'table',
          connectionId: await connectionFor(app, 'postgres_dest'),
          table: b,
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: await connectionFor(app, 'postgres'),
              table: a,
              keyColumns: ['id'],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: {
          kind: 'watch',
          strategy: {
            strategy: 'timestamp',
            column: 'updated_at',
            lookbackMs: 0,
          },
          pollIntervalMs: 1000,
          startFrom: 'now',
        },
      }),
    );
    cleanups.push(() => controller.remove(back.id).then(() => undefined));
    await watch.start(back.id);

    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name) VALUES (1, 'made at A')`,
    );
    await waitFor('the row at B', async () => {
      const r = await run('postgres_dest', `SELECT id FROM "${b}"`);
      return r.rows.length === 1 ? true : null;
    });
    expect(await settled([ab, back.id], 4000)).toEqual([1, 0]);

    // what somebody changes at B is theirs, and does go to A
    await run(
      'postgres_dest',
      `UPDATE "${b}" SET name = 'changed at B', updated_at = clock_timestamp() WHERE id = 1`,
    );
    await waitFor('the change at A', async () => {
      const r = await run('postgres', `SELECT name FROM "${a}"`);
      return r.rows[0]?.name === 'changed at B' ? true : null;
    });
    expect(await settled([ab, back.id], 4000)).toEqual([1, 1]);
  }, 120_000);
});

describe('what is remembered', () => {
  const echoKeys = () => redis.keys('syncle:echo:*');

  it('is nothing at all for a bridge whose destination nobody reads', async () => {
    const before = new Set(await echoKeys());
    const a = await table('postgres', 'plain_a');
    const b = await table('postgres_dest', 'plain_b');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'one way', 1)`,
    );
    await waitFor('the row at B', async () =>
      (await rows('postgres_dest', b)).length === 1 ? true : null,
    );
    expect(await settled([ab])).toEqual([1]);
    expect((await echoKeys()).filter((k) => !before.has(k))).toEqual([]);
    expect(await controller.loops(ab)).toEqual({
      guard: true,
      fedBy: [],
      feeds: [],
      heldBack: 0,
    });
  }, 120_000);

  it('is nothing while the bridge that would read it is not listening — never started, or stopped long ago', async () => {
    const a = await table('postgres', 'idle_a');
    const b = await table('postgres_dest', 'idle_b');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const ba = await cdcBridge(
      ['postgres_dest', b],
      ['postgres', a],
      {},
      {},
      false,
    ); // saved, never started
    const before = new Set(await echoKeys());
    const fresh = async () => (await echoKeys()).filter((k) => !before.has(k));

    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'nobody is reading B', 1)`,
    );
    await waitFor('the row at B', async () =>
      (await rows('postgres_dest', b)).length === 1 ? true : null,
    );
    expect(await fresh()).toEqual([]);

    // it listens: from now on what A -> B writes is remembered…
    await app.cdc.start(ba);
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (2, 'B is read now', 2)`,
    );
    await waitFor('the second row at B', async () =>
      (await rows('postgres_dest', b)).length === 2 ? true : null,
    );
    expect(await settled([ab, ba])).toEqual([2, 0]);

    // …and for a while after it stops (it will pick its position up again) — but not for ever
    await app.cdc.stop(ba);
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (3, 'B -> A has just stopped', 3)`,
    );
    await waitFor('the third row at B', async () =>
      (await rows('postgres_dest', b)).length === 3 ? true : null,
    );
    expect(await fresh()).toHaveLength(1);
    await app.prisma.bridgeJob.updateMany({
      where: { bridgeId: ba },
      data: { finishedAt: new Date(Date.now() - 3600_000) },
    });
    echo.forget();
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (4, 'B -> A stopped an hour ago', 4)`,
    );
    await waitFor('the fourth row at B', async () =>
      (await rows('postgres_dest', b)).length === 4 ? true : null,
    );
    expect(await fresh()).toHaveLength(1);
  }, 120_000);

  it('can be LOST (it expired while the other bridge was down) and the loop still dies by itself, one hop later', async () => {
    const a = await table('postgres', 'lost_a');
    const b = await table('postgres_dest', 'lost_b');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const ba = await cdcBridge(['postgres_dest', b], ['postgres', a]);
    const before = new Set(await echoKeys());

    await app.cdc.stop(ba);
    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'while B -> A was down', 2)`,
    );
    await waitFor('the row at B', async () =>
      (await rows('postgres_dest', b)).length === 1 ? true : null,
    );
    // …and B -> A stays down for longer than SYNCLE_ECHO_TTL_SECONDS
    const waiting = (await echoKeys()).filter((k) => !before.has(k));
    expect(waiting).toHaveLength(1);
    // what is kept there is somebody's row: it is not kept where it can be read
    const kept = (await redis.lrange(waiting[0]!, 0, -1)).join('\n');
    expect(kept).not.toContain('while B -> A was down');
    expect(kept).not.toContain(a);
    expect(await redis.ttl(waiting[0]!)).toBeGreaterThan(0);
    await redis.del(...waiting);

    await app.cdc.start(ba);
    // it reads the row A -> B wrote, does not know it, and sends it to A — where
    // it is already exactly that: nothing is written, so nothing comes back
    const counts = await settled([ab, ba]);
    expect(counts).toEqual([1, 1]);
    const job = await app.prisma.bridgeJob.findFirst({
      where: { bridgeId: ba },
      orderBy: { startedAt: 'desc' },
    });
    const sent = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: job.id },
    });
    expect(sent?.responseBody ?? '').toMatch(
      /wrote 0 \(1 already up to date, not written\)/,
    );
    expect(await rows('postgres', a)).toEqual(await rows('postgres_dest', b));
  }, 120_000);

  it('is used up by the change it was waiting for, and a row that is already right is neither written nor remembered', async () => {
    const a = await table('postgres', 'mem_a');
    const b = await table('postgres_dest', 'mem_b');
    const ab = await cdcBridge(['postgres', a], ['postgres_dest', b]);
    const ba = await cdcBridge(['postgres_dest', b], ['postgres', a]);
    const before = new Set(await echoKeys());

    await run(
      'postgres',
      `INSERT INTO "${a}" (id, name, qty) VALUES (1, 'same', 5), (2, 'same', 5)`,
    );
    await waitFor('the rows at B', async () =>
      (await rows('postgres_dest', b)).length === 2 ? true : null,
    );
    await settled([ab, ba]);
    // B's bridge has read both of them back and used them up
    expect((await echoKeys()).filter((k) => !before.has(k))).toEqual([]);

    // a RUN of A -> B over rows B already has (a nightly replay beside the live
    // pair): nothing to write, and nothing to expect back
    const { bridgeInputSchema } = await import('@syncle/core');
    const { BridgeJobService } =
      await import('../../src/bridges/bridge-job.service');
    const jobs = app.ctx.get(BridgeJobService);
    const nightly = await controller.create(
      bridgeInputSchema.parse({
        name: `it-loop-nightly-${a}`,
        source: {
          kind: 'table',
          connectionId: await connectionFor(app, 'postgres'),
          table: a,
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: await connectionFor(app, 'postgres_dest'),
              table: b,
              keyColumns: ['id'],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
      }),
    );
    cleanups.push(() => controller.remove(nightly.id).then(() => undefined));
    const xmin = () =>
      run(
        'postgres_dest',
        `SELECT id, xmin::text AS x FROM "${b}" ORDER BY id`,
      ).then((r) => r.rows);
    const xminBefore = await xmin();
    const backBefore = await deliveries(ba);

    const job = await jobs.start(nightly.id, { fresh: true });
    const done = await waitFor('the replay', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: job.id },
      });
      return j && ['completed', 'failed'].includes(j.status) ? j : null;
    });
    expect(done).toMatchObject({ status: 'completed', failedCount: 0 });
    const delivery = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: job.id },
    });
    expect(delivery?.responseBody ?? '').toMatch(
      /already up to date, not written/,
    );
    expect(await xmin()).toEqual(xminBefore); // not one row was rewritten
    expect((await echoKeys()).filter((k) => !before.has(k))).toEqual([]);

    // one row IS out of date: that one is written, comes back to B's bridge, and is known there
    await app.cdc.stop(ab);
    await run(
      'postgres',
      `UPDATE "${a}" SET name = 'changed while A -> B was stopped' WHERE id = 2`,
    );
    const again = await jobs.start(nightly.id, { fresh: true });
    await waitFor('the second replay', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: again.id },
      });
      return j && ['completed', 'failed'].includes(j.status) ? j : null;
    });
    expect((await rows('postgres_dest', b))[1]?.name).toBe(
      'changed while A -> B was stopped',
    );
    await settled([ba]);
    expect(await deliveries(ba)).toBe(backBefore); // B -> A did not send it back
    expect((await xmin())[0]).toEqual(xminBefore[0]); // and row 1 was still left alone
  }, 120_000);
});
