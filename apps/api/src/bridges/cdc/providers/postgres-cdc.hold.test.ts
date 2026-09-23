/**
 * The Postgres provider's view of what a bridge costs its source: the state of
 * its replication slot, whether the server has room for another one, and
 * whether dropping a slot really worked. The database is a double that answers
 * each catalog query from a script.
 */
import { describe, expect, it } from 'vitest';
import { PostgresCdcProvider } from './postgres-cdc.provider';

/** these bridges have a slot of their own: the shared-slot service is only ever told they are not members */
const NOT_SHARED = {
  isMember: async () => false,
  leave: async () => undefined,
  join: async () => undefined,
  position: async () => null,
} as never;

type Answer = (
  sql: string,
  params?: unknown[],
) => Record<string, unknown>[] | Error | undefined;

function providerWith(answer: Answer) {
  const statements: string[] = [];
  const adapter = {
    query: async (sql: string, params?: unknown[]) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push(text);
      const result = answer(text, params);
      if (result instanceof Error) throw result;
      return { rows: result ?? [] };
    },
  };
  const pool = {
    withAdapter: async (
      _c: string,
      _d: string | undefined,
      fn: (a: unknown) => unknown,
    ) => fn(adapter),
  };
  return {
    provider: new PostgresCdcProvider(pool as never, NOT_SHARED),
    statements,
  };
}

const bridge = {
  id: 'b',
  source: { kind: 'table', connectionId: 'c', table: 't' },
  trigger: { kind: 'cdc' },
} as never;
const SLOT = 'syncle_slot_b1';

/** server facts first, then the slot row */
const server =
  (
    version: number,
    keepLimitMb: string | null,
    slot?: Record<string, unknown>,
  ): Answer =>
  (sql) => {
    if (sql.includes('server_version_num'))
      return [{ version, keep_limit: keepLimitMb }];
    if (sql.includes('from pg_replication_slots s')) return slot ? [slot] : [];
    return [];
  };

describe('inspect', () => {
  it('reports a healthy slot and how much WAL it pins', async () => {
    const { provider } = providerWith(
      server(160004, '-1', {
        active: true,
        retained: '1048576',
        wal_status: 'reserved',
      }),
    );
    expect(await provider.inspect('b-1', bridge)).toEqual({
      engine: 'postgres',
      kind: 'replication-slot',
      name: SLOT,
      exists: true,
      active: true,
      retainedBytes: 1048576,
      limitBytes: null, // -1: nothing caps it
      status: 'ok',
      detail: undefined,
    });
  });

  it('converts max_slot_wal_keep_size from megabytes', async () => {
    const { provider } = providerWith(
      server(160004, '10240', {
        active: false,
        retained: '5',
        wal_status: 'extended',
      }),
    );
    const hold = await provider.inspect('b-1', bridge);
    expect(hold).toMatchObject({
      limitBytes: 10240 * 1024 * 1024,
      status: 'ok',
      active: false,
    });
  });

  it('a slot past the limit is at risk; one the server gave up is lost', async () => {
    const risky = providerWith(
      server(160004, '64', {
        active: false,
        retained: '99999999',
        wal_status: 'unreserved',
      }),
    );
    expect(await risky.provider.inspect('b-1', bridge)).toMatchObject({
      status: 'at-risk',
      exists: true,
    });

    const lost = providerWith(
      server(160004, '64', {
        active: false,
        retained: null,
        wal_status: 'lost',
      }),
    );
    const hold = await lost.provider.inspect('b-1', bridge);
    expect(hold).toMatchObject({
      status: 'lost',
      exists: true,
      retainedBytes: null,
    });
    expect(hold!.detail).toMatch(/invalidated/);
  });

  it('a slot that does not exist is lost, not "fine, nothing held"', async () => {
    const { provider } = providerWith(server(160004, '-1'));
    expect(await provider.inspect('b-1', bridge)).toMatchObject({
      exists: false,
      status: 'lost',
      detail: `replication slot "${SLOT}" does not exist on the server`,
    });
  });

  it('does not ask PostgreSQL 12 for columns it does not have', async () => {
    const { provider, statements } = providerWith(
      server(120018, null, { active: true, retained: '42' }),
    );
    expect(await provider.inspect('b-1', bridge)).toMatchObject({
      status: 'ok',
      retainedBytes: 42,
      limitBytes: null,
    });
    expect(statements.join('\n')).not.toContain('wal_status');
  });

  it('measures against the received position on a standby, where there is no "current" one', async () => {
    const { provider, statements } = providerWith(
      server(160004, '-1', {
        active: true,
        retained: '0',
        wal_status: 'reserved',
      }),
    );
    await provider.inspect('b-1', bridge);
    expect(statements.find((s) => s.includes('pg_wal_lsn_diff'))).toContain(
      'pg_is_in_recovery()',
    );
  });

  it('never reports a negative amount', async () => {
    const { provider } = providerWith(
      server(160004, '-1', {
        active: true,
        retained: '-8',
        wal_status: 'reserved',
      }),
    );
    expect((await provider.inspect('b-1', bridge))!.retainedBytes).toBe(0);
  });
});

