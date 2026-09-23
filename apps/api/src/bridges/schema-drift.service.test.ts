import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { bridgeInputSchema, type SchemaColumn } from '@syncle/core';
import { SchemaDriftService } from './schema-drift.service';
import type { ResolvedBridge } from './bridges.types';

const col = (name: string, type = 'text'): SchemaColumn => ({
  name,
  type,
  nullable: true,
});

/** a service over a source table whose columns the test changes at will */
function rig(opts: { engine?: string; destColumns?: string[] } = {}) {
  const state = {
    source: [col('id', 'integer'), col('email'), col('name')],
    dest: opts.destColumns ?? ['id', 'email', 'name'],
    row: {
      sourceColumnsJson: null as string | null,
      sourceColumnsAt: null as Date | null,
    },
  };
  const tableOf = (
    name: string,
    columns: Array<{ name: string; nativeType?: string }>,
  ) => ({
    namespaces: [
      {
        name: 'public',
        tables: [
          {
            name,
            columns: columns.map((c) => ({
              ...c,
              dataType: 'text',
              nullable: true,
            })),
          },
        ],
      },
    ],
  });
  const added: unknown[] = [];
  const sourceAdapter = {
    getSchema: vi.fn(async () =>
      tableOf(
        'users',
        state.source.map((c) => ({ name: c.name, nativeType: c.type })),
      ),
    ),
  };
  const destAdapter = {
    getSchema: vi.fn(async () =>
      tableOf(
        'users_copy',
        state.dest.map((name) => ({ name })),
      ),
    ),
    addColumns: vi.fn(async (spec: { columns: Array<{ name: string }> }) => {
      added.push(spec);
      state.dest.push(...spec.columns.map((c) => c.name));
    }),
  };
  const alerts = { emit: vi.fn() };
  const sink = { forget: vi.fn() };
  const service = new SchemaDriftService(
    {
      bridge: {
        findUnique: async () => state.row,
        update: async ({ data }: { data: typeof state.row }) =>
          Object.assign(state.row, data),
      },
    } as never,
    {
      withAdapter: async (
        id: string,
        _db: unknown,
        fn: (a: unknown) => unknown,
      ) => fn(id === 'src' ? sourceAdapter : destAdapter),
    } as never,
    {
      get: async (id: string) => ({
        engine: id === 'src' ? (opts.engine ?? 'postgres') : 'postgres',
      }),
    } as never,
    sink as never,
    alerts as never,
  );
  const bridge = (over: Record<string, unknown> = {}): ResolvedBridge =>
    ({
      id: 'b1',
      ...bridgeInputSchema.parse({
        name: 'users → copy',
        source: { kind: 'table', connectionId: 'src', table: 'users' },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: 'dst',
              table: 'users_copy',
              keyColumns: ['id'],
              mapping: [
                { source: 'id', target: 'id' },
                { source: 'email', target: 'email' },
              ],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        ...over,
      }),
    }) as unknown as ResolvedBridge;
  return {
    state,
    service,
    bridge,
    alerts,
    sink,
    sourceAdapter,
    destAdapter,
    added,
  };
}

const identity = (extra: Record<string, unknown> = {}) => ({
  destination: {
    kind: 'database',
    targets: [
      {
        connectionId: 'dst',
        table: 'users_copy',
        keyColumns: ['id'],
        createMissingTable: true,
        ...extra,
      },
    ],
  },
});

