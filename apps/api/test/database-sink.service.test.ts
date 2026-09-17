/**
 * DatabaseSinkService tests with a stub adapter (no live database): CDC delete
 * routing, the upsert-needs-keys guard, per-target skip on retry (fan-out
 * partial-failure), and schema-driven typing for auto-created target tables.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type {
  ColumnSchema,
  CreateTableSpec,
  DatabaseSchema,
  DatabaseTarget,
} from '@syncle/core';
import { DatabaseSinkService } from '../src/bridges/database-sink.service';
import type { ResolvedBridge } from '../src/bridges/bridges.types';

interface WriteCalls {
  insert: Record<string, unknown>[];
  upsert: Record<string, unknown>[];
  delete: Record<string, unknown>[];
  create: CreateTableSpec[];
}

/** a minimal adapter double; individual methods are overridden per test */
function makeAdapter() {
  const calls: WriteCalls = { insert: [], upsert: [], delete: [], create: [] };
  const adapter = {
    engine: 'postgres',
    capabilities: { transactions: false },
    browse: async (): Promise<unknown> => ({
      rows: [],
      columns: [],
      rowCount: 0,
      executionMs: 0,
      total: 0,
      hasMore: false,
      primaryKey: [],
    }),
    getSchema: async (): Promise<DatabaseSchema> => {
      throw new Error('introspection unavailable');
    },
    insertRow: async (p: Record<string, unknown>) => {
      calls.insert.push(p);
      return { affectedRows: 1 };
    },
    upsertRow: async (p: Record<string, unknown>) => {
      calls.upsert.push(p);
      return { affectedRows: 1 };
    },
    deleteRow: async (p: Record<string, unknown>) => {
      calls.delete.push(p);
      return { affectedRows: 1 };
    },
    createTable: async (spec: CreateTableSpec) => {
      calls.create.push(spec);
    },
  };
  return { adapter, calls };
}

/** service wired to stub adapters, keyed by connectionId (all Postgres unless told otherwise) */
function makeService(
  adapters: Record<string, unknown>,
  engines: Record<string, string> = {},
): DatabaseSinkService {
  const pool = {
    withAdapter: async (
      connectionId: string,
      _database: string | undefined,
      fn: (a: unknown) => unknown,
    ) => fn(adapters[connectionId]),
  };
  const connections = {
    resolve: async (id: string) => ({ engine: engines[id] ?? 'postgres' }),
  };
  return new DatabaseSinkService(pool as never, connections as never);
}

function makeBridge(): ResolvedBridge {
  return {
    id: 'bridge-1',
    name: 'bridge',
    source: { kind: 'table', connectionId: 'src', table: 'users' },
    destination: { kind: 'database', targets: [] },
    transform: { template: '{{$row}}' },
    delivery: {
      batchSize: 1,
      maxAttempts: 1,
      backoffMs: 0,
      backoffMaxMs: 0,
      minDelayMs: 0,
      timeoutMs: 1000,
      pageSize: 200,
      onError: 'continue',
    },
    trigger: { kind: 'replay' },
    enabled: true,
  } as ResolvedBridge;
}

function makeTarget(overrides: Partial<DatabaseTarget> = {}): DatabaseTarget {
  return {
    connectionId: 'dst',
    table: 'users_copy',
    writeMode: 'upsert',
    keyColumns: ['id'],
    mapping: [],
    createMissingTable: false,
    ...overrides,
  };
}

function col(name: string, dataType: string, nullable: boolean): ColumnSchema {
  return {
    name,
    dataType,
    nullable,
    isPrimaryKey: false,
    isUnique: false,
    isAutoIncrement: false,
    defaultValue: null,
    comment: null,
    references: null,
  };
}

