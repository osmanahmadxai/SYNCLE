/**
 * verify and reconcile, against real databases: a destination that has drifted
 * in every way it can (a row gone, a row edited, a row that should not be
 * there) is found out, repaired row by row — and one that has NOT drifted is
 * never said to have, across engines and the value types drivers disagree on.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeVerification } from '@syncle/core';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
let controller: any;
let jobs: any;
const conns: Partial<Record<ConnKey, string>> = {};
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  controller = app.ctx.get(BridgesController);
  jobs = app.ctx.get(BridgeJobService);
  for (const key of [
    'postgres',
    'postgres_dest',
    'mysql',
    'mysql_dest',
    'mongodb',
  ] as const)
    conns[key] = await connectionFor(app, key);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const pg = (sql: string) => withAdapter('postgres', (a) => a.query(sql));
const pgDest = (sql: string) =>
  withAdapter('postgres_dest', (a) => a.query(sql));

async function bridgeOf(input: Record<string, unknown>): Promise<string> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await controller.create(
    bridgeInputSchema.parse({
      transform: { template: '{{$row}}' },
      trigger: { kind: 'replay' },
      ...input,
    }),
  );
  cleanups.push(() => controller.remove(bridge.id).then(() => undefined));
  return bridge.id as string;
}

async function replay(bridgeId: string): Promise<void> {
  const job = await jobs.start(bridgeId, { fresh: true });
  const done = await waitFor('the replay', async () => {
    const j = await app.prisma.bridgeJob.findUnique({ where: { id: job.id } });
    return j && ['completed', 'failed'].includes(j.status) ? j : null;
  });
  expect(done).toMatchObject({ status: 'completed', failedCount: 0 });
}

async function verify(
  bridgeId: string,
  dto: { mode?: 'verify' | 'reconcile'; deleteExtra?: boolean } = {},
): Promise<BridgeVerification> {
  const { verifyStartSchema } = await import('@syncle/core');
  const started = await controller.startVerification(
    bridgeId,
    verifyStartSchema.parse(dto),
  );
  return waitFor(
    'the verification',
    async () => {
      const v: BridgeVerification = await controller.verification(
        bridgeId,
        started.id,
      );
      return ['completed', 'failed', 'canceled'].includes(v.status) ? v : null;
    },
    { timeoutMs: 60_000 },
  );
}

/** users(id, email, name) → a copy in the destination database, replayed */
async function copyOfUsers(
  rows: number,
  over: {
    target?: Record<string, unknown>;
    delivery?: Record<string, unknown>;
    transform?: Record<string, unknown>;
  } = {},
) {
  const source = uniqueTable('vr_src');
  const dest = uniqueTable('vr_dst');
  await pg(
    `CREATE TABLE "${source}" (id integer PRIMARY KEY, email text, name text); INSERT INTO "${source}" SELECT g, 'u' || g || '@example.com', 'n' || g FROM generate_series(1, ${rows}) g`,
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
  );
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  const id = await bridgeOf({
    name: `it-vr-${source}`,
    source: { kind: 'table', connectionId: conns.postgres, table: source },
    destination: {
      kind: 'database',
      targets: [
        {
          connectionId: conns.postgres_dest,
          table: dest,
          keyColumns: ['id'],
          createMissingTable: true,
          ...(over.target ?? {}),
        },
      ],
    },
    ...(over.delivery ? { delivery: over.delivery } : {}),
    ...(over.transform ? { transform: over.transform } : {}),
  });
  await replay(id);
  return { id, source, dest };
}

