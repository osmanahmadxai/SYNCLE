/**
 * What happens to rows a live bridge cannot deliver — against real PostgreSQL,
 * through the real application.
 *
 * The invariant every test here defends: a change read from the source is, at
 * all times, either in the destination, in the dead-letter queue, or still
 * behind the bridge's cursor (so it will be read again). Never none of the
 * three. Before this suite existed, `onError: continue` broke it on every
 * failed batch, and `abort` broke it whenever more changes were already queued
 * behind the one that failed.
 *
 * The destination is made to reject rows with a CHECK constraint, which is what
 * a real poison row looks like: the write is well-formed, the target says no.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter, sleep } from './harness';

// small batches, so a few hundred rows span many of them. must be set before
// the app module is evaluated (runtimeConfig reads the environment at import)
const ENV_BEFORE = {
  batch: process.env.SYNCLE_CDC_BATCH_SIZE,
  failures: process.env.SYNCLE_MAX_CONSECUTIVE_FAILURES,
};
process.env.SYNCLE_CDC_BATCH_SIZE = '10';
process.env.SYNCLE_MAX_CONSECUTIVE_FAILURES = '3';

import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

const POISON = 'POISON';

let app: AppHandle;
let deadLetters: any;
let watch: any;
let srcConn: string;
let dstConn: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { DeadLetterService } =
    await import('../../src/bridges/dead-letter.service');
  deadLetters = app.ctx.get(DeadLetterService);
  const { BridgeWatchService } =
    await import('../../src/bridges/bridge-watch.service');
  watch = app.ctx.get(BridgeWatchService);
  srcConn = await connectionFor(app, 'postgres');
  dstConn = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  // vitest shares one process across files: leave the environment as found
  for (const [key, value] of [
    ['SYNCLE_CDC_BATCH_SIZE', ENV_BEFORE.batch],
    ['SYNCLE_MAX_CONSECUTIVE_FAILURES', ENV_BEFORE.failures],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Setup {
  bridgeId: string;
  src: string;
  dst: string;
}

/**
 * a Postgres→Postgres CDC bridge whose destination table already exists and
 * refuses `rejects` — by default any row named POISON
 */
async function makeBridge(opts: {
  onError?: 'continue' | 'abort';
  rejects?: string;
  filters?: Array<{ column: string; operator: string; value?: unknown }>;
}): Promise<Setup> {
  const src = uniqueTable('dl_src');
  const dst = uniqueTable('dl_dst');
  const check = opts.rejects ?? `name <> '${POISON}'`;

  await withAdapter('postgres', (a) =>
    a.query(`CREATE TABLE "${src}" (id integer PRIMARY KEY, name text)`),
  );
  await withAdapter('postgres_dest', (a) =>
    a.query(
      `CREATE TABLE "${dst}" (id integer PRIMARY KEY, name text, CONSTRAINT "${dst}_ok" CHECK (${check}))`,
    ),
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(src)).then(() => undefined),
  );
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dst)).then(() => undefined),
  );

  const { bridgeInputSchema } = await import('@syncle/core');
  const input = bridgeInputSchema.parse({
    name: `it-dead-letters-${src}`,
    source: {
      kind: 'table',
      connectionId: srcConn,
      table: src,
      filters: opts.filters,
    },
    destination: {
      kind: 'database',
      targets: [
        {
          connectionId: dstConn,
          table: dst,
          writeMode: 'upsert',
          keyColumns: ['id'],
        },
      ],
    },
    transform: { template: '{{$row}}' },
    // omitted on purpose when the test is about the default
    ...(opts.onError ? { delivery: { onError: opts.onError } } : {}),
    trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
  });
  const bridge = await app.bridges.create(input);
  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });
  await app.cdc.start(bridge.id);
  return { bridgeId: bridge.id, src, dst };
}

const insertMany = (
  table: string,
  rows: Array<{ id: number; name: string }>,
): Promise<void> =>
  withAdapter('postgres', async (a) => {
    // ONE statement = one source transaction, so the rows hit the stream
    // back-to-back and genuinely queue up behind each other
    await a.insertRows!({ table, rows });
  });

