/**
 * How a replay pages through a table, against real engines.
 *
 * A table with a single-column primary key was always read by keyset
 * (`key > last`). Everything else — a composite key, a sort of the bridge's
 * own, a table without a key, a view — was read by OFFSET, where every page
 * re-reads all the pages before it. Now a key of any width is a keyset, a sort
 * of the bridge's own gets the key appended and is a keyset too, a table
 * without a key is keyed by a unique index when it has one, and what is left
 * is read by OFFSET in the order of all its columns — and the run says so.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeVerification } from '@syncle/core';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
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
  ] as const)
    conns[key] = await connectionFor(app, key);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

type Engine = 'postgres' | 'mysql';
const destOf = (engine: Engine): ConnKey =>
  engine === 'postgres' ? 'postgres_dest' : 'mysql_dest';
const q = (engine: ConnKey, sql: string) =>
  withAdapter(engine, (a) => a.query(sql));
const ident = (engine: Engine, name: string) =>
  engine === 'postgres' ? `"${name}"` : `\`${name}\``;

/** 450 rows under a key of two columns, with a NOT NULL text whose order is not the key's */
const GRID = Array.from({ length: 3 }, (_, t) =>
  Array.from({ length: 150 }, (_, s) => ({
    tenant: t + 1,
    seq: s + 1,
    note: `n${String(((s + 1) * 7 + (t + 1) * 3) % 1000).padStart(4, '0')}-${t + 1}-${s + 1}`,
  })),
).flat();

async function gridTable(engine: Engine, prefix: string): Promise<string> {
  const table = uniqueTable(prefix);
  const text = engine === 'postgres' ? 'varchar(40)' : 'varchar(40)';
  await q(
    engine,
    `CREATE TABLE ${ident(engine, table)} (tenant integer NOT NULL, seq integer NOT NULL, note ${text} NOT NULL, PRIMARY KEY (tenant, seq))`,
  );
  cleanups.push(() =>
    withAdapter(engine, (a) => a.dropTable(table)).then(() => undefined),
  );
  const values = GRID.map((r) => `(${r.tenant}, ${r.seq}, '${r.note}')`).join(
    ', ',
  );
  await q(
    engine,
    `INSERT INTO ${ident(engine, table)} (tenant, seq, note) VALUES ${values}`,
  );
  return table;
}

