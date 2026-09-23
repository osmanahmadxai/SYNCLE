/**
 * What a CDC bridge leaves on its SOURCE, and who cleans it up.
 *
 * A PostgreSQL replication slot makes the server keep every byte of WAL written
 * since the slot's position for as long as the slot exists — read or not. So
 * every way a bridge can stop reading without its slot being dropped is a way
 * to fill someone's disk, quietly:
 *
 *  - it is paused or failed (nothing measured what that was costing)
 *  - it is edited into a watch bridge, or moved to another server (the slot was
 *    never dropped: nothing pointed at the old source any more)
 *  - it is deleted while the source is unreachable (the failure was logged and
 *    the slot's name forgotten along with the bridge)
 *
 * And the other half: when a slot IS gone — dropped by hand, given up by the
 * guard, invalidated by the server — the bridge must not quietly make a new one
 * and carry on from "now" with a hole in the destination.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';

const ENV_BEFORE = {
  check: process.env.SYNCLE_SLOT_CHECK_SECONDS,
  warn: process.env.SYNCLE_SLOT_WARN_BYTES,
};
// swept by hand, so a test decides when; and a warning level a test can reach
process.env.SYNCLE_SLOT_CHECK_SECONDS = '0';
process.env.SYNCLE_SLOT_WARN_BYTES = String(2 * 1024 * 1024);

import {
  bootstrapApp,
  connectionFor,
  destRows,
  makeBridge,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let guard: any;
let controller: any;
let connections: any;
let pgProvider: any;
let config: { slotMaxBytes: number };
let srcConn: string;
let dstConn: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { SourceGuardService } =
    await import('../../src/bridges/cdc/source-guard.service');
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { ConnectionsController } =
    await import('../../src/connections/connections.controller');
  const { PostgresCdcProvider } =
    await import('../../src/bridges/cdc/providers/postgres-cdc.provider');
  const { runtimeConfig } = await import('../../src/common/runtime-config');
  guard = app.ctx.get(SourceGuardService);
  controller = app.ctx.get(BridgesController);
  connections = app.ctx.get(ConnectionsController);
  pgProvider = app.ctx.get(PostgresCdcProvider);
  config = runtimeConfig as unknown as { slotMaxBytes: number };
  srcConn = await connectionFor(app, 'postgres');
  dstConn = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  // whatever else happened, never leave the shared server short of slots
  await src(
    `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'it_fill_%'`,
  ).catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  for (const [key, value] of [
    ['SYNCLE_SLOT_CHECK_SECONDS', ENV_BEFORE.check],
    ['SYNCLE_SLOT_WARN_BYTES', ENV_BEFORE.warn],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const src = (sql: string, params?: unknown[]) =>
  withAdapter('postgres', (a) => a.query(sql, params));
const dst = (sql: string, params?: unknown[]) =>
  withAdapter('postgres_dest', (a) => a.query(sql, params));

const dstIds = (table: string): Promise<number[]> =>
  dst(`SELECT id FROM "${table}" ORDER BY id`).then(
    (r) => r.rows.map((row) => Number(row.id)),
    () => [],
  );

const slotOf = (bridgeId: string): string =>
  `syncle_slot_${bridgeId.replace(/-/g, '')}`;
const slotExists = async (bridgeId: string): Promise<boolean> =>
  (
    await src(`SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`, [
      slotOf(bridgeId),
    ])
  ).rows.length > 0;

/** write roughly `mb` megabytes of WAL that has nothing to do with any bridge */
async function churn(mb: number): Promise<void> {
  const table = uniqueTable('hold_churn');
  await src(`CREATE TABLE "${table}" (v text)`);
  try {
    // md5 text does not compress, so the WAL is about as large as the data
    await src(
      `INSERT INTO "${table}" SELECT repeat(md5(g::text), 32) FROM generate_series(1, $1) g`,
      [mb * 1024],
    );
  } finally {
    await src(`DROP TABLE "${table}"`);
  }
}

interface Made {
  bridgeId: string;
  source: string;
  dest: string;
  input: Record<string, unknown>;
}

