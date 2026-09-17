/**
 * Many bridges, ONE PostgreSQL replication slot.
 *
 * What has to hold: every member gets exactly its own table's changes, once; the
 * slot is confirmed only as far as the slowest member has got — also one that is
 * stopped — so a member that comes back finds what it missed; a member that
 * joins does so behind a barrier, so that nothing falls between its copy and
 * its stream; and an insert-only member never makes PostgreSQL refuse UPDATEs on
 * somebody's table because another member wanted updates.
 */
import 'reflect-metadata';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep, uniqueTable, waitFor, withAdapter } from './harness';
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

const SOURCE = {
  host: '127.0.0.1',
  port: 55432,
  user: 'syncle',
  password: 'syncle',
  database: 'syncle_test',
};

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  controller = app.ctx.get(BridgesController);
  // ONE connection for every source: that is what the bridges share a slot by
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));
const slots = async (like: string): Promise<string[]> =>
  (
    await src(
      `select slot_name from pg_replication_slots where slot_name like '${like}' order by 1`,
    )
  ).rows.map((r) => String(r.slot_name));
const published = async (): Promise<string[]> =>
  (
    await src(
      `select pubname || ':' || tablename as t from pg_publication_tables where pubname like 'syncle\\_sp\\_%' order by 1`,
    )
  ).rows.map((r) => String(r.t));

interface Made {
  id: string;
  source: string;
  dest: string;
}