async function bridgeFor(
  engine: Engine,
  source: string,
  over: {
    sort?: Array<{ column: string; direction: 'asc' | 'desc' }>;
    keyColumns?: string[];
    writeMode?: 'upsert' | 'insert';
    delivery?: Record<string, unknown>;
  } = {},
): Promise<{ id: string; dest: string }> {
  const dest = uniqueTable('rp_dst');
  const destEngine = destOf(engine);
  cleanups.push(() =>
    withAdapter(destEngine, (a) => a.dropTable(dest)).catch(() => undefined),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-rp-${source}`,
      source: {
        kind: 'table',
        connectionId: conns[engine],
        table: source,
        ...(over.sort ? { sort: over.sort } : {}),
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: conns[destEngine],
            table: dest,
            writeMode: over.writeMode ?? 'upsert',
            keyColumns: over.keyColumns ?? ['tenant', 'seq'],
            mapping: [],
            createMissingTable: true,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: { kind: 'replay' },
      delivery: { batchSize: 100, pageSize: 100, ...(over.delivery ?? {}) },
    }),
  );
  return { id: bridge.id, dest };
}

const settled = (jobId: string, timeoutMs = 90_000) =>
  waitFor(
    `replay ${jobId}`,
    async () => {
      const j = await app.prisma.bridgeJob.findUnique({ where: { id: jobId } });
      return j && ['completed', 'failed', 'canceled'].includes(j.status)
        ? j
        : null;
    },
    { timeoutMs },
  );

async function run(bridgeId: string): Promise<any> {
  const started = await jobs.start(bridgeId);
  return settled(started.id);
}

/**
 * the keyset checkpoint the run last saved. it is saved with each FULL batch
 * (the last, partial one is followed by the end of the run, which needs no
 * checkpoint), so after 450 rows in batches of 100 it names row 400
 */
const keysetOf = (job: { cursorJson: string | null }) =>
  job.cursorJson ? (JSON.parse(job.cursorJson).keyset ?? null) : null;

async function destRowsOf(
  engine: Engine,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const page = await withAdapter(destOf(engine), (a) =>
    a.browse({
      table,
      limit: 1000,
      offset: 0,
      sort: [
        { column: 'tenant', direction: 'asc' },
        { column: 'seq', direction: 'asc' },
      ],
    }),
  );
  return page.rows.map((r) => ({
    tenant: Number(r.tenant),
    seq: Number(r.seq),
    note: r.note,
  }));
}

/** every delivered row exactly once: the deliveries' rows add up to the destination */
async function deliveredRows(jobId: string): Promise<number> {
  const rows = await app.prisma.bridgeDelivery.findMany({
    where: { jobId, status: 'success' },
    select: { rowCount: true },
  });
  return rows.reduce((n, d) => n + d.rowCount, 0);
}

const notices = (jobId: string) =>
  app.prisma.bridgeDelivery.findMany({
    where: { jobId, status: 'skipped', rowCount: 0 },
    orderBy: { sequence: 'asc' },
  });

describe.each<Engine>(['postgres', 'mysql'])('a %s table', (engine) => {
  it('with a key of two columns is replayed after the tuple, and the checkpoint is the tuple', async () => {
    const source = await gridTable(engine, 'rp_ck');
    const b = await bridgeFor(engine, source);
    const job = await run(b.id);
    expect(job.status).toBe('completed');
    expect(job.sentCount).toBe(450);
    expect(await destRowsOf(engine, b.dest)).toEqual(GRID);
    expect(keysetOf(job)).toEqual({ column: 'tenant,seq', value: [3, 100] });
    expect(await notices(job.id)).toEqual([]);
  }, 120_000);

  it('canceled half-way and started again, delivers every remaining row once — whatever moved under it', async () => {
    const source = await gridTable(engine, 'rp_rs');
    const b = await bridgeFor(engine, source, {
      delivery: { batchSize: 50, pageSize: 50, minDelayMs: 400 },
    });
    const started = await jobs.start(b.id);
    await waitFor(
      'two deliveries',
      async () =>
        (await app.prisma.bridgeDelivery.count({
          where: { jobId: started.id, status: 'success' },
        })) >= 2
          ? true
          : null,
      { timeoutMs: 30_000 },
    );
    await jobs.cancel(b.id, started.id);
    const canceled = await settled(started.id, 30_000);
    expect(canceled.status).toBe('canceled');
    const before = await deliveredRows(started.id);
    expect(before).toBeGreaterThanOrEqual(100);
    expect(before).toBeLessThan(450);
    const checkpoint = keysetOf(canceled);
    expect(checkpoint.column).toBe('tenant,seq');

    // the table moves: a delivered row goes, a row lands BEFORE the
    // checkpoint (an OFFSET resume would have skipped one row for it), a row
    // lands after the end
    const t = ident(engine, source);
    await q(engine, `DELETE FROM ${t} WHERE tenant = 1 AND seq = 1`);
    await q(
      engine,
      `INSERT INTO ${t} (tenant, seq, note) VALUES (0, 1, 'early')`,
    );
    await q(
      engine,
      `INSERT INTO ${t} (tenant, seq, note) VALUES (9, 1, 'late')`,
    );

    const resumed = await jobs.start(b.id); // picks the canceled run up again
    expect(resumed.id).toBe(started.id);
    const job = await settled(started.id);
    expect(job.status).toBe('completed');
    const dest = await destRowsOf(engine, b.dest);
    // the row that went was delivered before it went; the early one is behind
    // the checkpoint and is not the run's to deliver; the late one is
    expect(dest).toEqual([...GRID, { tenant: 9, seq: 1, note: 'late' }]);
    expect(await deliveredRows(started.id)).toBe(451);
  }, 120_000);

  it('sorted the bridge’s own way is delivered in that order, keyset-paginated with the key behind the sort', async () => {
    const source = await gridTable(engine, 'rp_srt');
    const b = await bridgeFor(engine, source, {
      sort: [{ column: 'note', direction: 'desc' }],
    });
    const job = await run(b.id);
    expect(job.status).toBe('completed');
    expect(job.sentCount).toBe(450);
    const byNoteDesc = [...GRID].sort((x, y) => (x.note < y.note ? 1 : -1));
    const row400 = byNoteDesc[399]!;
    expect(keysetOf(job)).toEqual({
      column: 'note,tenant,seq',
      value: [row400.note, row400.tenant, row400.seq],
    });
    // the first delivery holds the first hundred, in the sort's order
    const first = await app.prisma.bridgeDelivery.findUnique({
      where: { jobId_sequence: { jobId: job.id, sequence: 0 } },
    });
    const rows = JSON.parse(first!.requestBody!) as Array<{ note: string }>;
    expect(rows.map((r) => r.note)).toEqual(
      byNoteDesc.slice(0, 100).map((r) => r.note),
    );
    expect(await destRowsOf(engine, b.dest)).toEqual(GRID);
  }, 120_000);

  it('with no primary key but a unique index of NOT NULL columns is keyed by that', async () => {
    const source = uniqueTable('rp_ux');
    const t = ident(engine, source);
    await q(
      engine,
      `CREATE TABLE ${t} (code varchar(20) NOT NULL, tenant integer NOT NULL, seq integer NOT NULL, note varchar(40) NOT NULL, UNIQUE (code))`,
    );
    cleanups.push(() =>
      withAdapter(engine, (a) => a.dropTable(source)).then(() => undefined),
    );
    const values = GRID.map(
      (r) =>
        `('c${r.tenant}-${String(r.seq).padStart(3, '0')}', ${r.tenant}, ${r.seq}, '${r.note}')`,
    ).join(', ');
    await q(
      engine,
      `INSERT INTO ${t} (code, tenant, seq, note) VALUES ${values}`,
    );
    const b = await bridgeFor(engine, source, { keyColumns: ['code'] });
    const job = await run(b.id);
    expect(job.status).toBe('completed');
    expect(job.sentCount).toBe(450);
    expect(keysetOf(job)).toEqual({ column: 'code', value: 'c3-100' });
    expect(await notices(job.id)).toEqual([]);
    expect((await destRowsOf(engine, b.dest)).map((r) => r.note)).toEqual(
      GRID.map((r) => r.note),
    );
  }, 120_000);

  it('with no key at all is read by OFFSET in the order of its columns — and the run says so', async () => {
    const source = uniqueTable('rp_nk');
    const t = ident(engine, source);
    await q(
      engine,
      `CREATE TABLE ${t} (tenant integer, seq integer, note varchar(40))`,
    );
    cleanups.push(() =>
      withAdapter(engine, (a) => a.dropTable(source)).then(() => undefined),
    );
    const values = GRID.slice(0, 120)
      .map((r) => `(${r.tenant}, ${r.seq}, '${r.note}')`)
      .join(', ');
    await q(engine, `INSERT INTO ${t} (tenant, seq, note) VALUES ${values}`);
    const b = await bridgeFor(engine, source, {
      keyColumns: [],
      writeMode: 'insert',
    });
    const job = await run(b.id);
    expect(job.status).toBe('completed');
    expect(job.sentCount).toBe(120);
    expect(keysetOf(job)).toBeNull();
    expect(await destRowsOf(engine, b.dest)).toEqual(GRID.slice(0, 120));
    const said = await notices(job.id);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
      sequence: -1,
      rowIndex: 0,
      status: 'skipped',
    });
    expect(said[0]!.error).toMatch(/no primary key and no unique index/);
    expect(said[0]!.error).toMatch(/skipped or delivered twice/);
  }, 120_000);

  it('a VIEW, likewise: every row, and the word about it', async () => {
    const source = await gridTable(engine, 'rp_vb');
    const view = uniqueTable('rp_v');
    await q(
      engine,
      `CREATE VIEW ${ident(engine, view)} AS SELECT tenant, seq, note FROM ${ident(engine, source)}`,
    );
    cleanups.push(() =>
      q(engine, `DROP VIEW IF EXISTS ${ident(engine, view)}`).then(
        () => undefined,
      ),
    );
    const b = await bridgeFor(engine, view);
    const job = await run(b.id);
    expect(job.status).toBe('completed');
    expect(job.sentCount).toBe(450);
    expect(await destRowsOf(engine, b.dest)).toEqual(GRID);
    const said = await notices(job.id);
    expect(said).toHaveLength(1);
    expect(said[0]!.error).toMatch(/no primary key and no unique index/);
  }, 120_000);
});

describe('verifying a copy under a key of two columns', () => {
  async function verify(
    bridgeId: string,
    dto: Record<string, unknown> = {},
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
        return ['completed', 'failed', 'canceled'].includes(v.status)
          ? v
          : null;
      },
      { timeoutMs: 60_000 },
    );
  }

  it('reads both ends after the tuple, and finds what drifted', async () => {
    const source = await gridTable('postgres', 'rp_vf');
    const b = await bridgeFor('postgres', source);
    expect((await run(b.id)).status).toBe('completed');
    expect(await verify(b.id)).toMatchObject({
      status: 'completed',
      inSync: true,
      sourceRows: 450,
    });

    const d = `"${b.dest}"`;
    await q('postgres_dest', `DELETE FROM ${d} WHERE tenant = 2 AND seq = 75`);
    await q(
      'postgres_dest',
      `UPDATE ${d} SET note = 'by hand' WHERE tenant = 3 AND seq = 1`,
    );
    await q(
      'postgres_dest',
      `INSERT INTO ${d} (tenant, seq, note) VALUES (7, 7, 'ghost')`,
    );
    const v = await verify(b.id);
    expect(v).toMatchObject({
      status: 'completed',
      inSync: false,
      sourceRows: 450,
    });
    expect(v.targets[0]).toMatchObject({
      checked: 450,
      missing: 1,
      different: 1,
      extra: 1,
    });
    expect(v.targets[0]!.notes ?? []).toEqual([]);

    const fixed = await verify(b.id, { mode: 'reconcile', deleteExtra: true });
    expect(fixed.targets[0]).toMatchObject({ fixed: 2, removed: 1 });
    expect(await destRowsOf('postgres', b.dest)).toEqual(GRID);
  }, 180_000);
});