async function bridge(
  opts: { start?: boolean; connectionId?: string } = {},
): Promise<Made> {
  const source = uniqueTable('hold_src');
  const dest = uniqueTable('hold_dst');
  await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
  cleanups.push(() =>
    src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
  );
  cleanups.push(() =>
    dst(`DROP TABLE IF EXISTS "${dest}"`).then(() => undefined),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const input = {
    name: `it-hold-${source}`,
    source: {
      kind: 'table',
      connectionId: opts.connectionId ?? srcConn,
      table: source,
    },
    destination: {
      kind: 'database',
      targets: [
        { connectionId: dstConn, table: dest, keyColumns: ['id'], mapping: [] },
      ],
    },
    transform: {},
    trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
  };
  const created = await app.bridges.create(bridgeInputSchema.parse(input));
  cleanups.push(async () => {
    await app.cdc.stop(created.id).catch(() => undefined);
    await app.cdc.cleanup(created.id).catch(() => undefined);
  });
  if (opts.start !== false) await app.cdc.start(created.id);
  return { bridgeId: created.id, source, dest, input };
}

const job = (bridgeId: string) =>
  app.prisma.bridgeJob.findFirstOrThrow({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });

/** one delivered row, so the bridge has a saved position worth losing */
async function deliverOne(b: Made, id = 1): Promise<void> {
  await src(`INSERT INTO "${b.source}" VALUES ($1, 'row')`, [id]);
  await waitFor(`row ${id}`, async () =>
    (await dstIds(b.dest)).includes(id) ? true : null,
  );
  await waitFor('a saved position', async () =>
    (await job(b.bridgeId)).cursorJson ? true : null,
  );
}

describe('what a bridge holds on its source', () => {
  it('is nothing for a bridge that has never been started', async () => {
    const b = await bridge({ start: false });
    expect(await app.cdc.hold(b.bridgeId)).toBeNull();
  });

  it('is a live replication slot while it runs', async () => {
    const b = await bridge();
    await deliverOne(b);
    const hold = await app.cdc.hold(b.bridgeId);
    expect(hold).toMatchObject({
      engine: 'postgres',
      kind: 'replication-slot',
      name: slotOf(b.bridgeId),
      exists: true,
      status: 'ok',
      running: true,
      level: 'ok',
      message: null,
    });
    expect(hold.retainedBytes).toBeGreaterThanOrEqual(0);
  });

  it('grows while the bridge is paused, and says so', async () => {
    const b = await bridge();
    await deliverOne(b);
    await app.cdc.stop(b.bridgeId);
    const before = (await app.cdc.hold(b.bridgeId)).retainedBytes;

    await churn(4);
    const hold = await app.cdc.hold(b.bridgeId);
    // the slot is what makes the server keep all of that
    expect(hold.retainedBytes - before).toBeGreaterThan(3 * 1024 * 1024);
    expect(hold).toMatchObject({
      running: false,
      active: false,
      level: 'warn',
      status: 'ok',
    });
    expect(hold.message).toMatch(/keeping .* of WAL/);
    expect(hold.message).toMatch(/not running/);

    // catching up releases it again. Postgres moves a slot's restart position
    // lazily: it needs a running-transactions record (a checkpoint writes one)
    // to be decoded, and then another confirmation from the reader
    await app.cdc.start(b.bridgeId);
    let next = 2;
    await waitFor(
      'the hold to shrink',
      async () => {
        await src('CHECKPOINT');
        const id = next++;
        await src(`INSERT INTO "${b.source}" VALUES ($1, 'after')`, [id]);
        await waitFor(`row ${id}`, async () =>
          (await dstIds(b.dest)).includes(id) ? true : null,
        );
        return (await app.cdc.hold(b.bridgeId)).level === 'ok' ? true : null;
      },
      { timeoutMs: 60_000, intervalMs: 1_000 },
    );
  });
});

describe('the guard', () => {
  it('leaves slots alone by default, however much they hold', async () => {
    const b = await bridge();
    await deliverOne(b);
    await app.cdc.stop(b.bridgeId);
    await churn(4);
    expect(config.slotMaxBytes).toBe(0);
    await guard.check(b.bridgeId);
    expect(await slotExists(b.bridgeId)).toBe(true);
    expect(guard.lastKnown(b.bridgeId)).toMatchObject({ level: 'warn' });
  });

  it('gives up a STOPPED bridge’s slot past the limit — and the bridge says what that cost', async () => {
    const b = await bridge();
    await deliverOne(b);
    await app.cdc.stop(b.bridgeId);
    await churn(4);

    config.slotMaxBytes = 1024 * 1024;
    try {
      await guard.check(b.bridgeId);
    } finally {
      config.slotMaxBytes = 0;
    }
    expect(await slotExists(b.bridgeId)).toBe(false);
    const j = await job(b.bridgeId);
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(
      /dropped this bridge's replication slot to protect the source/,
    );
    expect(j.error).toMatch(/SYNCLE_SLOT_MAX_BYTES/);

    // written while nothing was listening
    await src(`INSERT INTO "${b.source}" VALUES (50, 'missed')`);

    // it does not quietly make a new slot and carry on
    const refusal = await app.cdc.start(b.bridgeId).then(
      () => null,
      (e: Error & { details?: unknown }) => e,
    );
    expect(refusal?.message).toMatch(/cannot resume where it stopped/);
    expect(refusal?.details).toEqual({ reason: 'position-lost' });
    expect(await slotExists(b.bridgeId)).toBe(false);

    // told to, it continues from now — and the timeline records the hole
    await app.cdc.start(b.bridgeId, { fromNow: true });
    await src(`INSERT INTO "${b.source}" VALUES (51, 'seen')`);
    await waitFor('row 51', async () =>
      (await dstIds(b.dest)).includes(51) ? true : null,
    );
    expect(await dstIds(b.dest)).toEqual([1, 51]); // 50 is the gap
    const notice = await app.prisma.bridgeDelivery.findFirst({
      where: {
        jobId: j.id,
        status: 'skipped',
        error: { contains: 'Continued from the current position' },
      },
    });
    expect(notice?.error).toMatch(/NOT captured/);
    // and that start is an ordinary one from then on
    await app.cdc.stop(b.bridgeId);
    await app.cdc.start(b.bridgeId);
  });

  it('never touches a bridge that is running: it is behind, not abandoned', async () => {
    const b = await bridge();
    await deliverOne(b);
    config.slotMaxBytes = 1; // anything at all is over it
    try {
      await guard.check(b.bridgeId);
    } finally {
      config.slotMaxBytes = 0;
    }
    expect(await slotExists(b.bridgeId)).toBe(true);
    await src(`INSERT INTO "${b.source}" VALUES (2, 'still streaming')`);
    await waitFor('row 2', async () =>
      (await dstIds(b.dest)).includes(2) ? true : null,
    );
  });
});

describe('a slot that went away behind the bridge’s back', () => {
  it('stops a start, instead of being re-created at "now"', async () => {
    const b = await bridge();
    await deliverOne(b);
    await app.cdc.stop(b.bridgeId);
    await src(`SELECT pg_drop_replication_slot($1)`, [slotOf(b.bridgeId)]);

    await expect(app.cdc.start(b.bridgeId)).rejects.toThrow(
      /does not exist on the server/,
    );
    expect(await slotExists(b.bridgeId)).toBe(false);
    expect(await app.cdc.hold(b.bridgeId)).toMatchObject({
      exists: false,
      level: 'critical',
    });
  });

  it('stops a resume at boot the same way', async () => {
    const b = await bridge();
    await deliverOne(b);
    await app.cdc.stop(b.bridgeId);
    await src(`SELECT pg_drop_replication_slot($1)`, [slotOf(b.bridgeId)]);
    // as it would be found after a crash: still marked running
    const j = await job(b.bridgeId);
    await app.prisma.bridgeJob.update({
      where: { id: j.id },
      data: { status: 'running', finishedAt: null },
    });

    await app.cdc.resumeAll(); // (what the process that leads does at boot)
    const after = await job(b.bridgeId);
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/could not resume where it stopped/);
    expect(await slotExists(b.bridgeId)).toBe(false);
    await expect(app.cdc.start(b.bridgeId)).rejects.toThrow(/cannot resume/);
  });

  it('a source that reports the position lost mid-stream stops the bridge, marked', async () => {
    const b = await bridge();
    await deliverOne(b);
    // what the MySQL and MongoDB providers call when the binlog was purged or
    // the oplog rolled over
    await (app.cdc as any).handlePositionLost(
      b.bridgeId,
      'The log was purged while the bridge was not reading it.',
    );
    const j = await waitFor('the bridge to stop', async () => {
      const found = await job(b.bridgeId);
      return found.status === 'failed' ? found : null;
    });
    expect(j.error).toMatch(/The log was purged/);
    expect(j.error).toMatch(/continue from now/);
    await expect(app.cdc.start(b.bridgeId)).rejects.toThrow(/cannot resume/);
    await app.cdc.start(b.bridgeId, { fromNow: true });
    await src(`INSERT INTO "${b.source}" VALUES (9, 'after')`);
    await waitFor('row 9', async () =>
      (await dstIds(b.dest)).includes(9) ? true : null,
    );
  });
});

