/**
 * Boots the real application container and builds real bridges against it.
 * Shared by every end-to-end test so they all exercise the same wiring the
 * server uses in production.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { applyTestEnv } from './env';
import { TEST_CONNECTIONS, uniqueTable, withAdapter } from './harness';

applyTestEnv();

export interface AppHandle {
  ctx: INestApplicationContext;
  connections: any;
  bridges: any;
  cdc: any;
  prisma: any;
}

export async function bootstrapApp(): Promise<AppHandle> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { ConnectionStoreService } = await import(
    '../../src/connections/connection-store.service'
  );
  const { BridgeStoreService } = await import('../../src/bridges/bridge-store.service');
  const { BridgeCdcService } = await import('../../src/bridges/bridge-cdc.service');
  const { PrismaService } = await import('../../src/common/prisma.service');

  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  return {
    ctx,
    connections: ctx.get(ConnectionStoreService),
    bridges: ctx.get(BridgeStoreService),
    cdc: ctx.get(BridgeCdcService),
    prisma: ctx.get(PrismaService),
  };
}

/** a key into TEST_CONNECTIONS; `*_dest` variants point at a separate database */
export type ConnKey =
  | 'postgres'
  | 'mysql'
  | 'mongodb'
  | 'redis'
  | 'redis_dest'
  | 'sqlite'
  | 'postgres_dest'
  | 'mysql_dest';