const allowEverything = (dst: string): Promise<void> =>
  withAdapter('postgres_dest', async (a) => {
    await a.query(`ALTER TABLE "${dst}" DROP CONSTRAINT "${dst}_ok"`);
  });

const job = (bridgeId: string) =>
  app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });

const ids = (rows: Array<Record<string, unknown>>): number[] =>
  rows.map((r) => Number(r.id)).sort((a, b) => a - b);

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('the default', () => {
  it('is to stop, not to step over a failure', async () => {
    const { bridgeInputSchema } = await import('@syncle/core');
    const parsed = bridgeInputSchema.parse({
      name: 'defaults',
      source: { kind: 'table', connectionId: 'x', table: 't' },
      destination: {
        kind: 'database',
        targets: [{ connectionId: 'y', table: 't' }],
      },
      transform: {},
    });
    expect(parsed.delivery.onError).toBe('abort');
  });
});

describe('onError: continue', () => {
  let s: Setup;

  beforeAll(async () => {
    s = await makeBridge({ onError: 'continue' });
  }, 120_000);

  it('sets the one bad row aside, delivers the rest of its batch, and keeps streaming', async () => {
    const rows = range(1, 50).map((id) => ({
      id,
      name: id === 23 ? POISON : `row-${id}`,
    }));
    await insertMany(s.src, rows);

    const landed = await waitFor('49 healthy rows', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 49 ? r : null;
    });
    expect(ids(landed)).toEqual(range(1, 50).filter((id) => id !== 23));

    const page = await waitFor('the bad row to be parked', async () => {
      const p = await deadLetters.page(s.bridgeId, { status: 'pending' });
      return p.pendingEntries === 1 ? p : null;
    });
    // the WHOLE row, not a capped preview, and only the row at fault
    expect(page.pendingRows).toBe(1);
    expect(page.items[0]).toMatchObject({
      op: 'insert',
      rowCount: 1,
      attempts: 0,
    });
    expect(page.items[0].rows).toEqual([{ id: 23, name: POISON }]);
    expect(page.items[0].error).toMatch(/check constraint/i);

    // the bridge did not stop, and its counters say what happened
    const j = await job(s.bridgeId);
    expect(j.status).toBe('running');
    expect(j.sentCount).toBe(49);
    expect(j.failedCount).toBe(1);

    // ...and it is still delivering
    await insertMany(
      s.src,
      range(51, 55).map((id) => ({ id, name: `row-${id}` })),
    );
    await waitFor('rows after the failure', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 54 ? r : null;
    });
  });

  it('a retry that still fails keeps the row, and says why', async () => {
    const res = await deadLetters.retry(s.bridgeId, { force: false });
    expect(res).toEqual({ resolved: 0, stillFailing: 1, needsForce: 0 });
    const page = await deadLetters.page(s.bridgeId, { status: 'pending' });
    expect(page.items[0]).toMatchObject({ attempts: 1 });
    expect(page.items[0].error).toMatch(/check constraint/i);
  });

  it('delivers the row once the cause is fixed, and turns the delivery green', async () => {
    await allowEverything(s.dst);
    const res = await deadLetters.retry(s.bridgeId, { force: false });
    expect(res).toEqual({ resolved: 1, stillFailing: 0, needsForce: 0 });

    const rows = await destRows('postgres_dest', s.dst);
    expect(rows.find((r) => Number(r.id) === 23)).toMatchObject({
      name: POISON,
    });
    expect(rows).toHaveLength(55);

    expect((await deadLetters.page(s.bridgeId)).pendingEntries).toBe(0);
    const j = await job(s.bridgeId);
    expect(j.failedCount).toBe(0);
    expect(j.sentCount).toBe(55);
  });
});

