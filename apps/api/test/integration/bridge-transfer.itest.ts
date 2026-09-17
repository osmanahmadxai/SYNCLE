/**
 * Bridges as a file, and back: what leaves with an export (configuration), what
 * never does (anything secret), and how an import finds this instance's
 * connections for the ones the file talks about.
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
let pg: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  controller = app.ctx.get(BridgesController);
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function httpBridge(name: string, auth: unknown) {
  const { bridgeInputSchema } = await import('@syncle/core');
  return app.bridges.create(
    bridgeInputSchema.parse({
      name,
      source: {
        kind: 'table',
        connectionId: pg,
        table: 'anything',
        filters: [{ column: 'age', operator: 'gte', value: 18 }],
      },
      destination: {
        kind: 'http',
        url: 'https://example.com/hook',
        method: 'PUT',
        headers: { 'X-Env': 'prod' },
        auth,
        idempotency: true,
      },
      transform: {
        template: '{{$row}}',
        wrapKey: 'user',
        columns: [
          { kind: 'mask', column: 'email', mode: 'hash', salt: 'pepper' },
        ],
      },
      delivery: { batchSize: 25, onError: 'continue' },
      trigger: {
        kind: 'cdc',
        operations: ['insert', 'delete'],
        startFrom: 'beginning',
      },
    }),
  );
}

async function dbBridge(name: string, source: string, dest: string) {
  const { bridgeInputSchema } = await import('@syncle/core');
  return app.bridges.create(
    bridgeInputSchema.parse({
      name,
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
            onDelete: 'soft',
            softDelete: { column: 'gone_at' },
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: { kind: 'replay' },
    }),
  );
}

describe('an export', () => {
  it('is the whole configuration — and not one secret', async () => {
    const name = `export ${uniqueTable('x')}`;
    const bridge = await httpBridge(name, {
      type: 'bearer',
      token: 'tok_live_SECRET',
    });
    const doc = await controller.exportOne(bridge.id);

    expect(doc).toMatchObject({ format: 'syncle.bridges', version: 1 });
    expect(doc.bridges).toHaveLength(1);
    expect(doc.bridges[0]).toMatchObject({
      name,
      source: {
        table: 'anything',
        filters: [{ column: 'age', operator: 'gte', value: 18 }],
      },
      destination: {
        kind: 'http',
        url: 'https://example.com/hook',
        method: 'PUT',
        headers: { 'X-Env': 'prod' },
        idempotency: true,
      },
      transform: {
        wrapKey: 'user',
        columns: [
          { kind: 'mask', column: 'email', mode: 'hash', salt: 'pepper' },
        ],
      },
      delivery: { batchSize: 25, onError: 'continue' },
      trigger: {
        kind: 'cdc',
        operations: ['insert', 'delete'],
        startFrom: 'beginning',
      },
    });
    // the credential leaves EMPTY: not as itself, and not as the mask the API
    // shows for it — imported, `********` would BE the token
    expect(doc.bridges[0].destination.auth).toEqual({
      type: 'bearer',
      token: '',
    });
    const text = JSON.stringify(doc);
    expect(text).not.toContain('tok_live_SECRET');
    expect(text).not.toContain('********');

    // a connection is a name and an engine. where it points, and as whom, stays here
    expect(doc.connections[pg]).toEqual({
      name: expect.stringContaining('it-postgres'),
      engine: 'postgres',
    });
    for (const secret of ['password', 'syncle', '55432', '127.0.0.1'])
      expect(JSON.stringify(doc.connections)).not.toContain(secret);
    // no ids of this instance's bridges, no timestamps of theirs
    expect(doc.bridges[0]).not.toHaveProperty('id');
    expect(doc.bridges[0]).not.toHaveProperty('workspaceId');
    expect(doc.bridges[0]).not.toHaveProperty('createdAt');
  });

  it('of a header credential keeps the header’s name, not its value', async () => {
    const bridge = await httpBridge(`export ${uniqueTable('h')}`, {
      type: 'header',
      name: 'X-Api-Key',
      value: 'k_SECRET',
    });
    const doc = await controller.exportOne(bridge.id);
    expect(doc.bridges[0].destination.auth).toEqual({
      type: 'header',
      name: 'X-Api-Key',
      value: '',
    });
    expect(JSON.stringify(doc)).not.toContain('k_SECRET');
  });

  it('of a workspace is every bridge in it; of a bridge that does not exist is a 404', async () => {
    const all = await controller.exportAll(undefined);
    expect(all.bridges.length).toBeGreaterThanOrEqual(2);
    await expect(controller.exportOne('no-such-bridge')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('an import', () => {
  it('into the instance it came from finds its connections by id, and the bridge RUNS', async () => {
    const source = uniqueTable('tr_src');
    const dest = uniqueTable('tr_dst');
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES (1, 'a'), (2, 'b')`,
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
    const original = await dbBridge(`transfer ${source}`, source, dest);
    const doc = JSON.parse(
      JSON.stringify(await controller.exportOne(original.id)),
    );

    const { bridgeImportSchema } = await import('@syncle/core');
    const result = await controller.importBridges(
      bridgeImportSchema.parse({ document: doc }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.created).toEqual([
      { id: expect.any(String), name: `transfer ${source} (imported)` },
    ]);
    const imported = await app.bridges.get(result.created[0].id);
    expect(imported.destination).toEqual(original.destination);
    expect(imported.id).not.toBe(original.id);

    // again: a third name, never a collision
    const again = await controller.importBridges(
      bridgeImportSchema.parse({ document: doc }),
    );
    expect(again.created[0].name).toBe(`transfer ${source} (imported 2)`);

    const { BridgeJobService } =
      await import('../../src/bridges/bridge-job.service');
    const jobs: any = app.ctx.get(BridgeJobService);
    const started = await jobs.start(imported.id);
    await waitFor('the imported bridge to run', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j?.status === 'completed' ? j : null;
    });
    expect((await destRows('postgres_dest', dest)).map((r) => r.name)).toEqual([
      'a',
      'b',
    ]);
  }, 120_000);

  it('from ANOTHER instance finds them by name and engine — or asks, saying who the candidates are', async () => {
    const original = await dbBridge(
      `foreign ${uniqueTable('f')}`,
      'src',
      'dst',
    );
    const doc = JSON.parse(
      JSON.stringify(await controller.exportOne(original.id)),
    );
    // as if exported elsewhere: other ids, same names
    const foreign = JSON.parse(
      JSON.stringify(doc)
        .split(pg)
        .join('conn-elsewhere-1')
        .split(pgDest)
        .join('conn-elsewhere-2'),
    );
    const { bridgeImportSchema } = await import('@syncle/core');

    const byName = await controller.importBridges(
      bridgeImportSchema.parse({ document: foreign }),
    );
    const found = await app.bridges.get(byName.created[0].id);
    expect(found.source.connectionId).toBe(pg);
    expect(found.destination.targets[0].connectionId).toBe(pgDest);

    // a name this instance does not have
    foreign.connections['conn-elsewhere-2'] = {
      name: 'warehouse (eu-west)',
      engine: 'postgres',
    };
    const before = await app.prisma.bridge.count();
    const refused = await controller
      .importBridges(bridgeImportSchema.parse({ document: foreign }))
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      status: 400,
      details: { reason: 'unresolved-connections' },
    });
    expect((refused as any).message).toContain(
      '"warehouse (eu-west)" (postgres)',
    );
    const [unresolved] = (refused as any).details.unresolved;
    expect(unresolved).toMatchObject({
      id: 'conn-elsewhere-2',
      name: 'warehouse (eu-west)',
      engine: 'postgres',
    });
    // candidates are this instance's connections of THAT engine
    expect(unresolved.candidates.map((c: any) => c.id)).toContain(pgDest);
    // nothing was created: half an import is worse than none
    expect(await app.prisma.bridge.count()).toBe(before);

    // told which one to use
    const mapped = await controller.importBridges(
      bridgeImportSchema.parse({
        document: foreign,
        connectionMap: { 'conn-elsewhere-2': pgDest },
      }),
    );
    expect(
      (await app.bridges.get(mapped.created[0].id)).destination.targets[0]
        .connectionId,
    ).toBe(pgDest);
    await expect(
      controller.importBridges(
        bridgeImportSchema.parse({
          document: foreign,
          connectionMap: { 'conn-elsewhere-2': 'nope' },
        }),
      ),
    ).rejects.toThrow(/does not exist/);
  }, 120_000);

  it('of a bridge whose endpoint wants a credential arrives switched OFF, and says why', async () => {
    const bridge = await httpBridge(`cred ${uniqueTable('c')}`, {
      type: 'bearer',
      token: 'tok_SECRET',
    });
    const doc = JSON.parse(
      JSON.stringify(await controller.exportOne(bridge.id)),
    );
    const { bridgeImportSchema } = await import('@syncle/core');
    const result = await controller.importBridges(
      bridgeImportSchema.parse({ document: doc }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /credentials are not exported.*switched off/,
    );
    const imported = await app.bridges.get(result.created[0].id);
    expect(imported.enabled).toBe(false);
    // and not with a mask for a token
    const resolved = await app.bridges.resolve(result.created[0].id);
    expect(resolved.destination.auth).toEqual({ type: 'bearer', token: '' });
  });

  it('refuses what is not an export, or one from a format it does not know', async () => {
    const { bridgeImportSchema } = await import('@syncle/core');
    const doc = JSON.parse(
      JSON.stringify(await controller.exportAll(undefined)),
    );
    expect(
      bridgeImportSchema.safeParse({
        document: { ...doc, format: 'something.else' },
      }).success,
    ).toBe(false);
    expect(
      bridgeImportSchema.safeParse({ document: { ...doc, version: 2 } })
        .success,
    ).toBe(false);
    expect(
      bridgeImportSchema.safeParse({ document: { ...doc, bridges: [] } })
        .success,
    ).toBe(false);
    expect(
      bridgeImportSchema.safeParse({
        document: { ...doc, bridges: [{ name: 'half a bridge' }] },
      }).success,
    ).toBe(false);
    // a read-only connection is no destination, imported or not
    const readOnly = await app.connections.create({
      name: `ro-${uniqueTable('c')}`,
      engine: 'sqlite',
      database: '/tmp/never.db',
      readOnly: true,
    });
    const bridge = await dbBridge(`ro ${uniqueTable('r')}`, 's', 'd');
    const one = JSON.parse(
      JSON.stringify(await controller.exportOne(bridge.id)),
    );
    await expect(
      controller.importBridges(
        bridgeImportSchema.parse({
          document: one,
          connectionMap: { [pgDest]: readOnly.id },
        }),
      ),
    ).rejects.toThrow(/read-only connection/);
  });
});

describe('a clone', () => {
  it('is the same bridge under another name — credential included, job and position not', async () => {
    const original = await httpBridge(`clone ${uniqueTable('k')}`, {
      type: 'bearer',
      token: 'tok_KEPT',
    });
    const copy = await controller.clone(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe(`${original.name} (copy)`);
    expect({ ...copy, id: 0, name: 0, createdAt: 0, updatedAt: 0 }).toEqual({
      ...original,
      id: 0,
      name: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    // it never left this instance, so the credential came along
    expect((await app.bridges.resolve(copy.id)).destination.auth).toEqual({
      type: 'bearer',
      token: 'tok_KEPT',
    });
    expect(
      await app.prisma.bridgeJob.count({ where: { bridgeId: copy.id } }),
    ).toBe(0);

    expect((await controller.clone(original.id)).name).toBe(
      `${original.name} (copy 2)`,
    );
    await expect(controller.clone('no-such-bridge')).rejects.toMatchObject({
      status: 404,
    });
  });
});
