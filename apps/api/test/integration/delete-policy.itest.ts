/**
 * What a DELETE at the source does to a target: remove the row, mark it, or
 * leave it — per target, on every engine that has tables.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
let controller: any;
let pg: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  controller = app.ctx.get(BridgesController);
  pg = await connectionFor(app, 'postgres');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));

async function source(): Promise<string> {
  const table = uniqueTable('dp_src');
  await src(`CREATE TABLE "${table}" (id integer PRIMARY KEY, name text)`);
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
  );
  return table;
}

async function liveBridge(
  sourceTable: string,
  targets: Array<Record<string, unknown>>,
  operations = ['insert', 'update', 'delete'],
) {
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-dp-${sourceTable}`,
      source: { kind: 'table', connectionId: pg, table: sourceTable },
      destination: { kind: 'database', targets },
      transform: { template: '{{$row}}' },
      trigger: { kind: 'cdc', operations },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });
  await app.cdc.start(bridge.id);
  return bridge.id as string;
}

/**
 * a stored point in time, as each engine hands it back: PostgreSQL's
 * `2026-09-17 10:00:00.123+00`, MySQL's and SQLite's zone-less UTC text, an ISO
 * string, a Date
 */
function instant(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  let text = String(value).trim().replace(' ', 'T');
  if (/[+-]\d\d$/.test(text)) text += ':00';
  if (!/([zZ]|[+-]\d\d:\d\d)$/.test(text)) text += 'Z';
  return new Date(text).getTime();
}

const byId = (rows: Array<Record<string, unknown>>) =>
  Object.fromEntries(rows.map((r) => [Number(r.id), r]));

for (const dest of [
  'postgres_dest',
  'mysql_dest',
  'sqlite',
  'mongodb',
] as ConnKey[]) {
  describe(`a soft delete, into ${dest}`, () => {
    it('marks the row with the time it was deleted, keeps it — and unmarks it when the row comes back', async () => {
      const table = await source();
      const target = uniqueTable('dp_soft');
      const conn = await connectionFor(app, dest);
      cleanups.push(() =>
        withAdapter(dest, (a) => a.dropTable(target)).then(() => undefined),
      );
      await liveBridge(table, [
        {
          connectionId: conn,
          table: target,
          keyColumns: ['id'],
          mapping: [
            { source: 'id', target: 'id' },
            { source: 'name', target: 'name' },
          ],
          createMissingTable: true,
          onDelete: 'soft',
          softDelete: { column: 'deleted_at' },
        },
      ]);

      await src(`INSERT INTO "${table}" VALUES (1, 'stays'), (2, 'goes')`);
      await waitFor('two rows', async () =>
        (await destRows(dest, target)).length === 2 ? true : null,
      );
      // Syncle created the table: the marker column came with it, empty
      expect(byId(await destRows(dest, target))[2]).toMatchObject({
        name: 'goes',
        deleted_at: null,
      });

      const before = Date.now();
      await src(`DELETE FROM "${table}" WHERE id = 2`);
      const marked = await waitFor('the mark', async () => {
        const row = byId(await destRows(dest, target))[2];
        return row?.deleted_at ? row : null;
      });
      // still there, with everything it had
      expect(marked.name).toBe('goes');
      expect(Math.abs(instant(marked.deleted_at) - before)).toBeLessThan(
        120_000,
      );
      expect(await destRows(dest, target)).toHaveLength(2);
      expect(byId(await destRows(dest, target))[1]!.deleted_at).toBeNull();

      // the same key again at the source: the row is back, and says so
      await src(`INSERT INTO "${table}" VALUES (2, 'back')`);
      await waitFor('the row to be unmarked', async () => {
        const row = byId(await destRows(dest, target))[2];
        return row?.name === 'back' && row.deleted_at === null ? true : null;
      });
    }, 120_000);
  });
}

