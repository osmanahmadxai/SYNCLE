/**
 * The builder's dry run: what a bridge WOULD do, for a draft that has not been
 * saved. The point of it is that nothing happens — so most of what is checked
 * here is absence: no table, no bridge, nothing left in a cache.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, withAdapter } from './harness';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

let app: AppHandle;
let controller: any;
let sink: any;
let pg: string;
let pgDest: string;
let sqlite: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { DatabaseSinkService } =
    await import('../../src/bridges/database-sink.service');
  controller = app.ctx.get(BridgesController);
  sink = app.ctx.get(DatabaseSinkService);
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
  sqlite = await connectionFor(app, 'sqlite');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function sourceTable(): Promise<string> {
  const table = uniqueTable('dry_src');
  await withAdapter('postgres', (a) =>
    a.query(
      `CREATE TABLE "${table}" (id integer PRIMARY KEY, name text NOT NULL, amount numeric(38,10), seen timestamptz, tags jsonb);
       INSERT INTO "${table}" VALUES (1, 'Ada', 12.5, '2026-01-02T03:04:05Z', '["a"]'), (2, 'Grace', NULL, NULL, NULL)`,
    ),
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) =>
      a.query(`DROP TABLE IF EXISTS "${table}"`),
    ).then(() => undefined),
  );
  return table;
}

const draft = async (over: Record<string, unknown>) => {
  const { bridgeDraftPreviewSchema } = await import('@syncle/core');
  return bridgeDraftPreviewSchema.parse({
    bridge: {
      name: 'a draft',
      transform: {},
      trigger: { kind: 'replay' },
      ...over,
    },
  });
};

const tableExists = (
  engine: 'postgres_dest' | 'sqlite',
  table: string,
): Promise<boolean> =>
  withAdapter(engine, (a) => a.browse({ table, limit: 1, offset: 0 })).then(
    () => true,
    () => false,
  );

describe('a dry run of an unsaved bridge', () => {
  it('shows the table a run would create — and creates nothing', async () => {
    const source = await sourceTable();
    const dest = uniqueTable('dry_dst');
    const bridgesBefore = await app.prisma.bridge.count();

    const preview = await controller.previewDraft(
      await draft({
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: true,
            },
          ],
        },
      }),
    );

    expect(preview.destinationKind).toBe('database');
    expect(preview.fromSource).toBe(true);
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]).toMatchObject({
      label: dest,
      exists: false,
      createMissingTable: true,
    });
    const planned = Object.fromEntries(
      preview.targets[0].plannedColumns.map(
        (c: { name: string; type: string }) => [c.name, c.type],
      ),
    );
    // same engine: the source's own types, precision and all
    expect(planned).toMatchObject({
      id: 'integer',
      amount: 'numeric(38,10)',
      tags: 'jsonb',
    });
    expect(
      preview.targets[0].plannedColumns.find(
        (c: { name: string }) => c.name === 'id',
      ),
    ).toMatchObject({
      primaryKey: true,
      nullable: false,
    });
    expect(preview.bodies).toHaveLength(2);
    expect(preview.bodies[0]).toMatchObject({ id: 1, name: 'Ada' });

    // the whole point
    expect(await tableExists('postgres_dest', dest)).toBe(false);
    expect(await app.prisma.bridge.count()).toBe(bridgesBefore);
  });

  it('warns about a type the target cannot hold faithfully, before the first row is written', async () => {
    const source = await sourceTable();
    const dest = uniqueTable('dry_lite');
    const preview = await controller.previewDraft(
      await draft({
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: sqlite,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: true,
            },
          ],
        },
      }),
    );
    // SQLite keeps 15 significant digits in a NUMERIC column: 38 do not fit
    const amount = preview.targets[0].plannedColumns.find(
      (c: { name: string }) => c.name === 'amount',
    );
    expect(amount.type).toBe('TEXT');
    expect(preview.warnings.join('\n')).toMatch(/amount/);
    expect(await tableExists('sqlite', dest)).toBe(false);
  });

  it('says so when the table is missing and nothing would create it', async () => {
    const source = await sourceTable();
    const dest = uniqueTable('dry_missing');
    const preview = await controller.previewDraft(
      await draft({
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: false,
            },
          ],
        },
      }),
    );
    expect(preview.targets[0]).toMatchObject({ exists: false });
    expect(preview.targets[0].plannedColumns).toBeUndefined();
    expect(preview.warnings.join('\n')).toMatch(
      /does not exist and auto-create is off/,
    );
  });

  it('leaves an existing table alone and plans nothing for it', async () => {
    const source = await sourceTable();
    const dest = uniqueTable('dry_exists');
    await withAdapter('postgres_dest', (a) =>
      a.query(`CREATE TABLE "${dest}" (id integer PRIMARY KEY, name text)`),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) =>
        a.query(`DROP TABLE IF EXISTS "${dest}"`),
      ).then(() => undefined),
    );
    const preview = await controller.previewDraft(
      await draft({
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: true,
            },
          ],
        },
      }),
    );
    expect(preview.targets[0]).toMatchObject({ exists: true });
    expect(preview.targets[0].plannedColumns).toBeUndefined();
  });

  it('renders an HTTP payload without sending it, and without showing the secret', async () => {
    const source = await sourceTable();
    const preview = await controller.previewDraft(
      await draft({
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'http',
          url: 'https://example.test/hook',
          method: 'PUT',
          auth: { type: 'bearer', token: 'sk-live-do-not-leak' },
        },
        transform: { template: '{"who": "{{name}}"}' },
      }),
    );
    expect(preview).toMatchObject({
      destinationKind: 'http',
      method: 'PUT',
      url: 'https://example.test/hook',
    });
    expect(preview.bodies).toEqual([{ who: 'Ada' }, { who: 'Grace' }]);
    expect(JSON.stringify(preview)).not.toContain('sk-live-do-not-leak');
  });

  it('renders against a sample row when asked, without touching the source', async () => {
    const parsed = await draft({
      source: {
        kind: 'table',
        connectionId: pg,
        table: 'a_table_that_does_not_exist',
      },
      destination: { kind: 'http', url: 'https://example.test/hook' },
      transform: { template: '{"n": "{{n}}"}' },
    });
    const preview = await controller.previewDraft({
      ...parsed,
      sampleRow: { n: 7 },
    });
    expect(preview.fromSource).toBe(false);
    // a token that is the whole value keeps its type
    expect(preview.bodies).toEqual([{ n: 7 }]);
  });

  it('leaves nothing in the sink’s per-bridge caches', async () => {
    const source = await sourceTable();
    const sizes = () =>
      Object.values(sink as Record<string, unknown>)
        .filter(
          (v): v is Map<unknown, unknown> | Set<unknown> =>
            v instanceof Map || v instanceof Set,
        )
        .map(
          (v) =>
            [...(v instanceof Map ? v.keys() : v)].filter((k) =>
              String(k).includes('draft:'),
            ).length,
        );
    await controller.previewDraft(
      await draft({
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: uniqueTable('dry_cache'),
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: true,
            },
          ],
        },
      }),
    );
    expect(sizes().every((n) => n === 0)).toBe(true);
  });

  it('refuses a draft that is not a valid bridge', async () => {
    const { bridgeDraftPreviewSchema } = await import('@syncle/core');
    expect(
      bridgeDraftPreviewSchema.safeParse({ bridge: { name: '' } }).success,
    ).toBe(false);
  });
});