async function member(
  opts: {
    table?: string;
    ddl?: string;
    operations?: string[];
    startFrom?: 'now' | 'beginning';
    slot?: 'own' | 'shared';
    start?: boolean;
    keyColumns?: string[];
    writeMode?: string;
  } = {},
): Promise<Made> {
  const source = opts.table ?? uniqueTable('ss_src');
  const dest = uniqueTable('ss_dst');
  if (!opts.table) {
    await src(
      opts.ddl
        ? opts.ddl.replace(/\$T/g, `"${source}"`)
        : `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
  }
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await controller.create(
    bridgeInputSchema.parse({
      name: `it-ss-${dest}`,
      source: { kind: 'table', connectionId: pg, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            writeMode: opts.writeMode ?? 'upsert',
            keyColumns: opts.keyColumns ?? ['id'],
            createMissingTable: true,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: {
        kind: 'cdc',
        operations: opts.operations ?? ['insert', 'update', 'delete'],
        startFrom: opts.startFrom ?? 'now',
        slot: opts.slot ?? 'shared',
      },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });
  if (opts.start !== false) await app.cdc.start(bridge.id);
  return { id: bridge.id, source, dest };
}

const names = async (dest: string): Promise<Record<number, unknown>> =>
  Object.fromEntries(
    (await destRows('postgres_dest', dest)).map((r) => [Number(r.id), r.name]),
  );
const arrived = (dest: string, want: Record<number, unknown>) =>
  waitFor(
    `${JSON.stringify(want)} in ${dest}`,
    async () =>
      JSON.stringify(await names(dest)) === JSON.stringify(want) ? true : null,
    { timeoutMs: 30_000 },
  );
const job = (bridgeId: string) =>
  app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });

describe('many bridges, one slot', () => {
  it('four tables are one slot and one reader — and each bridge gets its own table’s changes, once', async () => {
    const before = await slots('syncle_shared_%');
    const members = [
      await member(),
      await member(),
      await member(),
      await member(),
    ];
    const shared = (await slots('syncle_shared_%')).filter(
      (s) => !before.includes(s),
    );
    expect(shared).toHaveLength(1);
    // none of them has a slot of its own
    for (const m of members)
      expect(await slots(`syncle_slot_${m.id.replace(/-/g, '')}`)).toEqual([]);
    const active = await src(
      `select active from pg_replication_slots where slot_name = '${shared[0]}'`,
    );
    expect(active.rows[0]!.active).toBe(true);

    for (const [i, m] of members.entries())
      await src(
        `INSERT INTO "${m.source}" VALUES (1, 'm${i}-one'), (2, 'm${i}-two')`,
      );
    await src(
      `UPDATE "${members[2]!.source}" SET name = 'changed' WHERE id = 1`,
    );
    await src(`DELETE FROM "${members[3]!.source}" WHERE id = 2`);
    await arrived(members[0]!.dest, { 1: 'm0-one', 2: 'm0-two' });
    await arrived(members[1]!.dest, { 1: 'm1-one', 2: 'm1-two' });
    await arrived(members[2]!.dest, { 1: 'changed', 2: 'm2-two' });
    await arrived(members[3]!.dest, { 1: 'm3-one' });
    // exactly the deliveries its own table caused
    expect((await job(members[0]!.id)).sentCount).toBeGreaterThanOrEqual(1);
    expect((await job(members[0]!.id)).failedCount).toBe(0);

    // a bridge with a slot of its own lives next to them as before
    const own = await member({ slot: 'own' });
    expect(await slots(`syncle_slot_${own.id.replace(/-/g, '')}`)).toHaveLength(
      1,
    );
    await src(`INSERT INTO "${own.source}" VALUES (1, 'own')`);
    await arrived(own.dest, { 1: 'own' });

    // what it costs the source is said per member, by the shared slot's name
    const hold = await app.cdc.hold(members[0]!.id);
    expect(hold).toMatchObject({
      name: shared[0],
      exists: true,
      status: 'ok',
      kind: 'replication-slot',
    });
    expect(hold.detail).toMatch(/shared by \d+ bridges/);
  }, 120_000);

  it('two bridges on ONE table, wanting different things of it: each gets what it asked for', async () => {
    const all = await member();
    const insertsOnly = await member({
      table: all.source,
      operations: ['insert'],
    });
    await src(`INSERT INTO "${all.source}" VALUES (1, 'a'), (2, 'b')`);
    await arrived(all.dest, { 1: 'a', 2: 'b' });
    await arrived(insertsOnly.dest, { 1: 'a', 2: 'b' });
    await src(`UPDATE "${all.source}" SET name = 'a2' WHERE id = 1`);
    await src(`DELETE FROM "${all.source}" WHERE id = 2`);
    await arrived(all.dest, { 1: 'a2' });
    await sleep(800);
    expect(await names(insertsOnly.dest)).toEqual({ 1: 'a', 2: 'b' });
  }, 120_000);

  it('transactions that overlap ACROSS tables, and a COPY: nothing is dropped as "already seen"', async () => {
    const a = await member();
    const b = await member();
    const one = new Client(SOURCE);
    const two = new Client(SOURCE);
    await one.connect();
    await two.connect();
    try {
      // `one` starts first and commits LAST: its changes carry LOWER positions than `two`'s, and arrive after them
      await one.query('BEGIN');
      await one.query(`INSERT INTO "${a.source}" VALUES (1, 'one-a')`);
      await one.query(`INSERT INTO "${b.source}" VALUES (1, 'one-b')`);
      await two.query('BEGIN');
      await two.query(`INSERT INTO "${a.source}" VALUES (2, 'two-a')`);
      await two.query(`INSERT INTO "${b.source}" VALUES (2, 'two-b')`);
      await two.query('COMMIT');
      await one.query(`INSERT INTO "${b.source}" VALUES (3, 'one-b-late')`);
      await one.query('COMMIT');
    } finally {
      await one.end();
      await two.end();
    }
    await arrived(a.dest, { 1: 'one-a', 2: 'two-a' });
    await arrived(b.dest, { 1: 'one-b', 2: 'two-b', 3: 'one-b-late' });
    // many rows per WAL record, all sharing one position
    await src(
      `INSERT INTO "${a.source}" SELECT g, 'bulk' FROM generate_series(100, 1299) g`,
    );
    await waitFor(
      'the bulk rows',
      async () =>
        (await destRows('postgres_dest', a.dest)).length === 1202 ? true : null,
      { timeoutMs: 60_000 },
    );
  }, 180_000);
});

describe('the slot is confirmed as far as the SLOWEST member has got', () => {
  it('a member that is stopped misses nothing, the others are not held up — and nobody gets anything twice', async () => {
    const a = await member();
    const b = await member();
    await src(`INSERT INTO "${a.source}" VALUES (1, 'a1')`);
    await src(`INSERT INTO "${b.source}" VALUES (1, 'b1')`);
    await arrived(a.dest, { 1: 'a1' });
    await arrived(b.dest, { 1: 'b1' });

    await app.cdc.stop(a.id);
    await src(
      `INSERT INTO "${a.source}" VALUES (2, 'a2-while-stopped'), (3, 'a3-while-stopped')`,
    );
    await src(
      `UPDATE "${a.source}" SET name = 'a1-changed-while-stopped' WHERE id = 1`,
    );
    for (let i = 2; i <= 6; i++)
      await src(`INSERT INTO "${b.source}" VALUES (${i}, 'b${i}')`);
    await arrived(b.dest, {
      1: 'b1',
      2: 'b2',
      3: 'b3',
      4: 'b4',
      5: 'b5',
      6: 'b6',
    });
    expect(await names(a.dest)).toEqual({ 1: 'a1' });

    // the server has NOT been told it may forget what `a` still needs
    const held = await src(
      `select (s.confirmed_flush_lsn <= m.lsn::pg_lsn) as held
       from pg_replication_slots s, (select '${(await app.prisma.cdcSharedMember.findUnique({ where: { bridgeId: a.id } })).confirmedLsn}' as lsn) m
       where s.slot_name like 'syncle_shared_%'`,
    );
    expect(held.rows.some((r) => r.held === true)).toBe(true);

    const sentByB = (await job(b.id)).sentCount;
    await app.cdc.start(a.id);
    await arrived(a.dest, {
      1: 'a1-changed-while-stopped',
      2: 'a2-while-stopped',
      3: 'a3-while-stopped',
    });
    // the stream was restarted from `a`'s position, and sent `b`'s changes again: `b` dropped them
    await sleep(1000);
    expect((await job(b.id)).sentCount).toBe(sentByB);
    expect(await names(b.dest)).toEqual({
      1: 'b1',
      2: 'b2',
      3: 'b3',
      4: 'b4',
      5: 'b5',
      6: 'b6',
    });
    await src(`INSERT INTO "${b.source}" VALUES (7, 'b7')`);
    await arrived(b.dest, {
      1: 'b1',
      2: 'b2',
      3: 'b3',
      4: 'b4',
      5: 'b5',
      6: 'b6',
      7: 'b7',
    });
  }, 180_000);
});

describe('what a member asks of its table stays its own business', () => {
  it('an insert-only member on a table WITHOUT a key does not stop that table taking UPDATEs, whatever the other members publish', async () => {
    const updates = await member(); // publishes insert, update, delete — on ITS table
    const log = await member({
      ddl: 'CREATE TABLE $T (id integer, name text)',
      operations: ['insert'],
      writeMode: 'insert',
      keyColumns: [],
    });
    await src(`INSERT INTO "${log.source}" VALUES (1, 'event')`);
    await waitFor('the event', async () =>
      (await destRows('postgres_dest', log.dest)).length === 1 ? true : null,
    );
    // in a publication that publishes updates, PostgreSQL would refuse this:
    //   "cannot update table … because it does not have a replica identity and publishes updates"
    await expect(
      src(`UPDATE "${log.source}" SET name = 'edited at the source'`),
    ).resolves.toBeDefined();
    await expect(src(`DELETE FROM "${log.source}"`)).resolves.toBeDefined();
    await src(`INSERT INTO "${updates.source}" VALUES (1, 'x')`);
    await arrived(updates.dest, { 1: 'x' });
  }, 120_000);
});

describe('joining a slot that is already being read', () => {
  it('copy, then follow: a transaction that was open ACROSS the join is not lost between the two', async () => {
    const first = await member();
    await src(`INSERT INTO "${first.source}" VALUES (1, 'first')`);
    await arrived(first.dest, { 1: 'first' });

    const table = uniqueTable('ss_src');
    await src(
      `CREATE TABLE "${table}" (id integer PRIMARY KEY, name text); INSERT INTO "${table}" VALUES (1, 'was there')`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
    );

    // changed BEFORE the table is published, committed after: in no stream. it has to be in the copy
    const straddler = new Client(SOURCE);
    await straddler.connect();
    await straddler.query('BEGIN');
    await straddler.query(
      `INSERT INTO "${table}" VALUES (2, 'written before the join, committed during it')`,
    );
    const committing = sleep(1500).then(() => straddler.query('COMMIT'));
    const started = Date.now();
    const joined = await member({ table, startFrom: 'beginning' });
    await committing;
    await straddler.end();
    // the join waited for it
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);

    await src(`INSERT INTO "${table}" VALUES (3, 'after the join')`);
    await arrived(joined.dest, {
      1: 'was there',
      2: 'written before the join, committed during it',
      3: 'after the join',
    });
    // the member that was already reading went on
    await src(`INSERT INTO "${first.source}" VALUES (2, 'still here')`);
    await arrived(first.dest, { 1: 'first', 2: 'still here' });
  }, 180_000);

  it('a transaction that never ends: the join gives up, says which, and leaves nothing behind', async () => {
    const { runtimeConfig } = await import('../../src/common/runtime-config');
    const config = runtimeConfig as { sharedSlotJoinWaitMs: number };
    const before = config.sharedSlotJoinWaitMs;
    config.sharedSlotJoinWaitMs = 1000;
    const blocker = new Client({
      ...SOURCE,
      application_name: 'a-report-left-open',
    });
    await blocker.connect();
    try {
      const anchor = await member();
      const other = uniqueTable('ss_src');
      await src(`CREATE TABLE "${other}" (id integer PRIMARY KEY, name text)`);
      cleanups.push(() =>
        withAdapter('postgres', (a) => a.dropTable(other)).then(
          () => undefined,
        ),
      );
      await blocker.query('BEGIN');
      await blocker.query(
        `INSERT INTO "${other}" VALUES (1, 'never committed')`,
      );

      const refused = await member({ table: other, start: false });
      await expect(app.cdc.start(refused.id)).rejects.toMatchObject({
        message: expect.stringMatching(
          /could not join the shared replication slot.*a-report-left-open/s,
        ),
        details: { reason: 'shared-slot-busy' },
      });
      expect(
        await app.prisma.cdcSharedMember.findUnique({
          where: { bridgeId: refused.id },
        }),
      ).toBeNull();
      expect(
        (await published()).filter((t) => t.endsWith(`:${other}`)),
      ).toEqual([]);

      await blocker.query('ROLLBACK');
      await app.cdc.start(refused.id);
      await src(`INSERT INTO "${other}" VALUES (2, 'now it works')`);
      await arrived(refused.dest, { 2: 'now it works' });
      await src(`INSERT INTO "${anchor.source}" VALUES (1, 'unaffected')`);
      await arrived(anchor.dest, { 1: 'unaffected' });
    } finally {
      config.sharedSlotJoinWaitMs = before;
      await blocker.end().catch(() => undefined);
    }
  }, 180_000);
});

describe('leaving', () => {
  it('a member that is deleted takes its table out; the last one takes the slot and the publications with it', async () => {
    // (its own connection, so that it is its own slot whatever the other tests have running)
    const conn = await connectionFor(app, 'postgres');
    const saved = pg;
    pg = conn;
    try {
      const before = await slots('syncle_shared_%');
      const a = await member();
      const b = await member();
      const mine = (await slots('syncle_shared_%')).filter(
        (s) => !before.includes(s),
      );
      expect(mine).toHaveLength(1);
      const key = mine[0]!.replace('syncle_shared_', '');
      const tables = async () =>
        (await published()).filter((t) => t.startsWith(`syncle_sp_${key}_`));
      expect(await tables()).toEqual(
        [
          `syncle_sp_${key}_iud:${a.source}`,
          `syncle_sp_${key}_iud:${b.source}`,
        ].sort(),
      );

      await controller.remove(a.id);
      expect(await slots(mine[0]!)).toHaveLength(1);
      expect(await tables()).toEqual([`syncle_sp_${key}_iud:${b.source}`]);
      await src(`INSERT INTO "${b.source}" VALUES (1, 'b goes on')`);
      await arrived(b.dest, { 1: 'b goes on' });

      await controller.remove(b.id);
      expect(await slots(mine[0]!)).toEqual([]);
      expect(
        (
          await src(
            `select 1 from pg_publication where pubname like 'syncle\\_sp\\_${key}\\_%'`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        await app.prisma.cdcSharedMember.count({ where: { slotKey: key } }),
      ).toBe(0);
    } finally {
      pg = saved;
    }
  }, 180_000);

  it('from a slot of its own to the shared one, and back: the slot it had goes at once, it follows from its new place — and the timeline says what that means', async () => {
    const b = await member({ slot: 'own' });
    await src(`INSERT INTO "${b.source}" VALUES (1, 'through its own slot')`);
    await arrived(b.dest, { 1: 'through its own slot' });
    const ownSlot = `syncle_slot_${b.id.replace(/-/g, '')}`;
    expect(await slots(ownSlot)).toHaveLength(1);

    const bridge = await app.bridges.get(b.id);
    await controller.update(b.id, {
      ...bridge,
      trigger: { ...bridge.trigger, slot: 'shared' },
    });
    // not left behind to pin WAL for a reader that will never come
    expect(await slots(ownSlot)).toEqual([]);
    expect(
      await app.prisma.cdcSharedMember.count({ where: { bridgeId: b.id } }),
    ).toBe(1);
    // it was live when it was saved, so it is live again — through the shared slot
    await src(
      `INSERT INTO "${b.source}" VALUES (2, 'through the shared slot')`,
    );
    await arrived(b.dest, {
      1: 'through its own slot',
      2: 'through the shared slot',
    });
    const notices = await app.prisma.bridgeDelivery.findMany({
      where: { job: { bridgeId: b.id }, status: 'skipped' },
    });
    expect(
      notices.map((n: { error: string | null }) => n.error).join(' '),
    ).toMatch(
      /Switched to the shared replication slot.*NOT captured.*reconcile/s,
    );

    await controller.update(b.id, {
      ...bridge,
      trigger: { ...bridge.trigger, slot: 'own' },
    });
    expect(
      await app.prisma.cdcSharedMember.count({ where: { bridgeId: b.id } }),
    ).toBe(0);
    expect(await slots(ownSlot)).toHaveLength(1);
    await src(`INSERT INTO "${b.source}" VALUES (3, 'and back')`);
    await arrived(b.dest, {
      1: 'through its own slot',
      2: 'through the shared slot',
      3: 'and back',
    });
  }, 180_000);
});

describe('a stopped member that holds too much', () => {
  it('the guard gives up THAT member’s place — not the slot the others are reading through', async () => {
    const { runtimeConfig } = await import('../../src/common/runtime-config');
    const { SourceGuardService } =
      await import('../../src/bridges/cdc/source-guard.service');
    const guard = app.ctx.get(SourceGuardService);
    const config = runtimeConfig as unknown as { slotMaxBytes: number };
    const stopped = await member();
    const running = await member();
    await src(`INSERT INTO "${stopped.source}" VALUES (1, 's1')`);
    await arrived(stopped.dest, { 1: 's1' });
    await app.cdc.stop(stopped.id);
    // change log the stopped member has not read, and keeps the server from discarding
    await src(
      `INSERT INTO "${running.source}" SELECT g, repeat('x', 500) FROM generate_series(1, 400) g`,
    );
    await waitFor(
      'the running member',
      async () =>
        (await destRows('postgres_dest', running.dest)).length === 400
          ? true
          : null,
      { timeoutMs: 60_000 },
    );
    const held = await app.cdc.hold(stopped.id);
    expect(held.retainedBytes).toBeGreaterThan(100_000);
    const shared = held.name;

    config.slotMaxBytes = 50_000;
    try {
      await guard.check(stopped.id);
    } finally {
      config.slotMaxBytes = 0;
    }
    // its place is gone, and it says so; the slot is where it was, and being read
    expect(
      await app.prisma.cdcSharedMember.findUnique({
        where: { bridgeId: stopped.id },
      }),
    ).toBeNull();
    expect((await job(stopped.id)).status).toBe('failed');
    expect(await slots(shared)).toEqual([shared]);
    await src(`INSERT INTO "${running.source}" VALUES (1000, 'still flowing')`);
    await waitFor('the running member, after', async () =>
      (await names(running.dest))[1000] === 'still flowing' ? true : null,
    );

    await expect(app.cdc.start(stopped.id)).rejects.toMatchObject({
      details: { reason: 'position-lost' },
    });
    await app.cdc.start(stopped.id, { fromNow: true });
    await src(`INSERT INTO "${stopped.source}" VALUES (2, 'from now')`);
    await arrived(stopped.dest, { 1: 's1', 2: 'from now' });
  }, 180_000);
});

describe('many tables at once', () => {
  it('a bridge per table, the ones that cannot have one said why — and together they are one slot, copied and followed', async () => {
    const conn = await connectionFor(app, 'postgres');
    const tag = uniqueTable('bulk').slice(-8);
    const tables = [`orders_${tag}`, `customers_${tag}`, `events_${tag}`];
    await src(
      `CREATE TABLE "${tables[0]}" (id integer PRIMARY KEY, total numeric(10,2)); INSERT INTO "${tables[0]}" VALUES (1, 19.90), (2, 5.00)`,
    );
    await src(
      `CREATE TABLE "${tables[1]}" (tenant integer, email text, name text, PRIMARY KEY (tenant, email)); INSERT INTO "${tables[1]}" VALUES (1, 'a@example.com', 'Ada')`,
    );
    await src(`CREATE TABLE "${tables[2]}" (at timestamptz, what text)`); // no key
    for (const t of tables)
      cleanups.push(() =>
        withAdapter('postgres', (a) => a.dropTable(t)).then(() => undefined),
      );
    for (const t of tables)
      cleanups.push(() =>
        withAdapter('postgres_dest', (a) => a.dropTable(`copy_${t}`)).then(
          () => undefined,
        ),
      );

    const { bridgeBulkSchema, verifyStartSchema } =
      await import('@syncle/core');
    const result = await controller.bulk(
      bridgeBulkSchema.parse({
        source: {
          connectionId: conn,
          tables: [...tables, `no_such_table_${tag}`],
        },
        destination: { connectionId: pgDest, tablePrefix: 'copy_' },
        trigger: { kind: 'cdc' },
      }),
    );
    for (const c of result.created) {
      cleanups.push(async () => {
        await app.cdc.stop(c.id).catch(() => undefined);
        await controller.remove(c.id).catch(() => undefined);
      });
    }
    expect(
      result.created.map((c: { table: string }) => c.table).sort(),
    ).toEqual([tables[1], tables[0]].sort());
    expect(result.created.map((c: { name: string }) => c.name).sort()).toEqual(
      [
        `${tables[1]} → copy_${tables[1]}`,
        `${tables[0]} → copy_${tables[0]}`,
      ].sort(),
    );
    const reasons = Object.fromEntries(
      result.skipped.map((k: { table: string; reason: string }) => [
        k.table,
        k.reason,
      ]),
    );
    expect(reasons[tables[2]!]).toMatch(/no primary key/);
    expect(reasons[`no_such_table_${tag}`]).toMatch(/could not be read/);

    // what it made are ordinary bridges: keyed by the table's own key, shared slot, copy first
    const orders = await app.bridges.get(
      result.created.find((c: { table: string }) => c.table === tables[0])!.id,
    );
    const customers = await app.bridges.get(
      result.created.find((c: { table: string }) => c.table === tables[1])!.id,
    );
    expect(orders.trigger).toEqual({
      kind: 'cdc',
      operations: ['insert', 'update', 'delete'],
      startFrom: 'beginning',
      slot: 'shared',
    });
    expect(orders.destination.targets[0]).toMatchObject({
      table: `copy_${tables[0]}`,
      keyColumns: ['id'],
      writeMode: 'upsert',
      createMissingTable: true,
      mapping: [],
    });
    expect(customers.destination.targets[0].keyColumns).toEqual([
      'tenant',
      'email',
    ]);

    const before = await slots('syncle_shared_%');
    for (const c of result.created) await app.cdc.start(c.id);
    expect((await slots('syncle_shared_%')).length - before.length).toBe(1);
    await src(`INSERT INTO "${tables[0]}" VALUES (3, 7.25)`);
    await src(`UPDATE "${tables[1]}" SET name = 'Ada L.' WHERE tenant = 1`);
    await waitFor('the copies', async () => {
      const o = await destRows('postgres_dest', `copy_${tables[0]}`);
      const c = await destRows('postgres_dest', `copy_${tables[1]}`);
      return o.length === 3 && c[0]?.name === 'Ada L.' ? true : null;
    });

    // and the copy IS the source, says the thing whose job it is to say so
    for (const c of result.created) {
      const started = await controller.startVerification(
        c.id,
        verifyStartSchema.parse({}),
      );
      const v = await waitFor('the verification', async () => {
        const now = await controller.verification(c.id, started.id);
        return ['completed', 'failed'].includes(now.status) ? now : null;
      });
      expect(v).toMatchObject({ status: 'completed', inSync: true });
    }
  }, 180_000);
});