describe('MySQL: the binlog was purged while the bridge was paused', () => {
  it('refuses to resume from a file that is gone, and continues from now when told to', async () => {
    const made = await makeBridge(app, {
      sourceEngine: 'mysql',
      destEngine: 'postgres_dest',
      sourceConnId: await connectionFor(app, 'mysql'),
      destConnId: dstConn,
      cleanups,
    });
    const my = (sql: string) => withAdapter('mysql', (a) => a.query(sql));
    await my(`INSERT INTO \`${made.sourceTable}\` VALUES (1, 'before')`);
    await waitFor('row 1', async () =>
      (await destRows('postgres_dest', made.destTable)).length === 1
        ? true
        : null,
    );
    await waitFor('a saved position', async () =>
      (await job(made.bridgeId)).cursorJson ? true : null,
    );
    await app.cdc.stop(made.bridgeId);

    // MySQL keeps nothing for a reader: it purges on its own schedule
    expect(await app.cdc.hold(made.bridgeId)).toMatchObject({
      kind: 'log-position',
      exists: true,
      level: 'ok',
    });
    await my('FLUSH BINARY LOGS');
    await my(`INSERT INTO \`${made.sourceTable}\` VALUES (2, 'while away')`);
    const current = (await my('SHOW BINARY LOGS')).rows.at(-1) as {
      Log_name: string;
    };
    await my(`PURGE BINARY LOGS TO '${current.Log_name}'`);

    const hold = await app.cdc.hold(made.bridgeId);
    expect(hold).toMatchObject({
      exists: false,
      status: 'lost',
      level: 'critical',
    });
    expect(hold.message).toMatch(/has been purged/);
    await expect(app.cdc.start(made.bridgeId)).rejects.toThrow(
      /cannot resume where it stopped.*purged/s,
    );

    await app.cdc.start(made.bridgeId, { fromNow: true });
    await my(`INSERT INTO \`${made.sourceTable}\` VALUES (3, 'after')`);
    await waitFor('row 3', async () => {
      const ids = (await destRows('postgres_dest', made.destTable)).map((r) =>
        Number(r.id),
      );
      return ids.includes(3) ? ids : null;
    });
    // row 2 is the gap, and the timeline says there is one
    expect(
      (await destRows('postgres_dest', made.destTable)).map((r) =>
        Number(r.id),
      ),
    ).toEqual([1, 3]);
    const j = await job(made.bridgeId);
    const notice = await app.prisma.bridgeDelivery.findFirst({
      where: {
        jobId: j.id,
        status: 'skipped',
        error: { contains: 'Continued from the current position' },
      },
    });
    expect(notice).not.toBeNull();
  });
});