describe('a copy that has drifted', () => {
  it('in sync: says so, having looked at every row from both ends', async () => {
    const b = await copyOfUsers(450); // more than two pages
    const v = await verify(b.id);
    expect(v).toMatchObject({
      status: 'completed',
      mode: 'verify',
      inSync: true,
      sourceRows: 450,
      error: null,
    });
    // the total is for a progress bar, and best-effort: PostgreSQL has only its planner's estimate, and none for a table it has not analysed
    expect(v.sourceTotal === null || typeof v.sourceTotal === 'number').toBe(
      true,
    );
    expect(v.targets).toHaveLength(1);
    expect(v.targets[0]).toMatchObject({
      unsupported: null,
      checked: 450,
      missing: 0,
      different: 0,
      extra: 0,
      fixed: 0,
      removed: 0,
    });
  });

  it('a row gone, a row edited, a row that should not be there — on different pages: all three found, none touched', async () => {
    const b = await copyOfUsers(450);
    await pgDest(`DELETE FROM "${b.dest}" WHERE id IN (7, 301)`);
    await pgDest(
      `UPDATE "${b.dest}" SET email = 'changed-by-hand@example.com' WHERE id = 250`,
    );
    await pgDest(`UPDATE "${b.dest}" SET name = NULL WHERE id = 449`);
    await pgDest(
      `INSERT INTO "${b.dest}" (id, email, name) VALUES (9001, 'ghost@example.com', 'ghost')`,
    );

    const v = await verify(b.id);
    expect(v).toMatchObject({ status: 'completed', inSync: false });
    const t = v.targets[0]!;
    expect(t).toMatchObject({
      checked: 450,
      missing: 2,
      different: 2,
      extra: 1,
      fixed: 0,
      removed: 0,
    });
    expect(
      t.samples.missing.map((k) => Number(k[0])).sort((x, y) => x - y),
    ).toEqual([7, 301]);
    expect(t.samples.extra.map((k) => Number(k[0]))).toEqual([9001]);
    const different = Object.fromEntries(
      t.samples.different.map((d) => [Number(d.key[0]), d.columns]),
    );
    expect(different[250]).toEqual([
      {
        column: 'email',
        expected: 'u250@example.com',
        actual: 'changed-by-hand@example.com',
      },
    ]);
    expect(different[449]).toEqual([
      { column: 'name', expected: 'n449', actual: null },
    ]);
    // looking changes nothing
    expect(await destRows('postgres_dest', b.dest)).toHaveLength(449);
  });

  it('reconcile writes what is missing or different, and leaves the extra row unless told otherwise', async () => {
    const b = await copyOfUsers(450);
    await pgDest(`DELETE FROM "${b.dest}" WHERE id IN (7, 301)`);
    await pgDest(
      `UPDATE "${b.dest}" SET email = 'changed-by-hand@example.com' WHERE id = 250`,
    );
    await pgDest(
      `INSERT INTO "${b.dest}" (id, email, name) VALUES (9001, 'ghost@example.com', 'ghost')`,
    );
    // a row nobody should touch: same at both ends, with a column the bridge does not own
    await pgDest(
      `ALTER TABLE "${b.dest}" ADD COLUMN note text; UPDATE "${b.dest}" SET note = 'kept' WHERE id = 100`,
    );

    const first = await verify(b.id, { mode: 'reconcile' });
    expect(first.targets[0]).toMatchObject({
      missing: 2,
      different: 1,
      extra: 1,
      fixed: 3,
      removed: 0,
    });
    expect(first.inSync).toBe(false); // the ghost is still there
    const rows = Object.fromEntries(
      (await destRows('postgres_dest', b.dest)).map((r) => [Number(r.id), r]),
    );
    expect(rows[7]).toMatchObject({ email: 'u7@example.com', name: 'n7' });
    expect(rows[301]).toMatchObject({ email: 'u301@example.com' });
    expect(rows[250]).toMatchObject({ email: 'u250@example.com' });
    expect(rows[9001]).toMatchObject({ name: 'ghost' });
    expect(rows[100]).toMatchObject({ note: 'kept' });

    const second = await verify(b.id, { mode: 'reconcile', deleteExtra: true });
    expect(second.targets[0]).toMatchObject({
      missing: 0,
      different: 0,
      extra: 1,
      fixed: 0,
      removed: 1,
    });
    expect(second.inSync).toBe(true);
    expect(
      (await destRows('postgres_dest', b.dest)).some(
        (r) => Number(r.id) === 9001,
      ),
    ).toBe(false);

    expect(await verify(b.id)).toMatchObject({ inSync: true });
    // deleteExtra means nothing to a verify: it is a looking mode
    expect((await verify(b.id, { deleteExtra: true })).deleteExtra).toBe(false);
    // the last ten are kept, newest first
    const history = await controller.verifications(b.id);
    expect(history.map((h: BridgeVerification) => h.mode)).toEqual([
      'verify',
      'verify',
      'reconcile',
      'reconcile',
    ]);
  });
});