describe('a soft delete with a true / false marker', () => {
  it('writes false with every row and true on a delete', async () => {
    const table = await source();
    const target = uniqueTable('dp_bool');
    const conn = await connectionFor(app, 'postgres_dest');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(target)).then(
        () => undefined,
      ),
    );
    await liveBridge(table, [
      {
        connectionId: conn,
        table: target,
        keyColumns: ['id'],
        mapping: [],
        createMissingTable: true,
        onDelete: 'soft',
        softDelete: { column: 'is_deleted', value: 'boolean' },
      },
    ]);
    await src(`INSERT INTO "${table}" VALUES (1, 'a'), (2, 'b')`);
    await waitFor('two rows', async () =>
      (await destRows('postgres_dest', target)).length === 2 ? true : null,
    );
    expect(
      (await destRows('postgres_dest', target)).map((r) => r.is_deleted),
    ).toEqual([false, false]);
    await src(`DELETE FROM "${table}" WHERE id = 1`);
    await waitFor('the mark', async () =>
      byId(await destRows('postgres_dest', target))[1]?.is_deleted === true
        ? true
        : null,
    );
    const type = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = '${target}' AND column_name = 'is_deleted'`,
      ),
    );
    expect(type.rows[0]?.data_type).toBe('boolean');
  }, 120_000);
});

describe('one bridge, three targets, three policies', () => {
  it('each does its own thing with the same delete — and with the source being emptied', async () => {
    const table = await source();
    const conn = await connectionFor(app, 'postgres_dest');
    const [hard, soft, kept] = [
      uniqueTable('dp_hard'),
      uniqueTable('dp_mark'),
      uniqueTable('dp_keep'),
    ];
    for (const t of [hard, soft, kept])
      cleanups.push(() =>
        withAdapter('postgres_dest', (a) => a.dropTable(t)).then(
          () => undefined,
        ),
      );
    const base = {
      connectionId: conn,
      keyColumns: ['id'],
      mapping: [],
      createMissingTable: true,
    };
    const bridgeId = await liveBridge(
      table,
      [
        { ...base, table: hard },
        {
          ...base,
          table: soft,
          onDelete: 'soft',
          softDelete: { column: 'deleted_at' },
        },
        { ...base, table: kept, onDelete: 'ignore' },
      ],
      ['insert', 'update', 'delete', 'truncate'],
    );
    await src(`INSERT INTO "${table}" VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    await waitFor('three rows everywhere', async () => {
      const counts = await Promise.all(
        [hard, soft, kept].map(
          async (t) => (await destRows('postgres_dest', t)).length,
        ),
      );
      return counts.every((n) => n === 3) ? true : null;
    });

    await src(`DELETE FROM "${table}" WHERE id = 2`);
    await waitFor('the delete', async () =>
      (await destRows('postgres_dest', hard)).length === 2 ? true : null,
    );
    await waitFor('the mark', async () =>
      byId(await destRows('postgres_dest', soft))[2]?.deleted_at ? true : null,
    );
    expect(
      (await destRows('postgres_dest', kept)).map((r) => Number(r.id)),
    ).toEqual([1, 2, 3]);
    // the target that ignores deletes has no marker column: nothing was asked of it
    expect(byId(await destRows('postgres_dest', kept))[2]).not.toHaveProperty(
      'deleted_at',
    );

    // and the timeline says what each target did with it
    const job = await app.prisma.bridgeJob.findFirst({ where: { bridgeId } });
    const del = await waitFor('the delete to be recorded', () =>
      app.prisma.bridgeDelivery.findFirst({
        where: { jobId: job.id, op: 'delete', status: 'success' },
      }),
    );
    expect(del.responseBody).toMatch(new RegExp(`${hard}: deleted 1`));
    expect(del.responseBody).toMatch(
      new RegExp(`${soft}: marked as deleted 1`),
    );
    expect(del.responseBody).toMatch(
      new RegExp(
        `${kept}: delete not applied \\(this target ignores deletes\\)`,
      ),
    );

    // TRUNCATE: only the target that mirrors deletes is emptied
    await src(`TRUNCATE "${table}"`);
    await waitFor('the truncate', async () =>
      (await destRows('postgres_dest', hard)).length === 0 ? true : null,
    );
    expect(await destRows('postgres_dest', kept)).toHaveLength(3);
    expect(await destRows('postgres_dest', soft)).toHaveLength(3);
    const trunc = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: job.id, op: 'truncate' },
    });
    expect(trunc.status).toBe('success');
    expect(trunc.responseBody).toContain(
      'truncate not applied (this target soft-deletes',
    );
    expect(trunc.responseBody).toContain(
      'truncate not applied (this target ignores deletes)',
    );
  }, 120_000);
});

describe('a soft delete into a table that already exists', () => {
  it('the dry run says the marker column is missing, before every write fails for it', async () => {
    const table = await source();
    await src(`INSERT INTO "${table}" VALUES (1, 'a')`);
    const target = uniqueTable('dp_existing');
    await withAdapter('postgres_dest', (a) =>
      a.query(`CREATE TABLE "${target}" (id integer PRIMARY KEY, name text)`),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(target)).then(
        () => undefined,
      ),
    );
    const conn = await connectionFor(app, 'postgres_dest');
    const draft = (extra: Record<string, unknown>) => ({
      bridge: {
        name: 'draft',
        source: { kind: 'table', connectionId: pg, table },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: conn,
              table: target,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: true,
              ...extra,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
      },
    });
    const { bridgeDraftPreviewSchema } = await import('@syncle/core');
    const missing = await controller.previewDraft(
      bridgeDraftPreviewSchema.parse(
        draft({ onDelete: 'soft', softDelete: { column: 'deleted_at' } }),
      ),
    );
    expect(JSON.stringify(missing)).toContain(
      `\\"${target}\\" has no column \\"deleted_at\\"`,
    );

    await withAdapter('postgres_dest', (a) =>
      a.query(`ALTER TABLE "${target}" ADD COLUMN deleted_at timestamptz`),
    );
    const present = await controller.previewDraft(
      bridgeDraftPreviewSchema.parse(
        draft({ onDelete: 'soft', softDelete: { column: 'deleted_at' } }),
      ),
    );
    expect(JSON.stringify(present)).not.toContain('has no column');
    const hardDelete = await controller.previewDraft(
      bridgeDraftPreviewSchema.parse(draft({})),
    );
    expect(JSON.stringify(hardDelete)).not.toContain('has no column');
  }, 120_000);
});