describe('retrying while the bridge is live', () => {
  it('writes what the source says NOW, never the outdated recording', async () => {
    const s = await makeBridge({ onError: 'continue' });

    await insertMany(s.src, [{ id: 1, name: POISON }]);
    await waitFor('the row to be parked', async () =>
      (await deadLetters.pendingRows(s.bridgeId)) === 1 ? true : null,
    );

    // the source moves on, and the stream delivers the newer version
    await withAdapter('postgres', (a) =>
      a.updateRow({
        table: s.src,
        identity: { id: 1 },
        changes: { name: 'newer' },
      }),
    );
    await waitFor('the newer version', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r[0]?.name === 'newer' ? true : null;
    });

    // with the constraint gone NOTHING but the retry logic stands between the
    // recorded 'POISON' and the newer row already in the destination
    await allowEverything(s.dst);
    const res = await deadLetters.retry(s.bridgeId, { force: false });
    expect(res.resolved).toBe(1);

    const rows = await destRows('postgres_dest', s.dst);
    expect(rows).toEqual([expect.objectContaining({ id: 1, name: 'newer' })]);
  });

  it('removes a row that was deleted at the source in the meantime', async () => {
    const s = await makeBridge({ onError: 'continue' });

    await insertMany(s.src, [
      { id: 1, name: 'keep' },
      { id: 2, name: POISON },
    ]);
    await waitFor('row 1 delivered, row 2 parked', async () => {
      const landed = await destRows('postgres_dest', s.dst);
      const parked = await deadLetters.pendingRows(s.bridgeId);
      return landed.length === 1 && parked === 1 ? true : null;
    });

    await withAdapter('postgres', (a) =>
      a.deleteRow({ table: s.src, identity: { id: 2 } }),
    );
    await sleep(500); // let the delete reach the destination (a no-op there)
    await allowEverything(s.dst);

    const res = await deadLetters.retry(s.bridgeId, { force: false });
    expect(res.resolved).toBe(1);
    // writing the recording here would resurrect a row the source deleted
    expect(ids(await destRows('postgres_dest', s.dst))).toEqual([1]);
  });
});

describe('onError: abort', () => {
  it('stops AT the failure: batches already queued behind it are not delivered past it', async () => {
    const s = await makeBridge({}); // the default
    // 200 rows = 20 batches in flight behind each other; the first one is bad
    await insertMany(
      s.src,
      range(1, 200).map((id) => ({
        id,
        name: id === 3 ? POISON : `row-${id}`,
      })),
    );

    const paused = await waitFor('the bridge to pause', async () => {
      const j = await job(s.bridgeId);
      return j.status === 'paused' ? j : null;
    });
    expect(paused.error).toMatch(/onError=abort/);
    expect(paused.error).toMatch(/check constraint/i);

    // give any batch that slipped through time to show up, then check none did.
    // delivering rows 11..200 and checkpointing past 1..10 is the data loss
    await sleep(1_500);
    expect(await destRows('postgres_dest', s.dst)).toEqual([]);
    expect(await deadLetters.pendingRows(s.bridgeId)).toBe(0);

    // fix the cause, start again: every row arrives, exactly once
    await allowEverything(s.dst);
    await app.cdc.start(s.bridgeId);
    const rows = await waitFor('all 200 rows', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 200 ? r : null;
    });
    expect(ids(rows)).toEqual(range(1, 200));
    const j = await job(s.bridgeId);
    expect(j.status).toBe('running');
    expect(j.failedCount).toBe(0); // the failed cell was retried in place
  });

  it('a filtered-out change cannot carry the cursor past a batch that then fails', async () => {
    const s = await makeBridge({
      filters: [{ column: 'name', operator: 'neq', value: 'skipme' }],
    });
    // a bad batch, immediately followed by changes the bridge filters out. their
    // positions used to be checkpointed straight away — past the failing batch
    await insertMany(s.src, [
      ...range(1, 10).map((id) => ({
        id,
        name: id === 5 ? POISON : `row-${id}`,
      })),
      ...range(11, 60).map((id) => ({ id, name: 'skipme' })),
    ]);

    await waitFor('the bridge to pause', async () =>
      (await job(s.bridgeId)).status === 'paused' ? true : null,
    );
    await sleep(1_000);

    await allowEverything(s.dst);
    await app.cdc.start(s.bridgeId);
    const rows = await waitFor('the 10 real rows', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 10 ? r : null;
    });
    expect(ids(rows)).toEqual(range(1, 10));
    await sleep(1_000);
    expect(await destRows('postgres_dest', s.dst)).toHaveLength(10); // nothing filtered got in
  });
});

