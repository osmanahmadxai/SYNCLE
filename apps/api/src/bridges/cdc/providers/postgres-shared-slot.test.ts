/**
 * the shared replication slot, with the database replaced by a double that
 * answers the catalog queries and records the rest. what is checked here is the
 * ORDER things are asked of the server in, which is where the harm would be:
 * a publication made after the slot breaks the stream for every member.
 */
import { describe, expect, it } from 'vitest';
import type { CdcOperation } from '@syncle/core';
import { runtimeConfig } from '../../../common/runtime-config';
import { PostgresCdcProvider } from './postgres-cdc.provider';
import {
  OPS_CODES,
  PgSharedSlotService,
  opsCode,
} from './postgres-shared-slot';

const OPERATIONS: CdcOperation[] = ['insert', 'update', 'delete', 'truncate'];

describe('one publication per set of operations', () => {
  it('every set a bridge can ask for has its publication in the fixed set', () => {
    for (let mask = 1; mask < 16; mask++) {
      const operations = OPERATIONS.filter((_op, i) => mask & (1 << i));
      expect(OPS_CODES).toContain(opsCode(operations));
    }
    expect(new Set(OPS_CODES).size).toBe(OPS_CODES.length);
  });

  it('truncate is published by all of them, so it is not part of the name', () => {
    expect(opsCode(['insert', 'update', 'delete'])).toBe('iud');
    expect(opsCode(['insert', 'update', 'delete', 'truncate'])).toBe('iud');
    expect(opsCode(['delete', 'insert'])).toBe('id');
    expect(opsCode(['insert'])).toBe('i');
    expect(opsCode(['truncate'])).toBe('n');
  });
});

interface Server {
  slot: boolean;
  publications: string[];
  published: string[];
  xmin?: string;
  xmax?: string;
}

function rig(server: Server) {
  const statements: string[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const adapter = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('select pubname from pg_publication'))
        return { rows: server.publications.map((pubname) => ({ pubname })) };
      if (text.startsWith('select 1 from pg_replication_slots'))
        return { rows: server.slot ? [{}] : [] };
      if (text.startsWith('select confirmed_flush_lsn'))
        return { rows: [{ lsn: '0/1000' }] };
      if (text.startsWith('select 1 from pg_publication_tables'))
        return {
          rows: server.published.includes(
            `${String(params[0])}:${String(params[2])}`,
          )
            ? [{}]
            : [],
        };
      if (text.includes('txid_snapshot_xmax'))
        return { rows: [{ xmax: server.xmax ?? '100' }] };
      if (text.includes('txid_snapshot_xmin'))
        return { rows: [{ xmin: server.xmin ?? '100' }] };
      if (text.startsWith('select pg_current_wal_lsn()'))
        return { rows: [{ lsn: '0/2000' }] };
      statements.push(text.replace(/\$1/g, String(params[0] ?? '$1')));
      if (text.startsWith('CREATE PUBLICATION'))
        server.publications.push(/"([^"]+)"/.exec(text)![1]!);
      if (text.includes('pg_create_logical_replication_slot'))
        server.slot = true;
      return { rows: [] };
    },
  };
  const prisma = {
    cdcSharedMember: {
      findUnique: async ({ where }: { where: { bridgeId: string } }) =>
        rows.get(where.bridgeId) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { bridgeId: string };
        create: Record<string, unknown>;
      }) => rows.set(where.bridgeId, { ...create }),
      update: async ({
        where,
        data,
      }: {
        where: { bridgeId: string };
        data: Record<string, unknown>;
      }) => rows.set(where.bridgeId, { ...rows.get(where.bridgeId), ...data }),
      delete: async ({ where }: { where: { bridgeId: string } }) =>
        rows.delete(where.bridgeId),
      count: async () => 0,
      findMany: async () => [],
    },
  };
  const pool = {
    withAdapter: async (
      _c: string,
      _d: string | undefined,
      fn: (a: unknown) => unknown,
    ) => fn(adapter),
  };
  const service = new PgSharedSlotService(prisma as never, pool as never);
  return { service, statements, rows };
}

