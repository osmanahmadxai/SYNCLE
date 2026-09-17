/**
 * A source table that changes under its bridge — with real ALTER TABLEs.
 *
 * The case that matters most is the first: a column the bridge maps is renamed.
 * Every row from then on has no value under the old name, and what the bridge
 * used to do with that was write NULL over the value the destination held, row
 * by row as they changed, every delivery green.
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
let controller: any;
let jobs: any;
let pg: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  controller = app.ctx.get(BridgesController);
  jobs = app.ctx.get(BridgeJobService);
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));

async function setup(opts: {
  mapping?: string[];
  trigger: unknown;
  onSchemaChange?: string;
}) {
  const source = uniqueTable('sd_src');
  const dest = uniqueTable('sd_dst');
  await src(
    `CREATE TABLE "${source}" (id integer PRIMARY KEY, email text, name text); INSERT INTO "${source}" VALUES (1, 'ada@example.com', 'Ada')`,
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
  );
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-sd-${source}`,
      source: { kind: 'table', connectionId: pg, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            keyColumns: ['id'],
            mapping: (opts.mapping ?? []).map((c) => ({
              source: c,
              target: c,
            })),
            createMissingTable: true,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      delivery: {
        maxAttempts: 1,
        ...(opts.onSchemaChange ? { onSchemaChange: opts.onSchemaChange } : {}),
      },
      trigger: opts.trigger,
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });
  return { id: bridge.id as string, source, dest };
}

const CDC = {
  kind: 'cdc',
  operations: ['insert', 'update', 'delete'],
  startFrom: 'beginning',
};
const rowsOf = async (dest: string) =>
  Object.fromEntries(
    (await destRows('postgres_dest', dest)).map((r) => [Number(r.id), r]),
  );

describe('a live bridge, and a column it MAPS is renamed', () => {
  it('stops before writing NULL over what the destination holds — and says which column', async () => {
    const b = await setup({ mapping: ['id', 'email', 'name'], trigger: CDC });
    await app.cdc.start(b.id);
    await waitFor('the copy', async () =>
      (await rowsOf(b.dest))[1]?.email === 'ada@example.com' ? true : null,
    );

    await src(`ALTER TABLE "${b.source}" RENAME COLUMN email TO mail`);
    // this row has no `email` any more: the old behaviour wrote email = NULL over ada@example.com
    await src(`UPDATE "${b.source}" SET name = 'Ada L.' WHERE id = 1`);

    const job = await waitFor('the bridge to stop', async () => {
      const j = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: b.id },
      });
      return j?.status === 'failed' ? j : null;
    });
    expect(job.error).toMatch(
      /has changed, and this bridge uses a column that is gone: email/,
    );
    expect(job.error).toMatch(/Stopped before writing NULL/);
    expect(job.error).toMatch(/removed: email; added: mail \(text\)/);
    // the destination is exactly as it was: not nulled, and not half-updated
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada',
    });

    // it does not start again as it is …
    await expect(app.cdc.start(b.id)).rejects.toMatchObject({
      details: { reason: 'schema-drift' },
    });
    const status = await controller.schemaDrift(b.id);
    expect(status).toMatchObject({
      missingUsed: ['email'],
      drift: {
        removed: [{ name: 'email' }],
        added: [{ name: 'mail', type: 'text' }],
      },
    });

    // … but does once the bridge is edited for the table as it is now. saving accepts it
    const bridge = await app.bridges.get(b.id);
    await controller.update(b.id, {
      ...bridge,
      destination: {
        ...bridge.destination,
        targets: [
          {
            ...bridge.destination.targets[0],
            mapping: [
              { source: 'id', target: 'id' },
              { source: 'mail', target: 'email' },
              { source: 'name', target: 'name' },
            ],
          },
        ],
      },
    });
    expect((await controller.schemaDrift(b.id)).drift).toBeNull();
    await app.cdc.start(b.id);
    // the update that was NOT delivered is read again, and lands — correctly this time
    await waitFor('the held-back update', async () =>
      (await rowsOf(b.dest))[1]?.name === 'Ada L.' ? true : null,
    );
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada L.',
    });
  }, 120_000);

  it('accepting the change is not a way around it — by the button, or by saving the bridge as it was', async () => {
    const b = await setup({
      mapping: ['id', 'email', 'name'],
      trigger: { kind: 'replay' },
    });
    const first = await jobs.start(b.id);
    await waitFor('the first run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: first.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
    await src(`ALTER TABLE "${b.source}" DROP COLUMN email`);

    await expect(controller.acceptSchemaDrift(b.id)).rejects.toMatchObject({
      message: expect.stringMatching(
        /still uses email, which the table no longer has/,
      ),
      details: { reason: 'schema-drift', missingUsed: ['email'] },
    });
    // saved with the mapping it had (a new name, say): the change is NOT forgotten
    const bridge = await app.bridges.get(b.id);
    await controller.update(b.id, {
      ...bridge,
      name: `${bridge.name}-renamed`,
    });
    expect((await controller.schemaDrift(b.id)).missingUsed).toEqual(['email']);
    const second = await jobs.start(b.id);
    const job = await waitFor('the second run to stop', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: second.id },
      });
      return j && ['failed', 'completed'].includes(j.status) ? j : null;
    });
    expect(job.status).toBe('failed');
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
    });

    // saved WITHOUT the column: accepted, and it runs
    await controller.update(b.id, {
      ...bridge,
      destination: {
        ...bridge.destination,
        targets: [
          {
            ...bridge.destination.targets[0],
            mapping: [
              { source: 'id', target: 'id' },
              { source: 'name', target: 'name' },
            ],
          },
        ],
      },
    });
    expect(await controller.schemaDrift(b.id)).toMatchObject({
      drift: null,
      missingUsed: [],
    });
    const third = await jobs.start(b.id);
    await waitFor('the third run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: third.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
    // what the destination held for the column that went is still there
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada',
    });
  }, 120_000);

  it('pointed at ANOTHER table: the old table’s columns say nothing about it', async () => {
    const b = await setup({
      mapping: ['id', 'email'],
      trigger: { kind: 'replay' },
    });
    const first = await jobs.start(b.id);
    await waitFor('the first run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: first.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
    const other = uniqueTable('sd_other');
    await src(
      `CREATE TABLE "${other}" (id integer PRIMARY KEY, mail text); INSERT INTO "${other}" VALUES (7, 'g@example.com')`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(other)).then(() => undefined),
    );
    const bridge = await app.bridges.get(b.id);
    await controller.update(b.id, {
      ...bridge,
      source: { ...bridge.source, table: other },
      destination: {
        ...bridge.destination,
        targets: [
          {
            ...bridge.destination.targets[0],
            mapping: [
              { source: 'id', target: 'id' },
              { source: 'mail', target: 'email' },
            ],
          },
        ],
      },
    });
    expect(await controller.schemaDrift(b.id)).toMatchObject({
      drift: null,
      missingUsed: [],
    });
    const second = await jobs.start(b.id);
    await waitFor('the second run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: second.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
    expect((await rowsOf(b.dest))[7]).toMatchObject({ email: 'g@example.com' });
  }, 120_000);

  it('set to `continue`: carries on as it always did, and the drift is there to be seen', async () => {
    const b = await setup({
      mapping: ['id', 'email', 'name'],
      trigger: CDC,
      onSchemaChange: 'continue',
    });
    await app.cdc.start(b.id);
    await waitFor('the copy', async () =>
      (await rowsOf(b.dest))[1] ? true : null,
    );
    await src(`ALTER TABLE "${b.source}" DROP COLUMN email`);
    await src(`UPDATE "${b.source}" SET name = 'Ada L.' WHERE id = 1`);
    await waitFor('the update', async () =>
      (await rowsOf(b.dest))[1]?.name === 'Ada L.' ? true : null,
    );
    // this is what every bridge did before there was a choice, and why `stop` is the default:
    // the address the destination held is gone, and the delivery that erased it is green
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: null,
      name: 'Ada L.',
    });
    const job = await app.prisma.bridgeJob.findFirst({
      where: { bridgeId: b.id },
    });
    expect(job.status).toBe('running');
    expect(job.failedCount).toBe(0);
    expect((await controller.schemaDrift(b.id)).missingUsed).toEqual(['email']);
  }, 120_000);
});

describe('a column is ADDED', () => {
  it('nothing the bridge uses is gone: it carries on, and the panel says the copy is now narrower than the original', async () => {
    const b = await setup({ mapping: ['id', 'email', 'name'], trigger: CDC });
    await app.cdc.start(b.id);
    await waitFor('the copy', async () =>
      (await rowsOf(b.dest))[1] ? true : null,
    );
    await src(`ALTER TABLE "${b.source}" ADD COLUMN plan text DEFAULT 'free'`);
    await src(
      `INSERT INTO "${b.source}" (id, email, name) VALUES (2, 'grace@example.com', 'Grace')`,
    );
    await waitFor('the new row', async () =>
      (await rowsOf(b.dest))[2] ? true : null,
    );
    expect(
      (await app.prisma.bridgeJob.findFirst({ where: { bridgeId: b.id } }))
        .status,
    ).toBe('running');
    const status = await controller.schemaDrift(b.id);
    expect(status).toMatchObject({
      missingUsed: [],
      drift: {
        added: [{ name: 'plan', type: 'text' }],
        removed: [],
        retyped: [],
      },
    });
    // accepted: not drift any more
    expect((await controller.acceptSchemaDrift(b.id)).drift).toBeNull();
  }, 120_000);

  it('`evolve`: is added to a target that takes the row as it comes — and the rows carry it', async () => {
    const b = await setup({ trigger: CDC, onSchemaChange: 'evolve' });
    await app.cdc.start(b.id);
    await waitFor('the copy', async () =>
      (await rowsOf(b.dest))[1] ? true : null,
    );
    await src(
      `ALTER TABLE "${b.source}" ADD COLUMN plan text, ADD COLUMN seats integer`,
    );
    await src(
      `INSERT INTO "${b.source}" VALUES (2, 'grace@example.com', 'Grace', 'team', 12)`,
    );
    await waitFor('the new row, with the new columns', async () =>
      (await rowsOf(b.dest))[2]?.plan === 'team' ? true : null,
    );
    expect((await rowsOf(b.dest))[2]).toMatchObject({
      plan: 'team',
      seats: 12,
    });
    // the row that was already there has no value for them, and is otherwise untouched
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
      plan: null,
      seats: null,
    });
    const types = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${b.dest}' AND column_name IN ('plan', 'seats') ORDER BY column_name`,
      ),
    );
    expect(types.rows).toEqual([
      { column_name: 'plan', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'seats', data_type: 'integer', is_nullable: 'YES' },
    ]);
    // …and with that the table is what the bridge is built for again
    expect((await controller.schemaDrift(b.id)).drift).toBeNull();
    expect(
      (await app.prisma.bridgeJob.findFirst({ where: { bridgeId: b.id } }))
        .status,
    ).toBe('running');
  }, 120_000);

  it('without `evolve`, the same change into the same kind of target stops nothing and alters nothing', async () => {
    const b = await setup({ trigger: CDC });
    await app.cdc.start(b.id);
    await waitFor('the copy', async () =>
      (await rowsOf(b.dest))[1] ? true : null,
    );
    await src(`ALTER TABLE "${b.source}" ADD COLUMN plan text`);
    await src(
      `INSERT INTO "${b.source}" VALUES (2, 'g@example.com', 'Grace', 'team')`,
    );
    // the row now has a column the destination does not: that delivery fails, as it always has —
    // loudly, with the engine's own words — and the bridge (on failure: abort) stops there
    const job = await waitFor('the bridge to stop', async () => {
      const j = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: b.id },
      });
      return j && j.status !== 'running' ? j : null;
    });
    expect(job.error ?? '').toMatch(/abort/);
    const cols = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${b.dest}'`,
      ),
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      'email',
      'id',
      'name',
    ]);
  }, 120_000);
});

describe('a bridge made through the API', () => {
  it('is built for the table as it was THAT day: a change before its first run is a change', async () => {
    const source = uniqueTable('sd_src');
    await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, email text)`);
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    // (parsed as the route's pipe parses it: the controller is called directly here)
    const created = await controller.create(
      bridgeInputSchema.parse({
        name: `it-sd-${source}`,
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: `${source}_dst`,
              keyColumns: ['id'],
              mapping: [
                { source: 'id', target: 'id' },
                { source: 'email', target: 'email' },
              ],
              createMissingTable: true,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
      }),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(`${source}_dst`)).then(
        () => undefined,
      ),
    );
    expect(
      (await controller.schemaDrift(created.id)).baselineAt,
    ).not.toBeNull();
    await src(`ALTER TABLE "${source}" RENAME COLUMN email TO mail`);
    expect(await controller.schemaDrift(created.id)).toMatchObject({
      missingUsed: ['email'],
    });
  }, 120_000);
});

describe('a replay', () => {
  it('is refused at the start when a column it maps is gone — before a single row is read', async () => {
    const b = await setup({
      mapping: ['id', 'email'],
      trigger: { kind: 'replay' },
    });
    const first = await jobs.start(b.id);
    await waitFor('the first run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: first.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
    });

    await src(`ALTER TABLE "${b.source}" DROP COLUMN email`);
    const second = await jobs.start(b.id);
    const job = await waitFor('the second run to stop', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: second.id },
      });
      return j && ['failed', 'completed'].includes(j.status) ? j : null;
    });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/uses a column that is gone: email/);
    expect(
      await app.prisma.bridgeDelivery.count({ where: { jobId: second.id } }),
    ).toBe(0);
    expect((await rowsOf(b.dest))[1]).toMatchObject({
      email: 'ada@example.com',
    });
  }, 120_000);

  it('changed UNDER a running replay: stops at the first page that comes back different, with nothing nulled', async () => {
    const source = uniqueTable('sd_src');
    const dest = uniqueTable('sd_dst');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, email text); INSERT INTO "${source}" SELECT g, 'u' || g || '@example.com' FROM generate_series(1, 8) g`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-sd-${source}`,
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: [
                { source: 'id', target: 'id' },
                { source: 'email', target: 'email' },
              ],
              createMissingTable: true,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        // two rows a page, one a delivery, slowly: the table changes between two pages
        delivery: { pageSize: 2, batchSize: 1, minDelayMs: 250 },
        trigger: { kind: 'replay' },
      }),
    );
    const job = await jobs.start(bridge.id);
    await waitFor('the first delivery', async () =>
      (await app.prisma.bridgeDelivery.count({
        where: { jobId: job.id, status: 'success' },
      })) >= 1
        ? true
        : null,
    );
    await src(`ALTER TABLE "${source}" RENAME COLUMN email TO mail`);
    const ended = await waitFor('the replay to stop', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: job.id },
      });
      return j && ['failed', 'completed'].includes(j.status) ? j : null;
    });
    expect(ended.status).toBe('failed');
    expect(ended.error).toMatch(/uses a column that is gone: email/);
    const rows = await destRows('postgres_dest', dest);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThan(8);
    // every row that did arrive has its address: none was written from the table as it became
    expect(rows.filter((r) => r.email === null)).toEqual([]);
  }, 120_000);

  it('a type that changed is noted, not fatal', async () => {
    const b = await setup({
      mapping: ['id', 'name'],
      trigger: { kind: 'replay' },
    });
    const first = await jobs.start(b.id);
    await waitFor('the first run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: first.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
    await src(`ALTER TABLE "${b.source}" ALTER COLUMN name TYPE varchar(80)`);
    expect((await controller.schemaDrift(b.id)).drift.retyped).toEqual([
      { name: 'name', from: 'text', to: 'character varying(80)' },
    ]);
    const second = await jobs.start(b.id);
    await waitFor('the second run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: second.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );
  }, 120_000);
});

describe('a polling bridge', () => {
  it('stops at the row whose columns are not the last row’s — before delivering it', async () => {
    const { BridgeWatchService } =
      await import('../../src/bridges/bridge-watch.service');
    const watch = app.ctx.get(BridgeWatchService);
    const b = await setup({
      mapping: ['id', 'email', 'name'],
      trigger: {
        kind: 'watch',
        strategy: { strategy: 'increment', column: 'id' },
        pollIntervalMs: 1000,
        startFrom: 'now',
      },
    });
    cleanups.push(() =>
      watch
        .stop(b.id)
        .then(() => undefined)
        .catch(() => undefined),
    );
    await watch.start(b.id);
    await src(
      `INSERT INTO "${b.source}" VALUES (2, 'grace@example.com', 'Grace')`,
    );
    await waitFor('the first new row', async () =>
      (await rowsOf(b.dest))[2]?.email === 'grace@example.com' ? true : null,
    );

    await src(`ALTER TABLE "${b.source}" RENAME COLUMN email TO mail`);
    await src(
      `INSERT INTO "${b.source}" VALUES (3, 'linus@example.com', 'Linus')`,
    );
    const job = await waitFor('the bridge to stop', async () => {
      const j = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: b.id },
        orderBy: { startedAt: 'desc' },
      });
      return j?.status === 'failed' ? j : null;
    });
    expect(job.error).toMatch(/uses a column that is gone: email/);
    // row 3 was NOT written with a NULL email: it was not written at all
    expect((await rowsOf(b.dest))[3]).toBeUndefined();
    await expect(watch.start(b.id)).rejects.toMatchObject({
      details: { reason: 'schema-drift' },
    });
  }, 120_000);
});

describe('`evolve` into MySQL', () => {
  it('adds the column with MySQL’s type for it', async () => {
    const mysqlDest = await connectionFor(app, 'mysql_dest');
    const source = uniqueTable('sd_src');
    const dest = uniqueTable('sd_my');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES (1, 'Ada')`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('mysql_dest', (a) => a.dropTable(dest)).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-sd-${source}`,
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: mysqlDest,
              table: dest,
              keyColumns: ['id'],
              createMissingTable: true,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        delivery: { onSchemaChange: 'evolve' },
        trigger: { kind: 'replay' },
      }),
    );
    const first = await jobs.start(bridge.id);
    await waitFor('the first run', async () =>
      (await app.prisma.bridgeJob.findUnique({ where: { id: first.id } }))
        ?.status === 'completed'
        ? true
        : null,
    );

    await src(
      `ALTER TABLE "${source}" ADD COLUMN seats integer, ADD COLUMN joined timestamptz`,
    );
    await src(
      `UPDATE "${source}" SET seats = 12, joined = '2026-01-02T03:04:05Z'`,
    );
    const second = await jobs.start(bridge.id);
    const job = await waitFor('the second run', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: second.id },
      });
      return j && ['failed', 'completed'].includes(j.status) ? j : null;
    });
    const failures = await app.prisma.bridgeDelivery.findMany({
      where: { jobId: second.id, status: 'failed' },
    });
    expect(failures.map((f: { error: string | null }) => f.error)).toEqual([]);
    expect(job).toMatchObject({ status: 'completed', failedCount: 0 });
    const rows = await destRows('mysql_dest', dest);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.seats)).toBe(12);
    // an instant lands in MySQL as UTC wall-clock, exactly as it does in a table Syncle creates
    expect(String(rows[0]!.joined)).toBe('2026-01-02 03:04:05.000000');
    const cols = await withAdapter('mysql_dest', (a) =>
      a.query(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.columns WHERE table_name = '${dest}' AND COLUMN_NAME IN ('seats', 'joined') ORDER BY COLUMN_NAME`,
      ),
    );
    expect(cols.rows.map((r) => [r.name, r.nullable])).toEqual([
      ['joined', 'YES'],
      ['seats', 'YES'],
    ]);
    expect(cols.rows.map((r) => String(r.type))).toEqual(['datetime', 'int']);
  }, 120_000);
});

describe('a source with no schema to drift', () => {
  it('is left alone: a document’s shape is not a schema', async () => {
    const mongo = await connectionFor(app, 'mongodb');
    const coll = uniqueTable('sd_mongo');
    await withAdapter('mongodb', (a) =>
      a.insertRow({ table: coll, values: { id: 1, name: 'a' } }),
    );
    cleanups.push(() =>
      withAdapter('mongodb', (a) => a.dropTable(coll)).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-sd-${coll}`,
        source: { kind: 'table', connectionId: mongo, table: coll },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: `${coll}_dst`,
              keyColumns: ['id'],
              mapping: [{ source: 'id', target: 'id' }],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
      }),
    );
    expect(await controller.schemaDrift(bridge.id)).toMatchObject({
      baselineAt: null,
      drift: null,
      missingUsed: [],
    });
  }, 120_000);
});
