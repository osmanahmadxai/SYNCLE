/**
 * A connection marked read-only, against real engines: what the editor may run,
 * what every write route answers, what a bridge may and may not do with it.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_CONNECTIONS, uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
let controller: any;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { ConnectionsController } =
    await import('../../src/connections/connections.controller');
  controller = app.ctx.get(ConnectionsController);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function connection(key: ConnKey, extra: Record<string, unknown>) {
  const t = TEST_CONNECTIONS[key]!;
  const conn = await app.connections.create({
    name: `it-safe-${key}-${Math.random().toString(36).slice(2, 7)}`,
    engine: t.engine,
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.database,
    options: t.options,
    ...extra,
  });
  return conn as { id: string; name: string };
}

const q = (id: string, statement: string) =>
  controller.query(id, { statement }, undefined);

describe('the label', () => {
  it('is stored with the connection, and absent on one that has none', async () => {
    const prod = await connection('postgres', {
      readOnly: true,
      environment: 'production',
    });
    expect(await app.connections.get(prod.id)).toMatchObject({
      readOnly: true,
      environment: 'production',
    });
    const plain = await connection('postgres', {});
    const stored = await app.connections.get(plain.id);
    expect(stored.readOnly).toBeUndefined();
    expect(stored.environment).toBeUndefined();
    const { connectionInputSchema } = await import('@syncle/core');
    expect(
      connectionInputSchema.safeParse({
        name: 'x',
        engine: 'postgres',
        environment: 'prod',
      }).success,
    ).toBe(false);
  });
});

for (const key of ['postgres', 'mysql', 'sqlite'] as ConnKey[]) {
  describe(`a read-only ${key} connection, in the editor`, () => {
    it('runs a read; refuses what is not one, naming the connection and the reason', async () => {
      const table = uniqueTable('safe');
      await withAdapter(key, (a) =>
        a.createTable({
          table,
          columns: [
            {
              name: 'id',
              type:
                key === 'sqlite'
                  ? 'INTEGER'
                  : key === 'mysql'
                    ? 'int'
                    : 'integer',
              nullable: false,
              primaryKey: true,
            },
            {
              name: 'name',
              type:
                key === 'sqlite'
                  ? 'TEXT'
                  : key === 'mysql'
                    ? 'varchar(255)'
                    : 'text',
              nullable: true,
            },
          ],
        }),
      );
      cleanups.push(() =>
        withAdapter(key, (a) => a.dropTable(table)).then(() => undefined),
      );
      await withAdapter(key, (a) =>
        a.insertRow({ table, values: { id: 1, name: 'kept' } }),
      );
      const conn = await connection(key, { readOnly: true });
      const quoted = key === 'mysql' ? `\`${table}\`` : `"${table}"`;

      expect(
        (await q(conn.id, `SELECT name FROM ${quoted} WHERE id = 1`)).rows,
      ).toEqual([{ name: 'kept' }]);

      for (const [statement, reason] of [
        [`INSERT INTO ${quoted} VALUES (2, 'x')`, 'INSERT'],
        [`UPDATE ${quoted} SET name = 'x' WHERE id = 1`, 'UPDATE'],
        [`DELETE FROM ${quoted}`, 'DELETE without WHERE'],
        [`DROP TABLE ${quoted}`, 'DROP TABLE'],
        [`SELECT 1; DELETE FROM ${quoted} WHERE id = 1`, 'DELETE'],
      ] as const) {
        await expect(q(conn.id, statement), statement).rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining(
            `"${conn.name}" is a read-only connection`,
          ),
        });
        await expect(q(conn.id, statement)).rejects.toThrow(reason);
      }
      // and nothing happened
      expect(
        await withAdapter(key, (a) =>
          a.browse({ table, limit: 10, offset: 0 }).then((p) => p.rows),
        ),
      ).toEqual([{ id: 1, name: 'kept' }]);
    }, 120_000);
  });
}

describe('what the TEXT of a statement cannot know', () => {
  it('PostgreSQL: a SELECT that calls a function that writes is refused by the ENGINE', async () => {
    const table = uniqueTable('safe_fn');
    const fn = `${table}_bump`;
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${table}" (n integer); INSERT INTO "${table}" VALUES (0);
         CREATE FUNCTION "${fn}"() RETURNS integer LANGUAGE sql VOLATILE AS $$ UPDATE "${table}" SET n = n + 1 RETURNING n $$`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) =>
        a.query(
          `DROP FUNCTION IF EXISTS "${fn}"(); DROP TABLE IF EXISTS "${table}"`,
        ),
      ).then(() => undefined),
    );
    const conn = await connection('postgres', { readOnly: true });
    // reads as a read — and is not one
    await expect(q(conn.id, `SELECT "${fn}"()`)).rejects.toThrow(
      /read-only transaction/,
    );
    expect(
      (
        await withAdapter('postgres', (a) =>
          a.query(`SELECT n FROM "${table}"`),
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    // the same statement on a connection that is not read-only does what it says
    const writable = await connection('postgres', {});
    await q(writable.id, `SELECT "${fn}"()`);
    expect(
      (
        await withAdapter('postgres', (a) =>
          a.query(`SELECT n FROM "${table}"`),
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  }, 120_000);

  it('MySQL and SQLite hold a statement to reading too', async () => {
    const { createAdapter } = await import('@syncle/core/adapters');
    for (const key of ['mysql', 'sqlite'] as ConnKey[]) {
      const table = uniqueTable('safe_ro');
      await withAdapter(key, (a) =>
        a.createTable({
          table,
          columns: [
            {
              name: 'id',
              type: key === 'sqlite' ? 'INTEGER' : 'int',
              nullable: false,
              primaryKey: true,
            },
          ],
        }),
      );
      cleanups.push(() =>
        withAdapter(key, (a) => a.dropTable(table)).then(() => undefined),
      );
      const adapter = createAdapter({
        ...(TEST_CONNECTIONS[key] as object),
        id: 'x',
        name: 'x',
      } as never);
      await adapter.connect();
      try {
        const quoted = key === 'mysql' ? `\`${table}\`` : `"${table}"`;
        await expect(
          adapter.queryReadOnly!(`INSERT INTO ${quoted} VALUES (1)`),
          key,
        ).rejects.toThrow(/read.?only/i);
        expect(
          (await adapter.queryReadOnly!(`SELECT COUNT(*) AS n FROM ${quoted}`))
            .rows[0],
        ).toMatchObject({ n: expect.anything() });
        expect(
          await adapter
            .browse({ table, limit: 5, offset: 0 })
            .then((p) => p.rows),
        ).toEqual([]);
      } finally {
        await adapter.close();
      }
    }
  }, 120_000);
});

describe('a read-only Redis or MongoDB connection, in the editor', () => {
  it('reads; does not write; does not empty the database', async () => {
    const redis = await connection('redis', { readOnly: true });
    expect((await q(redis.id, 'DBSIZE')).rows).toHaveLength(1);
    await expect(q(redis.id, 'SET safe:x 1')).rejects.toMatchObject({
      status: 403,
    });
    await expect(q(redis.id, 'GET a\nFLUSHDB')).rejects.toThrow(/FLUSHDB/);

    const mongo = await connection('mongodb', { readOnly: true });
    const coll = uniqueTable('safe_m');
    await withAdapter('mongodb', (a) =>
      a.insertRow({ table: coll, values: { id: 1 } }),
    );
    cleanups.push(() =>
      withAdapter('mongodb', (a) => a.dropTable(coll)).then(() => undefined),
    );
    expect(
      (await q(mongo.id, JSON.stringify({ collection: coll, find: {} }))).rows,
    ).toHaveLength(1);
    await expect(
      q(
        mongo.id,
        JSON.stringify({ collection: coll, aggregate: [{ $out: coll }] }),
      ),
    ).rejects.toThrow(/\$out/);
  }, 120_000);
});

describe('every route that writes', () => {
  it('answers 403 on a read-only connection, and does nothing', async () => {
    const table = uniqueTable('safe_rt');
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${table}" (id integer PRIMARY KEY, name text); INSERT INTO "${table}" VALUES (1, 'kept')`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
    );
    const conn = await connection('postgres', { readOnly: true });
    const refused = {
      status: 403,
      message: expect.stringContaining(
        `"${conn.name}" is a read-only connection`,
      ),
    };

    await expect(
      controller.insertRow(
        conn.id,
        { table, values: { id: 2, name: 'x' } },
        undefined,
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.updateRow(
        conn.id,
        { table, identity: { id: 1 }, changes: { name: 'x' } },
        undefined,
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.deleteRow(conn.id, { table, identity: { id: 1 } }, undefined),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.createTable(
        conn.id,
        {
          table: `${table}_new`,
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          ],
        },
        undefined,
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.truncateTable(conn.id, { table }, undefined),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.dropTable(conn.id, { table }, undefined),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.createDatabase(conn.id, { name: 'safe_never' }),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.dropDatabase(conn.id, { name: 'safe_never' }),
    ).rejects.toMatchObject(refused);
    await expect(
      controller.restore(conn.id, { format: 'json', content: '{}' }, undefined),
    ).rejects.toMatchObject(refused);
    expect(await destRowsOf('postgres', table)).toEqual([
      { id: 1, name: 'kept' },
    ]);

    // reading, and taking a backup, are reads
    expect(
      (
        await controller.browse(
          conn.id,
          { table, limit: 10, offset: 0 },
          undefined,
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await controller.backup(
          conn.id,
          { format: 'json', tables: [table] },
          undefined,
        )
      ).content,
    ).toContain('kept');
  }, 120_000);

  it('works again the moment the connection is no longer read-only', async () => {
    const table = uniqueTable('safe_un');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
    );
    const conn = await connection('postgres', { readOnly: true });
    await expect(
      controller.insertRow(conn.id, { table, values: { id: 1 } }, undefined),
    ).rejects.toMatchObject({ status: 403 });
    const stored = await app.connections.resolve(conn.id);
    await controller.update(conn.id, { ...stored, readOnly: false });
    await controller.insertRow(
      conn.id,
      { table, values: { id: 1 } },
      undefined,
    );
    expect(await destRowsOf('postgres', table)).toEqual([{ id: 1 }]);
  }, 120_000);
});

const destRowsOf = (key: ConnKey, table: string) =>
  withAdapter(key, (a) =>
    a.browse({ table, limit: 50, offset: 0 }).then((p) => p.rows),
  );

describe('a read-only connection and bridges', () => {
  async function bridgeInput(
    sourceConn: string,
    source: string,
    destConn: string,
    dest: string,
    trigger: unknown,
  ) {
    const { bridgeInputSchema } = await import('@syncle/core');
    return bridgeInputSchema.parse({
      name: `it-safe-${dest}`,
      source: { kind: 'table', connectionId: sourceConn, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: destConn,
            table: dest,
            keyColumns: ['id'],
            mapping: [],
            createMissingTable: true,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      delivery: { maxAttempts: 1 },
      trigger,
    });
  }

  it('cannot be a destination: refused when the bridge is saved', async () => {
    const src = await connectionFor(app, 'postgres');
    const readOnlyDest = await connection('postgres_dest', { readOnly: true });
    await expect(
      app.bridges.create(
        await bridgeInput(src, 'anything', readOnlyDest.id, 'anywhere', {
          kind: 'replay',
        }),
      ),
    ).rejects.toThrow(
      new RegExp(
        `"${readOnlyDest.name}" is a read-only connection, and a bridge writes to its destination`,
      ),
    );
  });

  it('that BECOMES read-only under a bridge: the next delivery fails, saying why, and writes nothing', async () => {
    const { BridgeJobService } =
      await import('../../src/bridges/bridge-job.service');
    const jobs: any = app.ctx.get(BridgeJobService);
    const source = uniqueTable('safe_bsrc');
    const dest = uniqueTable('safe_bdst');
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES (1, 'a')`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const src = await connectionFor(app, 'postgres');
    const destConn = await connection('postgres_dest', {});
    const bridge = await app.bridges.create(
      await bridgeInput(src, source, destConn.id, dest, { kind: 'replay' }),
    );

    const stored = await app.connections.resolve(destConn.id);
    await controller.update(destConn.id, { ...stored, readOnly: true });

    const started = await jobs.start(bridge.id);
    const job = await waitFor('the job to stop', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j && ['failed', 'completed'].includes(j.status) ? j : null;
    });
    expect(job.status).toBe('failed');
    const failed = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: started.id, status: 'failed' },
    });
    expect(failed.error).toContain(
      `"${destConn.name}" is a read-only connection`,
    );
    expect(await destRows('postgres_dest', dest)).toEqual([]);
  }, 120_000);

  it('CAN be streamed from: a production source is what read-only is for', async () => {
    const source = uniqueTable('safe_cdc');
    const dest = uniqueTable('safe_cdc_dst');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const readOnlySource = await connection('postgres', {
      readOnly: true,
      environment: 'production',
    });
    const dst = await connectionFor(app, 'postgres_dest');
    const bridge = await app.bridges.create(
      await bridgeInput(readOnlySource.id, source, dst, dest, {
        kind: 'cdc',
        operations: ['insert', 'update', 'delete'],
        startFrom: 'beginning',
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });
    await withAdapter('postgres', (a) =>
      a.query(`INSERT INTO "${source}" VALUES (1, 'already there')`),
    );
    await app.cdc.start(bridge.id);
    await withAdapter('postgres', (a) =>
      a.query(`INSERT INTO "${source}" VALUES (2, 'streamed')`),
    );
    await waitFor('both rows', async () =>
      (await destRows('postgres_dest', dest)).length === 2 ? true : null,
    );
    expect((await destRows('postgres_dest', dest)).map((r) => r.name)).toEqual([
      'already there',
      'streamed',
    ]);
  }, 120_000);
});