describe('SchemaDriftService', () => {
  // what it logs is what it alerts, and that is asserted on below
  beforeAll(() => Logger.overrideLogger(false));

  it('the first look records the table, and says nothing', async () => {
    const r = rig();
    expect(await r.service.check(r.bridge())).toEqual({
      drift: null,
      missingUsed: [],
      stop: null,
    });
    expect(JSON.parse(r.state.row.sourceColumnsJson!)).toEqual(r.state.source);
    expect(r.alerts.emit).not.toHaveBeenCalled();
  });

  it('a column the bridge uses is gone: stop, critically — once, however often it is looked at', async () => {
    const r = rig();
    await r.service.check(r.bridge());
    r.state.source = [col('id', 'integer'), col('mail'), col('name')];
    const verdict = await r.service.check(r.bridge());
    expect(verdict.missingUsed).toEqual(['email']);
    expect(verdict.stop).toMatch(/uses a column that is gone: email/);
    await r.service.check(r.bridge());
    await r.service.check(r.bridge());
    expect(r.alerts.emit).toHaveBeenCalledTimes(1);
    expect(r.alerts.emit.mock.calls[0]![0]).toMatchObject({
      type: 'bridge.schema_drift',
      severity: 'critical',
      bridgeId: 'b1',
    });
    // nothing was accepted along the way
    expect(
      JSON.parse(r.state.row.sourceColumnsJson!).map(
        (c: SchemaColumn) => c.name,
      ),
    ).toEqual(['id', 'email', 'name']);
  });

  it('a column it does NOT use is gone, or one is added: a warning, and it carries on', async () => {
    const r = rig();
    await r.service.check(r.bridge());
    r.state.source = [col('id', 'integer'), col('email'), col('plan')];
    const verdict = await r.service.check(r.bridge());
    expect(verdict).toMatchObject({
      stop: null,
      missingUsed: [],
      drift: { removed: [col('name')], added: [col('plan')] },
    });
    expect(r.alerts.emit.mock.calls[0]![0]).toMatchObject({
      severity: 'warning',
    });
    // …and a FURTHER change is a new thing to say
    r.state.source = [
      col('id', 'integer'),
      col('email'),
      col('plan'),
      col('seats', 'integer'),
    ];
    await r.service.check(r.bridge());
    expect(r.alerts.emit).toHaveBeenCalledTimes(2);
  });

  it('`continue`: a used column that is gone is a warning, not a stop', async () => {
    const r = rig();
    const b = r.bridge({ delivery: { onSchemaChange: 'continue' } });
    await r.service.check(b);
    r.state.source = [col('id', 'integer'), col('name')];
    expect(await r.service.check(b)).toMatchObject({
      stop: null,
      missingUsed: ['email'],
    });
    expect(r.alerts.emit.mock.calls[0]![0]).toMatchObject({
      severity: 'warning',
      message: expect.stringMatching(/carries on because it is set to/),
    });
  });

  it('accept: refuses while a used column is gone; takes the table once it is not; forgets what the sink knew', async () => {
    const r = rig();
    await r.service.check(r.bridge());
    r.state.source = [col('id', 'integer'), col('mail')];
    expect(await r.service.accept(r.bridge())).toEqual(['email']);
    expect(JSON.parse(r.state.row.sourceColumnsJson!)).toHaveLength(3);
    const fixed = r.bridge({
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: 'dst',
            table: 'users_copy',
            keyColumns: ['id'],
            mapping: [
              { source: 'id', target: 'id' },
              { source: 'mail', target: 'email' },
            ],
          },
        ],
      },
    });
    expect(await r.service.accept(fixed)).toEqual([]);
    expect(
      JSON.parse(r.state.row.sourceColumnsJson!).map(
        (c: SchemaColumn) => c.name,
      ),
    ).toEqual(['id', 'mail']);
    expect(r.sink.forget).toHaveBeenCalledWith('b1');
    expect((await r.service.status(fixed)).drift).toBeNull();
    // a bridge pointed at another table takes that table, whatever the old one had
    r.state.source = [col('k')];
    expect(await r.service.accept(fixed, { moved: true })).toEqual([]);
  });

  it('`evolve` adds what is missing to a target that takes the row as it comes — nullable, and only that', async () => {
    const r = rig();
    const b = r.bridge({
      ...identity(),
      delivery: { onSchemaChange: 'evolve' },
    });
    await r.service.check(b);
    r.state.source = [...r.state.source, col('plan'), col('seats', 'integer')];
    await r.service.check(b);
    expect(r.added).toEqual([
      {
        schema: undefined,
        table: 'users_copy',
        columns: [
          expect.objectContaining({ name: 'plan', nullable: true }),
          expect.objectContaining({ name: 'seats', nullable: true }),
        ],
      },
    ]);
    expect(r.alerts.emit.mock.calls[0]![0].message).toMatch(
      /Added plan, seats to users_copy/,
    );
    // the table is the bridge's again: not drift, and not added twice
    expect((await r.service.status(b)).drift).toBeNull();
    await r.service.check(b);
    expect(r.destAdapter.addColumns).toHaveBeenCalledTimes(1);
  });

  it('`evolve` leaves alone: a target whose columns were CHOSEN, one Syncle may not create tables on, a column already there', async () => {
    for (const over of [
      { ...identity({ mapping: [{ source: 'id', target: 'id' }] }) },
      { ...identity({ createMissingTable: false }) },
    ]) {
      const r = rig();
      const b = r.bridge({ ...over, delivery: { onSchemaChange: 'evolve' } });
      await r.service.check(b);
      r.state.source = [...r.state.source, col('plan')];
      await r.service.check(b);
      expect(r.destAdapter.addColumns).not.toHaveBeenCalled();
    }
    const r = rig({ destColumns: ['id', 'email', 'name', 'plan'] });
    const b = r.bridge({
      ...identity(),
      delivery: { onSchemaChange: 'evolve' },
    });
    await r.service.check(b);
    r.state.source = [...r.state.source, col('plan')];
    await r.service.check(b);
    expect(r.destAdapter.addColumns).not.toHaveBeenCalled();
  });

  it('without `evolve`, nothing is ever altered', async () => {
    const r = rig();
    const b = r.bridge(identity());
    await r.service.check(b);
    r.state.source = [...r.state.source, col('plan')];
    await r.service.check(b);
    expect(r.destAdapter.addColumns).not.toHaveBeenCalled();
  });

  it('a source with no schema is never looked at; one that cannot be looked at stops nothing', async () => {
    const mongo = rig({ engine: 'mongodb' });
    expect(await mongo.service.check(mongo.bridge())).toMatchObject({
      stop: null,
      drift: null,
    });
    expect(mongo.sourceAdapter.getSchema).not.toHaveBeenCalled();
    expect(mongo.state.row.sourceColumnsJson).toBeNull();

    const down = rig();
    await down.service.check(down.bridge());
    down.sourceAdapter.getSchema.mockRejectedValue(
      new Error('connection refused'),
    );
    expect(await down.service.check(down.bridge())).toMatchObject({
      stop: null,
      drift: null,
    });
    expect((await down.service.status(down.bridge())).drift).toBeNull();
  });
});