const bridge = (operations: CdcOperation[] = ['insert', 'update', 'delete']) =>
  ({
    id: 'b1',
    source: {
      kind: 'table',
      connectionId: 'c1',
      database: 'app',
      table: 'orders',
    },
    trigger: { kind: 'cdc', operations, startFrom: 'now', slot: 'shared' },
  }) as never;

describe('joining', () => {
  it('the first member: EVERY publication is made, and only then the slot — a publication younger than the slot breaks the stream', async () => {
    const r = rig({ slot: false, publications: [], published: [] });
    await r.service.join('b1', bridge(), 160004);
    const key = r.service.keyOf({ connectionId: 'c1', database: 'app' });
    const creates = r.statements.filter((s) =>
      s.startsWith('CREATE PUBLICATION'),
    );
    expect(creates).toHaveLength(OPS_CODES.length);
    const slotAt = r.statements.findIndex((s) =>
      s.includes('pg_create_logical_replication_slot'),
    );
    expect(slotAt).toBeGreaterThan(
      r.statements.lastIndexOf(creates[creates.length - 1]!),
    );
    // what each of them publishes is what its name says, and truncate always
    expect(creates.find((s) => s.includes(`_iud"`))).toContain(
      `publish = 'insert, update, delete, truncate'`,
    );
    expect(creates.find((s) => s.includes(`${key}_i"`))).toContain(
      `publish = 'insert, truncate'`,
    );
    expect(creates.find((s) => s.includes(`${key}_n"`))).toContain(
      `publish = 'truncate'`,
    );
    expect(
      creates.every((s) => s.includes('publish_via_partition_root = true')),
    ).toBe(true);
    // the table goes into ITS publication, after the slot exists
    const add = r.statements.findIndex((s) =>
      s.startsWith(
        `ALTER PUBLICATION "syncle_sp_${key}_iud" ADD TABLE "public"."orders"`,
      ),
    );
    expect(add).toBeGreaterThan(slotAt);
    // its position is taken after that: the current end of the WAL
    expect(r.rows.get('b1')).toMatchObject({
      slotKey: key,
      tableName: 'orders',
      ops: 'iud',
      confirmedLsn: '0/2000',
    });
  });

  it('a later member makes nothing: the slot and its publications are there', async () => {
    const key = new PgSharedSlotService({} as never, {} as never).keyOf({
      connectionId: 'c1',
      database: 'app',
    });
    const r = rig({
      slot: true,
      publications: OPS_CODES.map((c) => `syncle_sp_${key}_${c}`),
      published: [],
    });
    await r.service.join('b1', bridge(['insert']), 160004);
    expect(r.statements).toEqual([
      `ALTER PUBLICATION "syncle_sp_${key}_i" ADD TABLE "public"."orders"`,
    ]);
  });

  it('a server before 13 is not asked for an option it does not have', async () => {
    const r = rig({ slot: false, publications: [], published: [] });
    await r.service.join('b1', bridge(), 120010);
    expect(
      r.statements.some((s) => s.includes('publish_via_partition_root')),
    ).toBe(false);
  });

  it('a member that is one already keeps its position — also when it now wants other operations of its table', async () => {
    const key = new PgSharedSlotService({} as never, {} as never).keyOf({
      connectionId: 'c1',
      database: 'app',
    });
    const r = rig({
      slot: true,
      publications: OPS_CODES.map((c) => `syncle_sp_${key}_${c}`),
      published: [`syncle_sp_${key}_iud:orders`],
    });
    r.rows.set('b1', {
      bridgeId: 'b1',
      slotKey: key,
      schemaName: 'public',
      tableName: 'orders',
      ops: 'iud',
      confirmedLsn: '0/1500',
    });
    await r.service.join('b1', bridge(), 160004);
    expect(r.statements).toEqual([]);
    expect(r.rows.get('b1')).toMatchObject({ confirmedLsn: '0/1500' });

    await r.service.join('b1', bridge(['insert']), 160004);
    expect(r.statements).toEqual([
      `ALTER PUBLICATION "syncle_sp_${key}_i" ADD TABLE "public"."orders"`,
      `ALTER PUBLICATION "syncle_sp_${key}_iud" DROP TABLE "public"."orders"`,
    ]);
    expect(r.rows.get('b1')).toMatchObject({
      ops: 'i',
      confirmedLsn: '0/1500',
    });
  });

  it('a join that cannot get past the barrier leaves no member and no published table behind', async () => {
    const config = runtimeConfig as { sharedSlotJoinWaitMs: number };
    const before = config.sharedSlotJoinWaitMs;
    config.sharedSlotJoinWaitMs = 50;
    try {
      const key = new PgSharedSlotService({} as never, {} as never).keyOf({
        connectionId: 'c1',
        database: 'app',
      });
      // a transaction older than the moment the table was published never ends
      const r = rig({
        slot: true,
        publications: OPS_CODES.map((c) => `syncle_sp_${key}_${c}`),
        published: [],
        xmax: '200',
        xmin: '150',
      });
      await expect(
        r.service.join('b1', bridge(), 160004),
      ).rejects.toMatchObject({ details: { reason: 'shared-slot-busy' } });
      expect(r.rows.has('b1')).toBe(false);
      expect(r.statements.at(-1)).toBe(
        `ALTER PUBLICATION "syncle_sp_${key}_iud" DROP TABLE "public"."orders"`,
      );
    } finally {
      config.sharedSlotJoinWaitMs = before;
    }
  });

  it('bridges on one connection and database share a slot; another database is another slot', () => {
    const s = new PgSharedSlotService({} as never, {} as never);
    expect(s.keyOf({ connectionId: 'c1', database: 'app' })).toBe(
      s.keyOf({ connectionId: 'c1', database: 'app' }),
    );
    expect(s.keyOf({ connectionId: 'c1', database: 'app' })).not.toBe(
      s.keyOf({ connectionId: 'c1', database: 'other' }),
    );
    expect(s.keyOf({ connectionId: 'c1', database: 'app' })).not.toBe(
      s.keyOf({ connectionId: 'c2', database: 'app' }),
    );
    // a name PostgreSQL takes: lower case, digits and underscores, under 64 characters
    expect(
      s.slotName(s.keyOf({ connectionId: 'c1', database: 'app' })),
    ).toMatch(/^[a-z0-9_]{1,63}$/);
  });
});