describe('keys', () => {
  it('a TEXT key is never read as a number: 007 and 7 are two rows, and stay two', async () => {
    const source = uniqueTable('vr_src');
    const dest = uniqueTable('vr_dst');
    await pg(
      `CREATE TABLE "${source}" (code text PRIMARY KEY, label text); INSERT INTO "${source}" VALUES ('007', 'bond'), ('7', 'seven'), ('7.0', 'seven point oh')`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridgeOf({
      name: `it-vr-${source}`,
      source: { kind: 'table', connectionId: conns.postgres, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: conns.postgres_dest,
            table: dest,
            keyColumns: ['code'],
            createMissingTable: true,
          },
        ],
      },
    });
    await replay(id);
    expect(await verify(id)).toMatchObject({ inSync: true });
    await pgDest(`DELETE FROM "${dest}" WHERE code = '7'`);
    const v = await verify(id);
    expect(v.targets[0]).toMatchObject({ missing: 1, different: 0, extra: 0 });
    expect(v.targets[0]!.samples.missing).toEqual([['7']]);
  });

  it('a composite key, renamed on the way', async () => {
    const source = uniqueTable('vr_src');
    const dest = uniqueTable('vr_dst');
    await pg(
      `CREATE TABLE "${source}" (tenant integer, sku text, qty integer, PRIMARY KEY (tenant, sku)); INSERT INTO "${source}" SELECT t, 'sku-' || s, t * s FROM generate_series(1, 3) t, generate_series(1, 4) s`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridgeOf({
      name: `it-vr-${source}`,
      source: { kind: 'table', connectionId: conns.postgres, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: conns.postgres_dest,
            table: dest,
            keyColumns: ['tenant_id', 'sku'],
            mapping: [
              { source: 'tenant', target: 'tenant_id' },
              { source: 'sku', target: 'sku' },
              { source: 'qty', target: 'quantity' },
            ],
            createMissingTable: true,
          },
        ],
      },
    });
    await replay(id);
    expect((await verify(id)).targets[0]).toMatchObject({
      checked: 12,
      missing: 0,
      different: 0,
      extra: 0,
    });

    // (2, sku-1) and (1, sku-2) share their parts with rows that stay: only the exact pairs are gone
    await pgDest(
      `DELETE FROM "${dest}" WHERE (tenant_id, sku) IN ((2, 'sku-1'), (1, 'sku-2')); UPDATE "${dest}" SET quantity = 99 WHERE tenant_id = 3 AND sku = 'sku-3'; INSERT INTO "${dest}" VALUES (9, 'sku-1', 1)`,
    );
    const v = await verify(id, { mode: 'reconcile', deleteExtra: true });
    expect(v.targets[0]).toMatchObject({
      missing: 2,
      different: 1,
      extra: 1,
      fixed: 3,
      removed: 1,
    });
    expect(v.targets[0]!.samples.different[0]).toEqual({
      key: [3, 'sku-3'],
      columns: [{ column: 'quantity', expected: 9, actual: 99 }],
    });
    expect(await verify(id)).toMatchObject({ inSync: true });
  });
});