describe('a destination that rejects everything', () => {
  it('stops a `continue` bridge instead of pouring the stream into the queue, and loses nothing', async () => {
    const s = await makeBridge({ onError: 'continue', rejects: 'id < 0' });
    await insertMany(
      s.src,
      range(1, 300).map((id) => ({ id, name: `row-${id}` })),
    );

    const paused = await waitFor(
      'the bridge to give up',
      async () => {
        const j = await job(s.bridgeId);
        return j.status === 'paused' ? j : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(paused.error).toMatch(/Stopped without advancing/);
    // bounded: a handful of small batches at most, never the whole stream
    const parked = await deadLetters.pendingRows(s.bridgeId);
    expect(parked).toBeLessThanOrEqual(30);
    expect(await destRows('postgres_dest', s.dst)).toEqual([]);

    // repair, restart, retry what was parked: all 300, each exactly once
    await allowEverything(s.dst);
    await app.cdc.start(s.bridgeId);
    await deadLetters.retry(s.bridgeId, { force: false });
    const rows = await waitFor(
      'all 300 rows',
      async () => {
        const r = await destRows('postgres_dest', s.dst);
        return r.length === 300 ? r : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(ids(rows)).toEqual(range(1, 300));
    expect(await deadLetters.pendingRows(s.bridgeId)).toBe(0);
  });
});

describe('a polling (watch) bridge', () => {
  /** Postgres→Postgres, polling on the auto-increasing id, from the start of the table */
  async function makeWatchBridge(
    onError?: 'continue' | 'abort',
  ): Promise<Setup> {
    const src = uniqueTable('dl_wsrc');
    const dst = uniqueTable('dl_wdst');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${src}" (id integer PRIMARY KEY, name text)`),
    );
    await withAdapter('postgres_dest', (a) =>
      a.query(
        `CREATE TABLE "${dst}" (id integer PRIMARY KEY, name text, CONSTRAINT "${dst}_ok" CHECK (name <> '${POISON}'))`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(src)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dst)).then(
        () => undefined,
      ),
    );

    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-dead-letters-watch-${src}`,
        source: { kind: 'table', connectionId: srcConn, table: src },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: dstConn,
              table: dst,
              writeMode: 'upsert',
              keyColumns: ['id'],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        ...(onError ? { delivery: { onError } } : {}),
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'increment', column: 'id' },
          pollIntervalMs: 1000,
          startFrom: 'beginning',
        },
      }),
    );
    cleanups.push(async () => {
      await watch.stop(bridge.id).catch(() => undefined);
    });
    await watch.start(bridge.id);
    return { bridgeId: bridge.id, src, dst };
  }

  it('continue: a polling cursor never comes back for a row, so the row is parked first', async () => {
    const s = await makeWatchBridge('continue');
    await insertMany(
      s.src,
      range(1, 12).map((id) => ({ id, name: id === 4 ? POISON : `row-${id}` })),
    );

    const landed = await waitFor('the 11 healthy rows', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 11 ? r : null;
    });
    expect(ids(landed)).toEqual(range(1, 12).filter((id) => id !== 4));

    const page = await waitFor('row 4 to be parked', async () => {
      const p = await deadLetters.page(s.bridgeId, { status: 'pending' });
      return p.pendingEntries === 1 ? p : null;
    });
    expect(page.items[0]).toMatchObject({ op: null, rowCount: 1 });
    expect(page.items[0].rows).toEqual([{ id: 4, name: POISON }]);
    expect((await job(s.bridgeId)).status).toBe('running');

    // the cursor is past id 4 for good; only the queue can still deliver it
    await allowEverything(s.dst);
    expect(await deadLetters.retry(s.bridgeId, { force: false })).toMatchObject(
      { resolved: 1 },
    );
    expect(ids(await destRows('postgres_dest', s.dst))).toEqual(range(1, 12));
    expect((await job(s.bridgeId)).failedCount).toBe(0);
  });

  it('abort: stops at the row, and retries it into the same delivery on restart', async () => {
    const s = await makeWatchBridge(); // the default
    await insertMany(
      s.src,
      range(1, 12).map((id) => ({ id, name: id === 4 ? POISON : `row-${id}` })),
    );

    const paused = await waitFor('the bridge to pause', async () => {
      const j = await job(s.bridgeId);
      return j.status === 'paused' ? j : null;
    });
    expect(paused.error).toMatch(/onError=abort/);
    expect(ids(await destRows('postgres_dest', s.dst))).toEqual([1, 2, 3]);
    expect(await deadLetters.pendingRows(s.bridgeId)).toBe(0);

    await allowEverything(s.dst);
    await watch.start(s.bridgeId);
    const rows = await waitFor('all 12 rows', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 12 ? r : null;
    });
    expect(ids(rows)).toEqual(range(1, 12));
    // the red cell was reused, not stranded beside a fresh green one
    const j = await job(s.bridgeId);
    expect(j.failedCount).toBe(0);
  });

  it('continue: a destination that rejects every row stops the bridge', async () => {
    const s = await makeWatchBridge('continue');
    await withAdapter('postgres_dest', (a) =>
      a.query(
        `ALTER TABLE "${s.dst}" ADD CONSTRAINT "${s.dst}_none" CHECK (id < 0)`,
      ),
    );
    await insertMany(
      s.src,
      range(1, 40).map((id) => ({ id, name: `row-${id}` })),
    );

    const paused = await waitFor('the bridge to give up', async () => {
      const j = await job(s.bridgeId);
      return j.status === 'paused' ? j : null;
    });
    expect(paused.error).toMatch(/Stopped without advancing/);
    // SYNCLE_MAX_CONSECUTIVE_FAILURES=3: two parked, the third stopped it
    expect(await deadLetters.pendingRows(s.bridgeId)).toBe(2);

    // repair, restart, retry: all 40 rows, none lost
    await withAdapter('postgres_dest', (a) =>
      a.query(`ALTER TABLE "${s.dst}" DROP CONSTRAINT "${s.dst}_none"`),
    );
    await watch.start(s.bridgeId);
    await deadLetters.retry(s.bridgeId, { force: false });
    const rows = await waitFor('all 40 rows', async () => {
      const r = await destRows('postgres_dest', s.dst);
      return r.length === 40 ? r : null;
    });
    expect(ids(rows)).toEqual(range(1, 40));
  });
});

describe('the API surface', () => {
  it('discarded rows are never retried, and their delivery stays failed', async () => {
    const s = await makeBridge({ onError: 'continue' });
    await insertMany(s.src, [{ id: 1, name: POISON }]);
    await waitFor('the row to be parked', async () =>
      (await deadLetters.pendingRows(s.bridgeId)) === 1 ? true : null,
    );

    expect(await deadLetters.discard(s.bridgeId, {})).toEqual({ discarded: 1 });
    await allowEverything(s.dst);
    expect(await deadLetters.retry(s.bridgeId, { force: false })).toEqual({
      resolved: 0,
      stillFailing: 0,
      needsForce: 0,
    });
    expect(await destRows('postgres_dest', s.dst)).toEqual([]);
    expect((await job(s.bridgeId)).failedCount).toBe(1); // it never arrived: say so

    const all = await deadLetters.page(s.bridgeId);
    expect(all.items.map((i: { status: string }) => i.status)).toEqual([
      'discarded',
    ]);
  });

  it('dead letters disappear with their bridge', async () => {
    const s = await makeBridge({ onError: 'continue' });
    await insertMany(s.src, [{ id: 1, name: POISON }]);
    await waitFor('the row to be parked', async () =>
      (await deadLetters.pendingRows(s.bridgeId)) === 1 ? true : null,
    );
    await app.cdc.stop(s.bridgeId);
    await app.cdc.cleanup(s.bridgeId);
    await app.bridges.remove(s.bridgeId);
    expect(
      await app.prisma.bridgeDeadLetter.count({
        where: { bridgeId: s.bridgeId },
      }),
    ).toBe(0);
  });
});