describe('is there room on the server?', () => {
  function readiness(capacity: Record<string, unknown>) {
    const adapter = {
      query: async (sql: string) => {
        const text = sql.replace(/\s+/g, ' ');
        if (text.includes('max_replication_slots')) return { rows: [capacity] };
        if (text.includes('wal_level'))
          return {
            rows: [
              {
                wal_level: 'logical',
                can_replicate: true,
                rolreplication: true,
                rolsuper: true,
              },
            ],
          };
        return { rows: [] };
      },
    };
    const pool = {
      withAdapter: async (
        _c: string,
        _d: string | undefined,
        fn: (a: unknown) => unknown,
      ) => fn(adapter),
    };
    const shared = new PgSharedSlotService({} as never, pool as never);
    return new PostgresCdcProvider(pool as never, shared);
  }
  const full = {
    slots_max: 10,
    slots_used: 10,
    senders_max: 10,
    senders_used: 10,
    keep_limit: '1024',
  };

  it('a full server has room for one more member of a shared slot that is being read — and none for a first one', async () => {
    const dto = {
      connectionId: 'c1',
      database: 'app',
      table: 'orders',
      slot: 'shared' as const,
    };
    const joining = await readiness({
      ...full,
      owns_slot: true,
      slot_active: true,
    }).readiness(dto, {} as never);
    expect(
      joining.checks
        .filter((c) => /slot|sender/.test(c.label))
        .map((c) => c.ok),
    ).toEqual([true, true]);
    expect(joining.checks.find((c) => /slot/.test(c.label))!.detail).toMatch(
      /the shared slot this bridge reads through/,
    );

    const first = await readiness({
      ...full,
      owns_slot: false,
      slot_active: false,
    }).readiness(dto, {} as never);
    expect(
      first.checks.filter((c) => /slot|sender/.test(c.label)).map((c) => c.ok),
    ).toEqual([false, false]);
    expect(first.ready).toBe(false);
  });
});