describe('a bridge that stops being a CDC bridge on that source', () => {
  it('drops its slot when it is edited into a watch bridge', async () => {
    const b = await bridge();
    await deliverOne(b);
    expect(await slotExists(b.bridgeId)).toBe(true);

    const { bridgeInputSchema } = await import('@syncle/core');
    await controller.update(
      b.bridgeId,
      bridgeInputSchema.parse({
        ...b.input,
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'increment', column: 'id' },
          pollIntervalMs: 60_000,
        },
      }),
    );
    cleanups.push(async () => {
      const { BridgeWatchService } =
        await import('../../src/bridges/bridge-watch.service');
      await app.ctx
        .get(BridgeWatchService)
        .stop(b.bridgeId)
        .catch(() => undefined);
    });
    expect(await slotExists(b.bridgeId)).toBe(false);
    // the saved position belonged to the slot and went with it. (the bridge was
    // live, so it is already polling as a watch bridge and has saved a cursor
    // of that kind.) going back to CDC later is a fresh start, not a lost one
    const saved = JSON.parse(
      (await job(b.bridgeId)).cursorJson ?? '{}',
    ) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('cursor');
    expect(saved).not.toHaveProperty('lost');
  });

  it('drops it on the OLD source when the bridge moves to another connection', async () => {
    const b = await bridge();
    await deliverOne(b);
    const elsewhere = await connectionFor(app, 'postgres');
    let dropped = 0;
    const real = pgProvider.deprovision.bind(pgProvider);
    pgProvider.deprovision = async (id: string, was: any, conn: unknown) => {
      if (id === b.bridgeId && was.source.connectionId === srcConn) dropped++;
      return real(id, was, conn);
    };
    try {
      const { bridgeInputSchema } = await import('@syncle/core');
      await controller.update(
        b.bridgeId,
        bridgeInputSchema.parse({
          ...b.input,
          source: { ...(b.input.source as object), connectionId: elsewhere },
        }),
      );
    } finally {
      pgProvider.deprovision = real;
    }
    expect(dropped).toBe(1);
    // it was live, so it came back up — on the new connection, from now
    await src(`INSERT INTO "${b.source}" VALUES (2, 'via the new connection')`);
    await waitFor('row 2', async () =>
      (await dstIds(b.dest)).includes(2) ? true : null,
    );
  });
});