describe('what the bridge does to a row on the way is what is compared', () => {
  it('a masked column, a computed one — and the time of delivery is left out, and said to be', async () => {
    const b = await copyOfUsers(30, {
      transform: {
        template: '{{$row}}',
        columns: [
          { kind: 'mask', column: 'email', mode: 'hash' },
          { kind: 'set', column: 'label', template: '{{name}} <{{id}}>' },
          { kind: 'set', column: 'loaded_at', template: '{{$now}}' },
        ],
      },
    });
    const v = await verify(b.id);
    expect(v).toMatchObject({ inSync: true });
    expect(v.targets[0]).toMatchObject({ checked: 30, different: 0 });
    expect(v.targets[0]!.notes.join(' ')).toMatch(
      /Not compared, because the value is the time of delivery: loaded_at/,
    );

    // the mask is compared as the mask: a plain address in the destination IS a difference
    await pgDest(
      `UPDATE "${b.dest}" SET email = 'u3@example.com' WHERE id = 3; UPDATE "${b.dest}" SET label = 'wrong' WHERE id = 4`,
    );
    const drifted = await verify(b.id, { mode: 'reconcile' });
    expect(drifted.targets[0]).toMatchObject({ different: 2, fixed: 2 });
    const rows = Object.fromEntries(
      (await destRows('postgres_dest', b.dest)).map((r) => [Number(r.id), r]),
    );
    expect(rows[3]!.email).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[4]!.label).toBe('n4 <4>');
  });

  it('only the rows the bridge sends: a filtered-out row is not missing, and one that stopped matching is extra', async () => {
    const source = uniqueTable('vr_src');
    const dest = uniqueTable('vr_dst');
    await pg(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, active boolean, name text); INSERT INTO "${source}" SELECT g, g % 2 = 0, 'n' || g FROM generate_series(1, 10) g`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridgeOf({
      name: `it-vr-${source}`,
      source: {
        kind: 'table',
        connectionId: conns.postgres,
        table: source,
        filters: [{ column: 'active', operator: 'eq', value: true }],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: conns.postgres_dest,
            table: dest,
            keyColumns: ['id'],
            createMissingTable: true,
          },
        ],
      },
    });
    await replay(id);
    expect((await verify(id)).targets[0]).toMatchObject({
      checked: 5,
      missing: 0,
      extra: 0,
    });
    await pg(`UPDATE "${source}" SET active = false WHERE id = 4`);
    const v = await verify(id);
    expect(v.targets[0]).toMatchObject({
      checked: 4,
      missing: 0,
      different: 0,
      extra: 1,
    });
    expect(v.targets[0]!.samples.extra).toEqual([[4]]);
  });
});

describe('what a delete does to the target decides what "extra" means', () => {
  it('soft: a marked row is where it should be; a row marked though it exists is different, and is unmarked', async () => {
    const b = await copyOfUsers(6, {
      target: {
        onDelete: 'soft',
        softDelete: { column: 'deleted_at', value: 'timestamp' },
      },
    });
    // 5 was deleted at the source and marked, as the bridge would have; 6 is marked though it is still there
    await pg(`DELETE FROM "${b.source}" WHERE id = 5`);
    await pgDest(
      `UPDATE "${b.dest}" SET deleted_at = now() WHERE id IN (5, 6)`,
    );
    // 99 is simply there, unmarked, and nowhere in the source
    await pgDest(
      `INSERT INTO "${b.dest}" (id, email, name) VALUES (99, 'x', 'x')`,
    );

    const v = await verify(b.id);
    expect(v.targets[0]).toMatchObject({
      checked: 5,
      missing: 0,
      different: 1,
      extra: 1,
    });
    expect(v.targets[0]!.samples.different[0]!.key).toEqual([6]);
    expect(v.targets[0]!.samples.extra).toEqual([[99]]);

    const fixed = await verify(b.id, { mode: 'reconcile', deleteExtra: true });
    expect(fixed.targets[0]).toMatchObject({ fixed: 1, removed: 1 });
    const rows = Object.fromEntries(
      (await destRows('postgres_dest', b.dest)).map((r) => [Number(r.id), r]),
    );
    expect(rows[6]!.deleted_at).toBeNull();
    // "removed", for this target, is MARKED: the row stays
    expect(rows[99]!.deleted_at).not.toBeNull();
    expect(await verify(b.id)).toMatchObject({ inSync: true });
  });

  it('ignore: rows that are only in the destination are what this target is for — not looked for, and said so', async () => {
    const b = await copyOfUsers(4, { target: { onDelete: 'ignore' } });
    await pg(`DELETE FROM "${b.source}" WHERE id = 2`);
    const v = await verify(b.id, { mode: 'reconcile', deleteExtra: true });
    expect(v.targets[0]).toMatchObject({ checked: 3, extra: null, removed: 0 });
    expect(v.targets[0]!.notes.join(' ')).toMatch(
      /keeps rows that were deleted at the source/,
    );
    expect(v.inSync).toBe(true);
    expect(await destRows('postgres_dest', b.dest)).toHaveLength(4);
  });
});

describe('a bridge that is delivering is a moving target', () => {
  it('a change that is only in flight is not a difference; a row edited by hand is, and is repaired while the bridge runs', async () => {
    const { runtimeConfig } = await import('../../src/common/runtime-config');
    const { BridgeWatchService } =
      await import('../../src/bridges/bridge-watch.service');
    const watch = app.ctx.get(BridgeWatchService);
    const config = runtimeConfig as { verifyRecheckMs: number };
    const before = config.verifyRecheckMs;
    // the bridge polls every second: a second look three seconds later finds the change delivered
    config.verifyRecheckMs = 3000;
    try {
      const source = uniqueTable('vr_src');
      const dest = uniqueTable('vr_dst');
      await pg(
        `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text, updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO "${source}" (id, name) SELECT g, 'n' || g FROM generate_series(1, 20) g`,
      );
      cleanups.push(() =>
        withAdapter('postgres', (a) => a.dropTable(source)).then(
          () => undefined,
        ),
      );
      cleanups.push(() =>
        withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
          () => undefined,
        ),
      );
      const id = await bridgeOf({
        name: `it-vr-${source}`,
        source: { kind: 'table', connectionId: conns.postgres, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: conns.postgres_dest,
              table: dest,
              keyColumns: ['id'],
              createMissingTable: true,
            },
          ],
        },
        // (polled by its updated_at: that is what makes a poller see an UPDATE at all)
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'timestamp', column: 'updated_at' },
          pollIntervalMs: 1000,
          startFrom: 'beginning',
        },
      });
      cleanups.push(() =>
        watch
          .stop(id)
          .then(() => undefined)
          .catch(() => undefined),
      );
      await watch.start(id);
      await waitFor('the first copy', async () =>
        (await destRows('postgres_dest', dest)).length === 20 ? true : null,
      );

      // changed at the source a moment before the look: the destination does not have it YET
      await pg(
        `UPDATE "${source}" SET name = 'changed a moment ago', updated_at = now() WHERE id = 5`,
      );
      const started = Date.now();
      const v = await verify(id);
      expect(v.targets[0]!.samples.different).toEqual([]);
      expect(v.targets[0]).toMatchObject({
        checked: 20,
        missing: 0,
        different: 0,
        extra: 0,
      });
      expect(v.inSync).toBe(true);
      // …and it WAS seen at first sight: the second look is the only thing that waits
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
      expect(
        (await destRows('postgres_dest', dest)).find((r) => Number(r.id) === 5)!
          .name,
      ).toBe('changed a moment ago');

      // edited by hand at the destination: the source has not changed, so the bridge will never put it right
      await pgDest(`UPDATE "${dest}" SET name = 'edited by hand' WHERE id = 7`);
      const fixed = await verify(id, { mode: 'reconcile' });
      expect(fixed.targets[0]).toMatchObject({
        different: 1,
        fixed: 1,
        notes: [],
      });
      expect(
        (await destRows('postgres_dest', dest)).find((r) => Number(r.id) === 7)!
          .name,
      ).toBe('n7');
      expect(await verify(id)).toMatchObject({ inSync: true });
    } finally {
      config.verifyRecheckMs = before;
    }
  }, 120_000);
});

describe('what cannot be verified says why', () => {
  it('an HTTP destination, a target that only inserts, a second verification at once', async () => {
    const source = uniqueTable('vr_src');
    await pg(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES (1, 'a')`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    const http = await bridgeOf({
      name: `it-vr-http-${source}`,
      source: { kind: 'table', connectionId: conns.postgres, table: source },
      destination: { kind: 'http', url: 'https://example.com/hook' },
    });
    await expect(
      controller.startVerification(http, {
        mode: 'verify',
        deleteExtra: false,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be read back/),
      details: { reason: 'not-verifiable' },
    });

    const dest = uniqueTable('vr_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const inserts = await bridgeOf({
      name: `it-vr-ins-${source}`,
      source: { kind: 'table', connectionId: conns.postgres, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: conns.postgres_dest,
            table: dest,
            writeMode: 'insert',
            keyColumns: [],
            createMissingTable: true,
          },
        ],
      },
    });
    await replay(inserts);
    const v = await verify(inserts);
    expect(v).toMatchObject({
      status: 'completed',
      inSync: null,
      sourceRows: 0,
    });
    expect(v.targets[0]!.unsupported).toMatch(/no key columns/);
  });

  it('a verification can be stopped, and only one runs at a time', async () => {
    const b = await copyOfUsers(3000, {
      delivery: { pageSize: 50, batchSize: 500 },
    });
    const started = await controller.startVerification(b.id, {
      mode: 'verify',
      deleteExtra: false,
    });
    await expect(
      controller.startVerification(b.id, {
        mode: 'verify',
        deleteExtra: false,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/already running/),
    });
    await controller.cancelVerification(b.id, started.id);
    const ended = await waitFor('it to stop', async () => {
      const v: BridgeVerification = await controller.verification(
        b.id,
        started.id,
      );
      return ['completed', 'canceled', 'failed'].includes(v.status) ? v : null;
    });
    // (on a fast machine it may have finished before the cancel landed)
    expect(['canceled', 'completed']).toContain(ended.status);
    await expect(
      controller.verification(b.id, 'no-such-id'),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not found/) });
  });
});