export async function connectionFor(app: AppHandle, key: ConnKey): Promise<string> {
  const t = TEST_CONNECTIONS[key]!;
  const conn = await app.connections.create({
    name: `it-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    engine: t.engine,
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.database,
    // engine-specific settings — Redis carries its database index here, and
    // dropping it silently sent destination writes to db 0 while the checks
    // read db 1
    options: t.options,
  });
  return conn.id;
}

export interface SyncSetup {
  bridgeId: string;
  sourceTable: string;
  destTable: string;
}

/**
 * Row shape per engine. Redis stores key/value pairs and everything else stores
 * named columns, so a bridge between the two has to map one onto the other.
 */
export type Shape = 'row' | 'kv';
export const shapeOf = (engine: ConnKey): Shape =>
  engine.startsWith('redis') ? 'kv' : 'row';

/** the mapping that turns a source row into what the destination expects */
export function mappingFor(
  source: ConnKey,
  dest: ConnKey,
): Array<{ source: string; target: string }> {
  const from = shapeOf(source);
  const to = shapeOf(dest);
  if (from === to) return []; // identity
  return from === 'row'
    ? [
        { source: 'id', target: 'key' },
        { source: 'name', target: 'value' },
      ]
    : [
        { source: 'key', target: 'id' },
        { source: 'value', target: 'name' },
      ];
}

/** rows shaped for whichever engine is going to hold them */
export function rowsFor(
  engine: ConnKey,
  count: number,
  offset = 0,
): Array<Record<string, unknown>> {
  return shapeOf(engine) === 'kv'
    ? Array.from({ length: count }, (_, i) => ({
        key: String(offset + i + 1),
        value: `row-${offset + i}`,
      }))
    : Array.from({ length: count }, (_, i) => ({
        id: offset + i + 1,
        name: `row-${offset + i}`,
      }));
}

/** write rows into a source, however that engine takes them */
export async function writeSourceRows(
  engine: ConnKey,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  await withAdapter(engine, async (a) => {
    if (a.insertRows) await a.insertRows({ table, rows });
    else for (const values of rows) await a.insertRow({ table, values });
  });
}

/**
 * Create a source relation and a CDC bridge writing into `destEngine`.
 * `start: false` leaves the bridge stopped, for tests that drive start/stop.
 */
export async function makeBridge(
  app: AppHandle,
  opts: {
    destEngine: ConnKey;
    sourceConnId: string;
    destConnId: string;
    cleanups: Array<() => Promise<void>>;
    start?: boolean;
    /** engine the source table lives on; defaults to postgres */
    sourceEngine?: ConnKey;
  },
): Promise<SyncSetup> {
  const { destEngine, sourceConnId, destConnId, cleanups } = opts;
  const sourceEngine = opts.sourceEngine ?? 'postgres';
  const sourceTable = uniqueTable('src');
  const destTable = uniqueTable('dst');

  const srcTypes =
    sourceEngine === 'mysql'
      ? { int: 'int', text: 'varchar(255)' }
      : sourceEngine === 'sqlite'
        ? { int: 'INTEGER', text: 'TEXT' }
        : { int: 'integer', text: 'text' };

  // Redis has no relation to create. MongoDB creates a collection on first
  // write, but a change stream needs it to exist before it opens.
  if (sourceEngine === 'mongodb') {
    await withAdapter(sourceEngine, (a) =>
      a.createTable({ table: sourceTable, columns: [] }),
    ).catch(() => undefined);
  } else if (!sourceEngine.startsWith('redis')) {
    await withAdapter(sourceEngine, (a) =>
      a.createTable({
        table: sourceTable,
        columns: [
          { name: 'id', type: srcTypes.int, nullable: false, primaryKey: true },
          { name: 'name', type: srcTypes.text, nullable: true },
        ],
      }),
    );
  }
  if (!sourceEngine.startsWith('redis')) {
    cleanups.push(() =>
      withAdapter(sourceEngine, (a) => a.dropTable(sourceTable)).catch(() => undefined),
    );
  }
  cleanups.push(() =>
    withAdapter(destEngine, (a) => a.dropTable(destTable)).catch(() => undefined),
  );

  const mapping = mappingFor(sourceEngine, destEngine);
  const keyColumns = shapeOf(destEngine) === 'kv' ? ['key'] : ['id'];

  const { bridgeInputSchema } = await import('@syncle/core');
  const input = bridgeInputSchema.parse({
    name: `it-bridge-${sourceTable}`,
    source: { kind: 'table', connectionId: sourceConnId, table: sourceTable },
    destination: {
      kind: 'database',
      targets: [
        {
          connectionId: destConnId,
          table: destTable,
          writeMode: 'upsert',
          keyColumns,
          mapping,
          createMissingTable: true,
        },
      ],
    },
    transform: { template: '{{$row}}' },
    trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
  });
  const bridge = await app.bridges.create(input);

  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });

  if (opts.start !== false) await app.cdc.start(bridge.id);
  return { bridgeId: bridge.id, sourceTable, destTable };
}

/** rows in the destination table, sorted by id; [] before the sink creates it */
export async function destRows(
  engine: ConnKey,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  return withAdapter(engine, async (a) => {
    try {
      const res = await a.browse({ table, limit: 5000, offset: 0 });
      return [...res.rows].sort((x, y) => Number(x.id) - Number(y.id));
    } catch {
      return [];
    }
  });
}

/**
 * Row count in the destination. `destRows` pages through `browse`, which is
 * capped (5000 by default), so anything larger must be counted in the engine.
 */
export async function destCount(engine: ConnKey, table: string): Promise<number> {
  return withAdapter(engine, async (a) => {
    try {
      // Redis has no tables: rows land as individual keys, so the database's
      // key count IS the row count. The test instance is disposable and the
      // benchmark flushes it first, so nothing else is being counted.
      if (engine.startsWith('redis')) {
        // the redis dialect answers with { command, reply }; the count is the
        // REPLY — reading the first value would read back "DBSIZE"
        const res = await a.query('DBSIZE');
        const row = res.rows[0] as { reply?: unknown } | undefined;
        return Number(row?.reply ?? 0);
      }
      // MongoDB has no COUNT statement here, and its browse total is exact.
      // For SQL engines the total is NOT safe to compare against an expected
      // row count: MySQL derives it from information_schema.table_rows, which
      // is an estimate (the adapter flags it as such), so an equality check
      // against it never becomes true.
      if (engine === 'mongodb') {
        const res = await a.browse({ table, limit: 1, offset: 0 });
        return Number(res.total ?? 0);
      }
      const q = engine.startsWith('mysql') ? '`' : '"';
      const res = await a.query(`SELECT COUNT(*) AS c FROM ${q}${table}${q}`);
      return Number(Object.values(res.rows[0] ?? {})[0] ?? 0);
    } catch {
      return 0; // the sink creates the target on first write
    }
  });
}

/** distinct ids in the destination, to prove exactly-once at volume */
export async function destDistinctIds(
  engine: ConnKey,
  table: string,
): Promise<{ distinct: number; min: number; max: number }> {
  return withAdapter(engine, async (a) => {
    const q = engine.startsWith('mysql') ? '`' : '"';
    const res = await a.query(
      `SELECT COUNT(DISTINCT id) AS d, MIN(id) AS lo, MAX(id) AS hi FROM ${q}${table}${q}`,
    );
    const row = res.rows[0] as { d?: unknown; lo?: unknown; hi?: unknown };
    return {
      distinct: Number(row?.d ?? 0),
      min: Number(row?.lo ?? 0),
      max: Number(row?.hi ?? 0),
    };
  });
}