describe('a slot that could not be dropped', () => {
  it('is written down, blocks deleting the connection, and is retried until it is gone', async () => {
    const ownConn = await connectionFor(app, 'postgres');
    const b = await bridge({ connectionId: ownConn });
    await deliverOne(b);

    const real = pgProvider.deprovision.bind(pgProvider);
    pgProvider.deprovision = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:5432');
    };
    try {
      await controller.remove(b.bridgeId);
      // the bridge is gone; its slot is not, and this row is all that knows it
      expect(await slotExists(b.bridgeId)).toBe(true);
      const pending = await app.cdc.listCleanups();
      const mine = pending.find(
        (p: { bridgeId: string }) => p.bridgeId === b.bridgeId,
      );
      expect(mine).toMatchObject({
        connectionId: ownConn,
        engine: 'postgres',
        resource: `replication slot ${slotOf(b.bridgeId)}`,
        attempts: 1,
      });
      expect(mine.lastError).toMatch(/ECONNREFUSED/);

      // the connection is the only way left to reach that slot
      await expect(connections.remove(ownConn)).rejects.toThrow(
        /still has to remove something/,
      );

      // still unreachable: still pending, one more attempt on the record
      expect(await app.cdc.retryCleanups()).toBeGreaterThanOrEqual(1);
      const again = (await app.cdc.listCleanups()).find(
        (p: { bridgeId: string }) => p.bridgeId === b.bridgeId,
      );
      expect(again.attempts).toBe(2);
    } finally {
      pgProvider.deprovision = real;
    }

    // reachable again: the sweep finishes the job
    await guard.sweep();
    expect(await slotExists(b.bridgeId)).toBe(false);
    expect(
      (await app.cdc.listCleanups()).some(
        (p: { bridgeId: string }) => p.bridgeId === b.bridgeId,
      ),
    ).toBe(false);
    await connections.remove(ownConn);
  });
});

describe('readiness', () => {
  it('counts replication slots, and warns that nothing caps what one can pin', async () => {
    const b = await bridge({ start: false });
    const ready = await app.cdc.readiness({
      connectionId: srcConn,
      table: b.source,
    });
    expect(ready.ready).toBe(true);
    const slots = ready.checks.find(
      (c: { label: string }) => c.label === 'a free replication slot',
    );
    expect(slots).toMatchObject({ ok: true });
    expect(slots.detail).toMatch(/\d+ of 20 in use/);
    expect(
      ready.checks.find(
        (c: { label: string }) => c.label === 'a free WAL sender',
      ),
    ).toMatchObject({ ok: true });
    // the test server runs with the default, unlimited
    expect(ready.advisories?.join(' ')).toMatch(/max_slot_wal_keep_size = -1/);
  });

  it('is not ready when every slot is taken — except for a bridge that already has one', async () => {
    const owner = await bridge();
    const newcomer = await bridge({ start: false });
    const used = Number(
      (await src(`SELECT count(*)::int AS n FROM pg_replication_slots`))
        .rows[0]!.n,
    );
    const max = Number(
      (await src(`SELECT current_setting('max_replication_slots')::int AS n`))
        .rows[0]!.n,
    );
    try {
      await src(
        `SELECT pg_create_physical_replication_slot('it_fill_' || g) FROM generate_series(1, $1) g`,
        [max - used],
      );
      const full = await app.cdc.readiness({
        connectionId: srcConn,
        table: newcomer.source,
      });
      expect(full.ready).toBe(false);
      expect(
        full.checks.find(
          (c: { label: string }) => c.label === 'a free replication slot',
        ),
      ).toMatchObject({
        ok: false,
      });
      expect(full.instructions.join(' ')).toMatch(
        /Every replication slot on this server is taken/,
      );
      await expect(app.cdc.start(newcomer.bridgeId)).rejects.toThrow(
        /Every replication slot/,
      );

      const mine = await app.cdc.readiness({
        connectionId: srcConn,
        table: owner.source,
        bridgeId: owner.bridgeId,
      });
      expect(mine.ready).toBe(true);
    } finally {
      await src(
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'it_fill_%'`,
      );
    }
  });
});