describe('readiness: room on the server', () => {
  const ready =
    (capacity: Record<string, unknown>): Answer =>
    (sql) => {
      if (sql.includes(`current_setting('wal_level')`))
        return [{ wal_level: 'logical', can_replicate: true }];
      if (sql.includes('max_replication_slots')) return [capacity];
      if (sql.includes('relreplident'))
        return [{ kind: 'd', relkind: 'r', version: 160004, columns: ['id'] }];
      return [];
    };
  const dto = { connectionId: 'c', table: 't' };
  const roomy = {
    slots_max: 10,
    slots_used: 3,
    senders_max: 10,
    senders_used: 1,
    owns_slot: false,
    keep_limit: '2048',
  };

  it('passes with slots and senders to spare, and says how many', async () => {
    const { provider } = providerWith(ready(roomy));
    const r = await provider.readiness(dto, {} as never);
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.label === 'a free replication slot')).toEqual(
      {
        label: 'a free replication slot',
        ok: true,
        detail: '3 of 10 in use',
      },
    );
    expect(r.advisories).toBeUndefined(); // the server has a cap
  });

  it('is not ready when every slot is taken, and says how to free one', async () => {
    const { provider } = providerWith(ready({ ...roomy, slots_used: 10 }));
    const r = await provider.readiness(dto, {} as never);
    expect(r.ready).toBe(false);
    expect(r.instructions.join(' ')).toMatch(/max_replication_slots = 10/);
    expect(r.instructions.join(' ')).toMatch(/pg_replication_slots/);
  });

  it('a bridge that already owns a slot is not failed by a full server', async () => {
    const { provider, statements } = providerWith(
      ready({ ...roomy, slots_used: 10, owns_slot: true }),
    );
    const r = await provider.readiness(
      { ...dto, bridgeId: 'b-1' },
      {} as never,
    );
    expect(r.ready).toBe(true);
    expect(
      r.checks.find((c) => c.label === 'a free replication slot')!.detail,
    ).toMatch(/this bridge/);
    expect(statements.some((s) => s.includes('max_replication_slots'))).toBe(
      true,
    );
  });

  it('is not ready without a free WAL sender', async () => {
    const { provider } = providerWith(ready({ ...roomy, senders_used: 10 }));
    const r = await provider.readiness(dto, {} as never);
    expect(r.ready).toBe(false);
    expect(r.instructions.join(' ')).toMatch(/max_wal_senders = 10/);
  });

  it('advises — without blocking — when nothing caps the WAL a slot can pin', async () => {
    const { provider } = providerWith(ready({ ...roomy, keep_limit: '-1' }));
    const r = await provider.readiness(dto, {} as never);
    expect(r.ready).toBe(true);
    expect(r.advisories?.[0]).toMatch(/max_slot_wal_keep_size = -1/);
  });

  it('says nothing about a setting PostgreSQL 12 does not have', async () => {
    const { provider } = providerWith(ready({ ...roomy, keep_limit: null }));
    expect(
      (await provider.readiness(dto, {} as never)).advisories,
    ).toBeUndefined();
  });

  it('a capacity query that fails does not fail the whole check', async () => {
    const { provider } = providerWith((sql) => {
      if (sql.includes(`current_setting('wal_level')`))
        return [{ wal_level: 'logical', can_replicate: true }];
      if (sql.includes('max_replication_slots'))
        return new Error('permission denied for pg_stat_replication');
      return [];
    });
    expect((await provider.readiness(dto, {} as never)).ready).toBe(true);
  });
});

describe('deprovision', () => {
  it('resolves once the slot is gone', async () => {
    const { provider, statements } = providerWith(() => []);
    await expect(provider.deprovision('b-1', bridge)).resolves.toBeUndefined();
    expect(statements.some((s) => s.includes('pg_drop_replication_slot'))).toBe(
      true,
    );
    expect(
      statements.some((s) => s.startsWith('DROP PUBLICATION IF EXISTS')),
    ).toBe(true);
  });

  it('a slot that is already gone is the state we wanted', async () => {
    const { provider } = providerWith((sql) =>
      sql.includes('pg_drop_replication_slot')
        ? new Error(`replication slot "${SLOT}" does not exist`)
        : [],
    );
    await expect(provider.deprovision('b-1', bridge)).resolves.toBeUndefined();
  });

  it('THROWS when the slot could not be dropped — it used to log and forget', async () => {
    const { provider, statements } = providerWith((sql) =>
      sql.includes('pg_drop_replication_slot')
        ? new Error(`replication slot "${SLOT}" is active for PID 4242`)
        : [],
    );
    await expect(provider.deprovision('b-1', bridge)).rejects.toThrow(
      /could not drop replication slot "syncle_slot_b1".*active for PID 4242/,
    );
    // it tried more than once first, and still cleaned up the harmless part
    expect(
      statements.filter((s) => s.includes('pg_drop_replication_slot')).length,
    ).toBeGreaterThan(1);
    expect(
      statements.some((s) => s.startsWith('DROP PUBLICATION IF EXISTS')),
    ).toBe(true);
  }, 20_000);
});
