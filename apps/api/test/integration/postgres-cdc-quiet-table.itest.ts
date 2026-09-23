/**
 * A bridge on a QUIET table in a BUSY database.
 *
 * PostgreSQL 15+ does not send a subscriber the transactions that touch nothing
 * it publishes. A bridge whose table is quiet is sent keepalives and nothing
 * else — and, answering them with the position of its last delivery, it never
 * let its slot move: the server kept every byte of WAL the rest of the database
 * wrote, for as long as the bridge was RUNNING and healthy. Measured before the
 * fix: 40 transactions on another table, and the slot 20 MB behind, for good.
 */
import 'reflect-metadata';
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
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  controller = app.ctx.get(BridgesController);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const q = (sql: string) => withAdapter('postgres', (a) => a.query(sql));

async function quietBridge(slot: 'own' | 'shared', conn: string, dest: string) {
  const source = uniqueTable('quiet_src');
  const target = uniqueTable('quiet_dst');
  await q(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
  );
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(target)).then(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await controller.create(
    bridgeInputSchema.parse({
      name: `it-quiet-${source}`,
      source: { kind: 'table', connectionId: conn, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: dest,
            table: target,
            keyColumns: ['id'],
            createMissingTable: true,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: {
        kind: 'cdc',
        operations: ['insert', 'update', 'delete'],
        startFrom: 'now',
        slot,
      },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });
  await app.cdc.start(bridge.id);
  return { id: bridge.id as string, source, target };
}

/** how far behind the end of the WAL the slot's confirmed position is, in bytes */
async function behind(slotLike: string): Promise<number> {
  const r = await q(
    `select pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint as behind from pg_replication_slots where slot_name like '${slotLike}'`,
  );
  return Number(r.rows[0]?.behind);
}

/** ~20 MB of WAL that has nothing to do with any bridge */
async function busyElsewhere(): Promise<void> {
  const busy = uniqueTable('busy');
  await q(`CREATE TABLE "${busy}" (id serial PRIMARY KEY, pad text)`);
  for (let i = 0; i < 40; i++)
    await q(
      `INSERT INTO "${busy}" (pad) SELECT repeat('x', 900) FROM generate_series(1, 500)`,
    );
  await q(`DROP TABLE "${busy}"`);
}

describe.each(['own', 'shared'] as const)(
  'a quiet table, read through a slot that is %s',
  (slot) => {
    it('does not make the server keep what the REST of the database writes — and misses nothing of its own', async () => {
      // (a connection of its own, so that a shared slot is this test's alone)
      const conn = await connectionFor(app, 'postgres');
      const dest = await connectionFor(app, 'postgres_dest');
      const b = await quietBridge(slot, conn, dest);
      const slotName =
        slot === 'own'
          ? `syncle_slot_${b.id.replace(/-/g, '')}`
          : `syncle_shared_${(await app.cdc.hold(b.id)).name.replace('syncle_shared_', '')}`;

      await q(`INSERT INTO "${b.source}" VALUES (1, 'before')`);
      await waitFor('the first row', async () =>
        (await destRows('postgres_dest', b.target)).length === 1 ? true : null,
      );

      await busyElsewhere();
      // a keepalive or two (the test server's wal_sender_timeout is 5 s)
      await waitFor(
        'the slot to follow',
        async () => ((await behind(slotName)) < 2_000_000 ? true : null),
        { timeoutMs: 30_000, intervalMs: 500 },
      );
      expect(await behind(slotName)).toBeLessThan(2_000_000);

      // the position was moved by keepalives, not by deliveries: nothing of the bridge's own may be lost to it
      await q(`INSERT INTO "${b.source}" VALUES (2, 'after the busy spell')`);
      await q(`UPDATE "${b.source}" SET name = 'before, changed' WHERE id = 1`);
      const names = async () =>
        Object.fromEntries(
          (await destRows('postgres_dest', b.target)).map((r) => [
            Number(r.id),
            r.name,
          ]),
        );
      await waitFor('both changes', async () => {
        const now = await names();
        return now[1] === 'before, changed' && now[2] === 'after the busy spell'
          ? true
          : null;
      });

      // …also across a stop and a start: the saved cursor is OLDER than what the server was told
      await app.cdc.stop(b.id);
      await q(`INSERT INTO "${b.source}" VALUES (3, 'while stopped')`);
      await busyElsewhere();
      await app.cdc.start(b.id);
      await waitFor('the row written while it was stopped', async () =>
        (await names())[3] === 'while stopped' ? true : null,
      );
      const job = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: b.id },
      });
      expect(job).toMatchObject({ status: 'running', failedCount: 0 });
      await sleep(500);
      expect(await names()).toEqual({
        1: 'before, changed',
        2: 'after the busy spell',
        3: 'while stopped',
      });
    }, 180_000);
  },
);
