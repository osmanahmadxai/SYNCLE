/**
 * Connections given as a connection string, which is what a hosted database
 * usually hands you. The adapters always accepted one; only MongoDB's form had
 * a field for it. Exposing the field for PostgreSQL, MySQL and Redis is the
 * small part. The part that mattered: with a string, the database the workbench
 * or a bridge ASKED for was ignored — the drivers let the string's database
 * win — so a bridge set to read `syncle_dest` read `syncle_test` instead.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import { bootstrapApp, destRows, type AppHandle } from './app-harness';

let app: AppHandle;
let pool: any;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { AdapterPoolService } =
    await import('../../src/connections/adapter-pool.service');
  pool = app.ctx.get(AdapterPoolService);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const byString = async (
  engine: string,
  connectionString: string,
): Promise<string> =>
  (
    await app.connections.create({
      name: `it-uri-${engine}-${Math.random().toString(36).slice(2, 8)}`,
      engine,
      connectionString,
    })
  ).id;

describe('PostgreSQL by connection string', () => {
  const URI = 'postgres://syncle:syncle@127.0.0.1:55432/syncle_test';

  it('connects, and reads the database it was ASKED for, not the one in the string', async () => {
    const id = await byString('postgres', URI);
    const own = await pool.withAdapter(id, undefined, (a: any) =>
      a.query('SELECT current_database() AS db'),
    );
    expect(own.rows[0].db).toBe('syncle_test');
    // the workbench switching databases; a bridge with `source.database`
    const other = await pool.withAdapter(id, 'syncle_dest', (a: any) =>
      a.query('SELECT current_database() AS db'),
    );
    expect(other.rows[0].db).toBe('syncle_dest');
  });

  it('streams changes from the chosen database too', async () => {
    const table = uniqueTable('uri_src');
    const dest = uniqueTable('uri_dst');
    // the source lives in syncle_dest; the string says syncle_test
    await withAdapter('postgres_dest', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY, name text)`),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) =>
        a.query(`DROP TABLE IF EXISTS "${table}"`),
      ).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(dest)).then(() => undefined),
    );

    const source = await byString('postgres', URI);
    const target = await byString('postgres', URI);
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-uri-${table}`,
        source: {
          kind: 'table',
          connectionId: source,
          database: 'syncle_dest',
          table,
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: target,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: true,
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
    await withAdapter('postgres_dest', (a) =>
      a.query(`INSERT INTO "${table}" VALUES (1, 'from syncle_dest')`),
    );
    await waitFor('the row', async () =>
      (await destRows('postgres', dest)).length === 1 ? true : null,
    );
    expect((await destRows('postgres', dest))[0]).toMatchObject({
      id: 1,
      name: 'from syncle_dest',
    });
  });
});

describe('MySQL by connection string', () => {
  it('connects, and honours the chosen database', async () => {
    const id = await byString(
      'mysql',
      'mysql://root:syncle@127.0.0.1:53306/syncle_test',
    );
    const own = await pool.withAdapter(id, undefined, (a: any) =>
      a.query('SELECT DATABASE() AS db'),
    );
    expect(own.rows[0].db).toBe('syncle_test');
    const other = await pool.withAdapter(id, 'syncle_dest', (a: any) =>
      a.query('SELECT DATABASE() AS db'),
    );
    expect(other.rows[0].db).toBe('syncle_dest');
  });
});

describe('Redis by connection string', () => {
  it('connects to the database index the string names', async () => {
    const id = await byString('redis', 'redis://127.0.0.1:56379/1');
    const key = uniqueTable('uri_redis');
    await pool.withAdapter(id, undefined, (a: any) =>
      a.query(`SET ${key} in-db-1`),
    );
    cleanups.push(() =>
      withAdapter('redis_dest', (a) => a.query(`DEL ${key}`)).then(
        () => undefined,
      ),
    );
    // redis_dest is db 1 of the same server; the default connection is db 0
    const inOne = await withAdapter('redis_dest', (a) => a.query(`GET ${key}`));
    const inZero = await withAdapter('redis', (a) => a.query(`GET ${key}`));
    expect((inOne.rows[0] as { reply?: unknown }).reply).toBe('in-db-1');
    // (the adapter prints a missing key the way redis-cli does)
    expect((inZero.rows[0] as { reply?: unknown })?.reply).toBe('(nil)');
  });
});

describe('a connection string is a secret', () => {
  it('is stored encrypted and never handed back in the clear', async () => {
    const id = await byString(
      'postgres',
      'postgres://syncle:syncle@127.0.0.1:55432/syncle_test',
    );
    const shown = await app.connections.get(id);
    expect(shown.connectionString).toBe('********');
    expect(JSON.stringify(shown)).not.toContain('syncle:syncle@');
    const row = await app.prisma.connection.findUniqueOrThrow({
      where: { id },
    });
    expect(row.connectionStringEnc).toBeTruthy();
    expect(row.connectionStringEnc).not.toContain('syncle:syncle@');
    // an edit that sends the redaction back keeps the stored string
    await app.connections.update(id, {
      name: 'renamed',
      engine: 'postgres',
      connectionString: '********',
    });
    const res = await pool.withAdapter(id, undefined, (a: any) =>
      a.query('SELECT 1 AS ok'),
    );
    expect(res.rows[0].ok).toBe(1);
  });

  it('cannot be combined with an SSH tunnel, which it would go around', async () => {
    const { connectionInputSchema } = await import('@syncle/core');
    const parsed = connectionInputSchema.safeParse({
      name: 'x',
      engine: 'postgres',
      connectionString: 'postgres://h/db',
      ssh: {
        enabled: true,
        host: 'bastion',
        port: 22,
        username: 'u',
        authMethod: 'password',
        password: 'p',
      },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(
      /discrete host\/port fields/,
    );
  });
});