describe('DatabaseSinkService.deliver', () => {
  it('routes a delete op to deleteRow keyed by the target key columns', async () => {
    const { adapter, calls } = makeAdapter();
    const svc = makeService({ dst: adapter });
    const outcome = await svc.deliver(
      makeBridge(),
      [makeTarget()],
      [{ id: 7, name: 'Ada' }],
      'delete',
    );
    expect(outcome.status).toBe('success');
    expect(outcome.op).toBe('delete'); // persisted so a resend stays a delete
    expect(calls.delete).toEqual([
      { schema: undefined, table: 'users_copy', identity: { id: 7 } },
    ]);
    expect(calls.upsert).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
  });

  it('does not attempt a delete on a target that has no key columns', async () => {
    // an append-only (`insert`) target has nothing to delete BY. attempting it
    // builds an empty WHERE, which every engine rejects — so each delete at the
    // source failed the whole delivery, and under `abort` stopped the bridge
    const log = makeAdapter();
    const copy = makeAdapter();
    const svc = makeService({ log: log.adapter, copy: copy.adapter });

    const outcome = await svc.deliver(
      makeBridge(),
      [
        makeTarget({ connectionId: 'log', table: 'users_log', writeMode: 'insert', keyColumns: [] }),
        makeTarget({ connectionId: 'copy' }),
      ],
      [{ id: 7, name: 'gone' }],
      'delete',
    );

    expect(outcome.status).toBe('success');
    expect(log.calls.delete).toEqual([]);
    expect(log.calls.insert).toEqual([]); // and it is NOT appended as if it were a row
    expect(copy.calls.delete).toHaveLength(1); // the keyed target still deletes
    expect(outcome.responseBody).toMatch(/users_log: delete not applied/);
  });

  it('fails an upsert with no key columns instead of writing', async () => {
    const { adapter, calls } = makeAdapter();
    const svc = makeService({ dst: adapter });
    const outcome = await svc.deliver(
      makeBridge(),
      [makeTarget({ keyColumns: [] })],
      [{ id: 7 }],
      undefined,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('key column');
    expect(calls.upsert).toHaveLength(0);
  });

  it('skips already-succeeded targets on a fan-out retry', async () => {
    const { adapter, calls } = makeAdapter();
    let failB = true;
    const upsert = adapter.upsertRow;
    adapter.upsertRow = async (p) => {
      if (p.table === 'users_b' && failB) throw new Error('target B unavailable');
      return upsert(p);
    };
    const svc = makeService({ dst: adapter });
    const targets = [
      makeTarget({ table: 'users_a' }),
      makeTarget({ table: 'users_b' }),
    ];

    const first = await svc.deliver(makeBridge(), targets, [{ id: 1 }], undefined);
    expect(first.status).toBe('failed');
    expect(first.succeededTargets).toHaveLength(1); // A committed, B did not
    expect(calls.upsert.map((p) => p.table)).toEqual(['users_a']);

    // retry with the persisted checkpoint: A must be skipped, only B written
    failB = false;
    const second = await svc.deliver(
      makeBridge(),
      targets,
      [{ id: 1 }],
      undefined,
      new Set(first.succeededTargets!),
    );
    expect(second.status).toBe('success');
    expect(second.succeededTargets).toBeNull(); // success clears the checkpoint
    expect(second.responseBody).toContain('skipped');
    expect(calls.upsert.map((p) => p.table)).toEqual(['users_a', 'users_b']);
  });

  it('types an auto-created table from the real source schema', async () => {
    const src = makeAdapter();
    src.adapter.getSchema = async () => ({
      database: 'appdb',
      namespaces: [
        {
          name: 'public',
          tables: [
            {
              name: 'users',
              schema: 'public',
              kind: 'table' as const,
              columns: [
                col('id', 'bigint', false),
                col('price', 'numeric(10,2)', true),
                col('meta', 'jsonb', true),
                col('note', 'character varying(120)', true),
              ],
              indexes: [],
              foreignKeys: [],
              primaryKey: ['id'],
              estimatedRows: null,
              comment: null,
            },
          ],
        },
      ],
    });
    const dst = makeAdapter();
    dst.adapter.browse = async () => {
      throw new Error('relation "users_copy" does not exist');
    };
    const svc = makeService({ src: src.adapter, dst: dst.adapter });

    // pg drivers return bigint/numeric as strings and this sample has nulls —
    // with the schema resolved, none of that decays the created types to TEXT
    const outcome = await svc.deliver(
      makeBridge(),
      [makeTarget({ createMissingTable: true })],
      [{ id: '9007199254740993', price: '19.99', meta: null, note: null }],
      undefined,
    );
    expect(outcome.status).toBe('success');
    expect(dst.calls.create).toHaveLength(1);
    const byName = new Map(dst.calls.create[0]!.columns.map((c) => [c.name, c]));
    expect(byName.get('id')).toMatchObject({ primaryKey: true, nullable: false });
    // Postgres on both sides: the source's own types, verbatim. (this used to
    // expect DOUBLE PRECISION and TEXT — an exact decimal turned into a float
    // and a bounded varchar into unbounded text, on a same-engine copy)
    expect(byName.get('id')!.type).toBe('bigint');
    expect(byName.get('price')!.type).toBe('numeric(10,2)');
    expect(byName.get('meta')!.type).toBe('jsonb');
    expect(byName.get('note')!.type).toBe('character varying(120)');
  });

  it('prefers the precise native type, and reads it in the SOURCE engine’s dialect', async () => {
    const src = makeAdapter();
    const precise = (name: string, dataType: string, nativeType: string) => ({
      ...col(name, dataType, true),
      nativeType,
    });
    src.adapter.getSchema = async () => ({
      database: 'appdb',
      namespaces: [
        {
          name: '',
          tables: [
            {
              name: 'users',
              kind: 'table' as const,
              columns: [
                { ...col('id', 'int unsigned', false) },
                col('active', 'tinyint(1)', true),
                col('seen', 'timestamp', true),
                col('ratio', 'float', true),
                // what Postgres' catalog says vs. what the column really is
                precise('amount', 'numeric', 'numeric(38,10)'),
                precise('tags', 'ARRAY', 'text[]'),
              ],
              indexes: [],
              foreignKeys: [],
              primaryKey: ['id'],
              estimatedRows: null,
              comment: null,
            },
          ],
        },
      ],
    });
    const dst = makeAdapter();
    dst.adapter.browse = async () => {
      throw new Error('relation "users_copy" does not exist');
    };
    const svc = makeService(
      { src: src.adapter, dst: dst.adapter },
      { src: 'mysql' },
    );

    await svc.deliver(
      makeBridge(),
      [makeTarget({ createMissingTable: true })],
      [{ id: 1 }],
      undefined,
    );
    const types = Object.fromEntries(
      dst.calls.create[0]!.columns.map((c) => [c.name, c.type]),
    );
    expect(types).toEqual({
      id: 'BIGINT', // int unsigned does not fit a signed INTEGER
      active: 'BOOLEAN', // MySQL's tinyint(1)
      seen: 'TIMESTAMP', // a MySQL timestamp is a wall-clock reading here
      ratio: 'REAL', // MySQL float is single precision; Postgres float is double
      amount: 'NUMERIC(38,10)', // from nativeType, not the catalog's bare "numeric"
      tags: 'TEXT[]',
    });
  });

  it('converts values for the target engine, and only when it has to', async () => {
    const src = makeAdapter();
    src.adapter.getSchema = async () => ({
      database: 'appdb',
      namespaces: [
        {
          name: '',
          tables: [
            {
              name: 'users',
              kind: 'table' as const,
              columns: [
                col('id', 'int', false),
                col('active', 'tinyint(1)', true),
                col('seen', 'datetime', true),
              ],
              indexes: [],
              foreignKeys: [],
              primaryKey: ['id'],
              estimatedRows: null,
              comment: null,
            },
          ],
        },
      ],
    });
    const dst = makeAdapter();
    const svc = makeService(
      { src: src.adapter, dst: dst.adapter },
      { src: 'mysql' },
    );

    await svc.deliver(
      makeBridge(),
      [makeTarget()],
      [{ id: 1, active: 1, seen: '0000-00-00 00:00:00' }],
      undefined,
    );
    // a MySQL 0/1 flag is a boolean in Postgres; a zero date is NULL anywhere else
    expect((dst.calls.upsert[0] as { values: unknown }).values).toEqual({
      id: 1,
      active: true,
      seen: null,
    });
  });

  it('keeps each bridge’s source shape apart', async () => {
    // the cache is keyed by bridge id: two bridges must never share a slot
    const schemaOf = (column: string) => async () => ({
      database: 'appdb',
      namespaces: [
        {
          name: '',
          tables: [
            {
              name: 'users',
              kind: 'table' as const,
              columns: [col('id', 'integer', false), col(column, 'text', true)],
              indexes: [],
              foreignKeys: [],
              primaryKey: ['id'],
              estimatedRows: null,
              comment: null,
            },
          ],
        },
      ],
    });
    const srcA = makeAdapter();
    srcA.adapter.getSchema = schemaOf('alpha');
    const srcB = makeAdapter();
    srcB.adapter.getSchema = schemaOf('beta');
    const dst = makeAdapter();
    dst.adapter.browse = async () => {
      throw new Error('does not exist');
    };
    const svc = makeService({
      srcA: srcA.adapter,
      srcB: srcB.adapter,
      dst: dst.adapter,
    });
    const bridge = (id: string, connectionId: string) =>
      ({
        ...makeBridge(),
        id,
        source: { kind: 'table', connectionId, table: 'users' },
      }) as ResolvedBridge;

    await svc.deliver(
      bridge('a', 'srcA'),
      [makeTarget({ table: 'copy_a', createMissingTable: true })],
      [{ id: 1 }],
      undefined,
    );
    await svc.deliver(
      bridge('b', 'srcB'),
      [makeTarget({ table: 'copy_b', createMissingTable: true })],
      [{ id: 1 }],
      undefined,
    );

    expect(dst.calls.create.map((c) => c.columns.map((x) => x.name))).toEqual([
      ['id', 'alpha'],
      ['id', 'beta'],
    ]);
  });

  it('falls back to sample-row inference when no schema is available', async () => {
    const src = makeAdapter(); // getSchema throws by default
    const dst = makeAdapter();
    dst.adapter.browse = async () => {
      throw new Error('relation "users_copy" does not exist');
    };
    const svc = makeService({ src: src.adapter, dst: dst.adapter });

    const outcome = await svc.deliver(
      makeBridge(),
      [makeTarget({ createMissingTable: true })],
      [{ id: 7, price: '19.99' }],
      undefined,
    );
    expect(outcome.status).toBe('success');
    const byName = new Map(dst.calls.create[0]!.columns.map((c) => [c.name, c]));
    expect(byName.get('id')!.type).toBe('INTEGER'); // runtime number
    expect(byName.get('price')!.type).toBe('TEXT'); // stringly value, best effort
  });

  it('flags an oversized capture as truncated', async () => {
    const { adapter } = makeAdapter();
    const svc = makeService({ dst: adapter });
    const outcome = await svc.deliver(
      makeBridge(),
      [makeTarget()],
      [{ id: 1, blob: 'x'.repeat(20_000) }],
      undefined,
    );
    expect(outcome.status).toBe('success');
    expect(outcome.bodyTruncated).toBe(true);
    expect(outcome.requestBody).toHaveLength(16_384);
  });
});
