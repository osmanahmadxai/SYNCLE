/**
 * "Copy what is there, then follow the changes" — in ONE bridge, end to end,
 * from every engine that has a change stream.
 *
 * What is being proven is the seam. Two bridges (a replay, then a change
 * stream) leave a gap between them, or an overlap in which an old value read by
 * the replay lands on top of a new one. So the test that matters here changes
 * the source WHILE the copy is running — inserts, updates and deletes, across
 * rows already copied and rows not yet reached — and then asks for one thing:
 * that the destination ends up identical to the source.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  makeBridge,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
const cleanups: Array<() => Promise<void>> = [];
const BATCH_BEFORE = process.env.SYNCLE_CDC_BATCH_SIZE;

beforeAll(async () => {
  // small deliveries, so that a copy is many of them: there is a "during"
  process.env.SYNCLE_CDC_BATCH_SIZE = '50';
  app = await bootstrapApp();
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  if (BATCH_BEFORE === undefined) delete process.env.SYNCLE_CDC_BATCH_SIZE;
  else process.env.SYNCLE_CDC_BATCH_SIZE = BATCH_BEFORE;
});

const LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
};
const people = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: offset + i + 1,
    name: `row-${offset + i + 1}`,
  }));

/** id -> name of every row in a table, for comparing two of them whole */
async function contents(
  engine: ConnKey,
  table: string,
): Promise<Record<string, string>> {
  if (engine.startsWith('postgres')) {
    // one row however large the table is: a page of `browse` is capped
    const res = await withAdapter(engine, (a) =>
      a.query(
        `SELECT COALESCE(json_object_agg(id::text, name), '{}'::json) AS m FROM "${table}"`,
      ),
    ).catch(() => null);
    const m = res?.rows[0]?.m;
    return (typeof m === 'string' ? JSON.parse(m) : (m ?? {})) as Record<
      string,
      string
    >;
  }
  // page by page: an adapter caps what one `browse` returns (MongoDB: 1000)
  const out: Record<string, string> = {};
  for (let offset = 0; ; offset += 1000) {
    const page = await withAdapter(engine, (a) =>
      a.browse({
        table,
        limit: 1000,
        offset,
        sort: [{ column: 'id', direction: 'asc' }],
      }),
    );
    for (const r of page.rows) out[String(r.id)] = String(r.name);
    if (page.rows.length < 1000) return out;
  }
}

/** how two tables differ, in a line — or null when they do not */
function difference(
  want: Record<string, string>,
  got: Record<string, string>,
): string | null {
  const missing = Object.keys(want).filter((id) => !(id in got));
  const extra = Object.keys(got).filter((id) => !(id in want));
  const stale = Object.keys(want).filter(
    (id) => id in got && got[id] !== want[id],
  );
  if (!missing.length && !extra.length && !stale.length) return null;
  const show = (ids: string[]) =>
    `${ids.length}${ids.length ? ` (${ids.slice(0, 8).join(', ')})` : ''}`;
  return `missing ${show(missing)}; not deleted ${show(extra)}; stale ${show(stale.map((id) => `${id}: ${got[id]} != ${want[id]}`))}`;
}

/** one write at a source, in that engine's own words */
async function change(
  engine: ConnKey,
  table: string,
  op: 'insert' | 'update' | 'delete',
  id: number,
  name = '',
): Promise<void> {
  await withAdapter(engine, async (a) => {
    if (op === 'insert') await a.insertRow({ table, values: { id, name } });
    else if (op === 'update')
      await a.updateRow({ table, identity: { id }, changes: { name } });
    else await a.deleteRow({ table, identity: { id } });
  });
}

async function timeline(bridgeId: string) {
  const job = await app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });
  const deliveries = await app.prisma.bridgeDelivery.findMany({
    where: { jobId: job.id },
    orderBy: { sequence: 'asc' },
  });
  return { job, deliveries };
}

const copiedNotice = (
  deliveries: Array<{ error: string | null; status: string }>,
) =>
  deliveries.find(
    (d) =>
      d.status === 'skipped' &&
      /^Copied the \d+ rows? the table already had/.test(d.error ?? ''),
  );

/**
 * the timeline once the copy has been marked as over. the mark is recorded
 * AFTER the last copied batch has landed, so "all the rows are there" is a
 * moment too early to look for it
 */
async function timelineAfterCopy(bridgeId: string, notices = 1) {
  return waitFor(`the end of copy #${notices} to be recorded`, async () => {
    const state = await timeline(bridgeId);
    return state.deliveries.filter(
      (d: { error: string | null; status: string }) => copiedNotice([d]),
    ).length >= notices
      ? state
      : null;
  });
}

for (const source of ['postgres', 'mysql', 'mongodb'] as ConnKey[]) {
  describe(`${LABEL[source]}: copy, then follow`, () => {
    it('ends up identical to the source, though the source kept changing while it was copied', async () => {
      const srcConn = await connectionFor(app, source);
      const dstConn = await connectionFor(app, 'postgres_dest');
      const TOTAL = 3000;
      const s = await makeBridge(app, {
        sourceEngine: source,
        destEngine: 'postgres_dest',
        sourceConnId: srcConn,
        destConnId: dstConn,
        cleanups,
        start: false,
        startFrom: 'beginning',
        seed: people(TOTAL),
      });

      const startedAt = Date.now();
      await app.cdc.start(s.bridgeId);

      // straight away, while the copy is somewhere in the middle of the table:
      // rows near the start (copied by now, or about to be), rows near the end
      // (not reached yet), new rows, and rows that go away
      const edits: Array<Promise<void>> = [];
      for (let i = 0; i < 40; i++) {
        const near = 1 + i * 7;
        const far = TOTAL - i * 11;
        edits.push(
          (async () => {
            await change(source, s.sourceTable, 'update', near, `early-${i}`);
            await change(source, s.sourceTable, 'update', far, `late-${i}`);
            await change(
              source,
              s.sourceTable,
              'insert',
              TOTAL + 1 + i,
              `new-${i}`,
            );
            if (i % 4 === 0)
              await change(source, s.sourceTable, 'delete', 2 + i * 13);
            // the same row twice: the LAST value has to be the one that stays
            if (i % 5 === 0)
              await change(
                source,
                s.sourceTable,
                'update',
                near,
                `early-${i}-again`,
              );
          })(),
        );
      }
      await Promise.all(edits);
      const editsDoneAt = Date.now();

      const want = await contents(source, s.sourceTable);
      expect(Object.keys(want)).toHaveLength(TOTAL + 40 - 10);

      await waitFor(
        `${LABEL[source]} destination to match its source`,
        async () => {
          // a bridge that has stopped will never get there: say why, now
          const state = await timeline(s.bridgeId);
          if (state.job.status !== 'running') {
            const failed = state.deliveries.find(
              (d: { status: string }) => d.status === 'failed',
            );
            throw new Error(
              `bridge is ${state.job.status}: ${state.job.error} / ${failed?.error}`,
            );
          }
          const got = await contents('postgres_dest', s.destTable);
          const off = difference(want, got);
          // (thrown, so that a timeout reports what was still different)
          if (off) throw new Error(off);
          return true;
        },
        { timeoutMs: 45_000, intervalMs: 250 },
      );
      expect(await contents('postgres_dest', s.destTable)).toEqual(want);

      const { job, deliveries } = await timelineAfterCopy(s.bridgeId);
      expect(job.status).toBe('running');
      const notice = copiedNotice(deliveries);
      expect(
        notice,
        'the timeline says when the copy ended and the stream began',
      ).toBeTruthy();
      // the copy was many deliveries, the notice came after them, and changes after that
      const at = deliveries.indexOf(notice!);
      expect(at).toBeGreaterThanOrEqual(TOTAL / 50 - 1);
      expect(deliveries.slice(0, at).every((d) => d.status === 'success')).toBe(
        true,
      );
      expect(deliveries.length).toBeGreaterThan(at + 1);
      // and the point of it all: the source was being changed before the copy was over
      console.log(
        `${LABEL[source]}: edits took ${editsDoneAt - startedAt} ms; the copy ended ${notice!.createdAt.getTime() - startedAt} ms after the start`,
      );

      // from here on it is an ordinary change stream
      await change(source, s.sourceTable, 'insert', 999_001, 'after');
      await change(source, s.sourceTable, 'delete', 5);
      await waitFor('the later changes', async () => {
        const got = await contents('postgres_dest', s.destTable);
        return got['999001'] === 'after' && !('5' in got) ? true : null;
      });
    }, 240_000);
  });
}

describe('PostgreSQL: a copy that is interrupted', () => {
  it('resumes where it stopped — and what changed while it was stopped is not lost', async () => {
    const srcConn = await connectionFor(app, 'postgres');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const TOTAL = 6000;
    const s = await makeBridge(app, {
      destEngine: 'postgres_dest',
      sourceConnId: srcConn,
      destConnId: dstConn,
      cleanups,
      start: false,
      startFrom: 'beginning',
      seed: people(TOTAL),
    });
    await app.cdc.start(s.bridgeId);
    await waitFor(
      'a few deliveries',
      async () =>
        (await timeline(s.bridgeId)).deliveries.length >= 3 ? true : null,
      {
        intervalMs: 5,
      },
    );
    await app.cdc.stop(s.bridgeId);

    const stopped = await timeline(s.bridgeId);
    expect(stopped.job.status).toBe('paused');
    const copiedSoFar = Object.keys(
      await contents('postgres_dest', s.destTable),
    ).length;
    expect(copiedSoFar).toBeGreaterThan(0);
    expect(copiedSoFar).toBeLessThan(TOTAL);
    expect(copiedNotice(stopped.deliveries)).toBeUndefined();
    // the saved position is the copy's: how far it got, and where the stream is to start
    const { parseSnapshotCursor } =
      await import('../../src/bridges/cdc/snapshot-provider');
    const saved = parseSnapshotCursor(
      JSON.parse(stopped.job.cursorJson).cursor,
    );
    expect(saved).toMatchObject({ done: false, key: { column: 'id' } });
    // delivered directly, the position IS the last row that landed. with the
    // spool on, it is the last row made durable in the spool, which runs ahead
    // of what has been delivered from it — and is where the READ resumes
    if (process.env.SYNCLE_CDC_SPOOL === 'on')
      expect(saved!.index).toBeGreaterThanOrEqual(copiedSoFar - 1);
    else expect(saved!.index).toBe(copiedSoFar - 1);

    // while it is stopped: a row it has copied, a row it has not reached, a new one, a deleted one
    await change(
      'postgres',
      s.sourceTable,
      'update',
      1,
      'changed-while-stopped',
    );
    await change(
      'postgres',
      s.sourceTable,
      'update',
      TOTAL,
      'changed-while-stopped',
    );
    await change(
      'postgres',
      s.sourceTable,
      'insert',
      TOTAL + 1,
      'added-while-stopped',
    );
    await change('postgres', s.sourceTable, 'delete', 2);

    await app.cdc.start(s.bridgeId);
    const want = await contents('postgres', s.sourceTable);
    await waitFor(
      'the destination to match',
      async () => {
        const got = await contents('postgres_dest', s.destTable);
        return Object.keys(got).length === Object.keys(want).length &&
          got['1'] === 'changed-while-stopped'
          ? true
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 250 },
    );
    expect(await contents('postgres_dest', s.destTable)).toEqual(want);

    // resumed, not restarted: no row was copied twice. every row the table had,
    // plus the one added while the bridge was stopped — the copy had not reached
    // the end of the table yet, so it found that one itself. (row 2 was copied
    // before the stop; its delete then arrived as a change)
    const { deliveries } = await timelineAfterCopy(s.bridgeId);
    const notice = copiedNotice(deliveries)!;
    expect(notice.error).toContain(`Copied the ${TOTAL + 1} rows`);
    const copiedRows = deliveries
      .slice(0, deliveries.indexOf(notice))
      .reduce((n, d) => n + d.rowCount, 0);
    expect(copiedRows).toBe(TOTAL + 1);
  }, 240_000);

  it('survives the process: a copy found half-done at boot carries on', async () => {
    const srcConn = await connectionFor(app, 'postgres');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const TOTAL = 4000;
    const s = await makeBridge(app, {
      destEngine: 'postgres_dest',
      sourceConnId: srcConn,
      destConnId: dstConn,
      cleanups,
      start: false,
      startFrom: 'beginning',
      seed: people(TOTAL),
    });
    await app.cdc.start(s.bridgeId);
    await waitFor(
      'a few deliveries',
      async () =>
        (await timeline(s.bridgeId)).deliveries.length >= 3 ? true : null,
      {
        intervalMs: 5,
      },
    );
    // what a crash leaves behind: the stream gone, the job still marked running
    await app.cdc.stop(s.bridgeId);
    await app.prisma.bridgeJob.updateMany({
      where: { bridgeId: s.bridgeId },
      data: { status: 'running', finishedAt: null },
    });
    expect(
      Object.keys(await contents('postgres_dest', s.destTable)).length,
    ).toBeLessThan(TOTAL);

    await app.cdc.resumeAll(); // (what the process that leads does at boot)
    await waitFor(
      'the rest of the table',
      async () =>
        Object.keys(await contents('postgres_dest', s.destTable)).length ===
        TOTAL
          ? true
          : null,
      { timeoutMs: 120_000, intervalMs: 250 },
    );
    expect(
      copiedNotice((await timelineAfterCopy(s.bridgeId)).deliveries),
    ).toBeTruthy();
  }, 240_000);
});

describe('what the copy is, and is not', () => {
  it('a bridge that starts from `now` copies nothing (the default, and what every bridge did before)', async () => {
    const srcConn = await connectionFor(app, 'postgres');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const s = await makeBridge(app, {
      destEngine: 'postgres_dest',
      sourceConnId: srcConn,
      destConnId: dstConn,
      cleanups,
      seed: people(20),
    });
    await change('postgres', s.sourceTable, 'insert', 21, 'new');
    await waitFor('the new row', async () =>
      (await contents('postgres_dest', s.destTable))['21'] === 'new'
        ? true
        : null,
    );
    expect(Object.keys(await contents('postgres_dest', s.destTable))).toEqual([
      '21',
    ]);
  }, 120_000);

  it('applies the bridge’s filters to the copy as it does to the changes', async () => {
    const srcConn = await connectionFor(app, 'postgres');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const s = await makeBridge(app, {
      destEngine: 'postgres_dest',
      sourceConnId: srcConn,
      destConnId: dstConn,
      cleanups,
      start: false,
      startFrom: 'beginning',
      seed: people(200),
      filters: [{ column: 'id', operator: 'lte', value: 120 }],
    });
    await app.cdc.start(s.bridgeId);
    await waitFor('the copy', async () =>
      copiedNotice((await timeline(s.bridgeId)).deliveries) ? true : null,
    );
    expect(
      Object.keys(await contents('postgres_dest', s.destTable)),
    ).toHaveLength(120);
    await change('postgres', s.sourceTable, 'update', 7, 'in');
    await change('postgres', s.sourceTable, 'update', 190, 'out');
    await waitFor('the change', async () =>
      (await contents('postgres_dest', s.destTable))['7'] === 'in'
        ? true
        : null,
    );
    expect(
      (await contents('postgres_dest', s.destTable))['190'],
    ).toBeUndefined();
  }, 120_000);

  it('refuses a table it cannot page through — at the start, and leaves no job running', async () => {
    const srcConn = await connectionFor(app, 'postgres');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const table = uniqueTable('bf_nokey');
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${table}" (id integer, name text); ALTER TABLE "${table}" REPLICA IDENTITY FULL`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(table)).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-${table}`,
        source: { kind: 'table', connectionId: srcConn, table },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: dstConn,
              table: `${table}_dst`,
              writeMode: 'insert',
              keyColumns: [],
              mapping: [],
              createMissingTable: true,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: {
          kind: 'cdc',
          operations: ['insert'],
          startFrom: 'beginning',
        },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });
    await expect(app.cdc.start(bridge.id)).rejects.toThrow(/no primary key/);
    const { job } = await timeline(bridge.id);
    expect(job.status).toBe('failed');
    // and it can be started once that is put right
    await withAdapter('postgres', (a) =>
      a.query(`ALTER TABLE "${table}" ADD PRIMARY KEY (id)`),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(`${table}_dst`)).then(
        () => undefined,
      ),
    );
    await expect(app.cdc.start(bridge.id)).resolves.toMatchObject({
      status: 'running',
    });
  }, 120_000);
});

describe('PostgreSQL: a lost position, on a bridge that copies first', () => {
  async function lostBridge(rows: number) {
    const srcConn = await connectionFor(app, 'postgres');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const s = await makeBridge(app, {
      destEngine: 'postgres_dest',
      sourceConnId: srcConn,
      destConnId: dstConn,
      cleanups,
      start: false,
      startFrom: 'beginning',
      seed: people(rows),
    });
    await app.cdc.start(s.bridgeId);
    await waitFor('the copy', async () =>
      copiedNotice((await timeline(s.bridgeId)).deliveries) ? true : null,
    );
    await app.cdc.stop(s.bridgeId);
    // the slot goes while the bridge is not running, and the source moves on
    await withAdapter('postgres', (a) =>
      a.query(
        `SELECT pg_drop_replication_slot('syncle_slot_${s.bridgeId.replace(/-/g, '')}')`,
      ),
    );
    await change('postgres', s.sourceTable, 'update', 1, 'changed-in-the-gap');
    await change(
      'postgres',
      s.sourceTable,
      'insert',
      rows + 1,
      'added-in-the-gap',
    );
    await expect(app.cdc.start(s.bridgeId)).rejects.toMatchObject({
      details: { reason: 'position-lost' },
    });
    return s;
  }

  it('"continue from now" means from now: the table is NOT read again', async () => {
    const s = await lostBridge(150);
    await app.cdc.start(s.bridgeId, { fromNow: true });
    await change('postgres', s.sourceTable, 'insert', 9000, 'after');
    await waitFor('the new row', async () =>
      (await contents('postgres_dest', s.destTable))['9000'] === 'after'
        ? true
        : null,
    );
    const got = await contents('postgres_dest', s.destTable);
    // the gap is a gap, as the timeline says
    expect(got['1']).toBe('row-1');
    expect(got['151']).toBeUndefined();
    const { deliveries } = await timeline(s.bridgeId);
    expect(deliveries.filter((d) => copiedNotice([d]))).toHaveLength(1);
    expect(deliveries.some((d) => /NOT captured/.test(d.error ?? ''))).toBe(
      true,
    );

    // …and it stays that way across a restart with nothing delivered in between
    await app.cdc.stop(s.bridgeId);
    await app.cdc.start(s.bridgeId);
    await change('postgres', s.sourceTable, 'insert', 9001, 'later');
    await waitFor('the later row', async () =>
      (await contents('postgres_dest', s.destTable))['9001'] === 'later'
        ? true
        : null,
    );
    expect(
      (await timeline(s.bridgeId)).deliveries.filter((d) => copiedNotice([d])),
    ).toHaveLength(1);
  }, 240_000);

  it('…unless it is asked to copy again, which closes the gap for every row that still exists', async () => {
    const s = await lostBridge(150);
    await app.cdc.start(s.bridgeId, { fromNow: true, recopy: true });
    const want = await contents('postgres', s.sourceTable);
    await waitFor(
      'the destination to match',
      async () =>
        (await contents('postgres_dest', s.destTable))['151'] ===
        'added-in-the-gap'
          ? true
          : null,
      { timeoutMs: 60_000 },
    );
    expect(await contents('postgres_dest', s.destTable)).toEqual(want);
    const { deliveries } = await timelineAfterCopy(s.bridgeId, 2);
    expect(deliveries.filter((d) => copiedNotice([d]))).toHaveLength(2);
    expect(deliveries.some((d) => /copied again/.test(d.error ?? ''))).toBe(
      true,
    );
  }, 240_000);
});

describe('Redis: copy, then follow', () => {
  it('copies the keys that exist, holds what changes meanwhile, and ends up identical', async () => {
    const prefix = uniqueTable('bfr');
    const TOTAL = 1200;
    const key = (i: number) => `${prefix}:${String(i).padStart(5, '0')}`;
    const run = (commands: string[]) =>
      withAdapter('redis', (a) => a.query(commands.join('\n')));
    for (let i = 0; i < TOTAL; i += 100) {
      await run(
        Array.from(
          { length: Math.min(100, TOTAL - i) },
          (_, j) => `SET ${key(i + j)} v${i + j}`,
        ),
      );
    }
    cleanups.push(async () => {
      for (let i = 0; i < TOTAL + 50; i += 100)
        await run([
          `DEL ${Array.from({ length: 100 }, (_, j) => key(i + j)).join(' ')}`,
        ]);
    });

    const srcConn = await connectionFor(app, 'redis');
    const dstConn = await connectionFor(app, 'postgres_dest');
    const dest = uniqueTable('bfr_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-${dest}`,
        source: {
          kind: 'table',
          connectionId: srcConn,
          table: 'keys',
          filters: [
            { column: 'key', operator: 'startsWith', value: `${prefix}:` },
          ],
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: dstConn,
              table: dest,
              keyColumns: ['id'],
              mapping: [
                { source: 'key', target: 'id' },
                { source: 'value', target: 'name' },
              ],
              createMissingTable: true,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: {
          kind: 'cdc',
          operations: ['insert', 'update', 'delete'],
          startFrom: 'beginning',
        },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });

    await app.cdc.start(bridge.id);
    // while the keys are being copied
    await run([
      ...Array.from({ length: 30 }, (_, i) => `SET ${key(i * 3)} changed-${i}`),
      ...Array.from(
        { length: 30 },
        (_, i) => `SET ${key(i * 3)} changed-again-${i}`,
      ),
      ...Array.from({ length: 20 }, (_, i) => `SET ${key(TOTAL + i)} new-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `DEL ${key(500 + i)}`),
      // not this bridge's keys: a copy and a stream that read the filter differently would disagree on these
      `SET x${prefix}:nope 1`,
    ]);
    cleanups.push(() => run([`DEL x${prefix}:nope`]).then(() => undefined));

    const want: Record<string, string> = {};
    for (let i = 0; i < TOTAL + 20; i++)
      want[key(i)] = i >= TOTAL ? `new-${i - TOTAL}` : `v${i}`;
    for (let i = 0; i < 30; i++) want[key(i * 3)] = `changed-again-${i}`;
    for (let i = 0; i < 10; i++) delete want[key(500 + i)];

    await waitFor(
      'the destination to match',
      async () => {
        const got = await contents('postgres_dest', dest);
        return Object.keys(got).length === Object.keys(want).length &&
          got[key(0)] === 'changed-again-0'
          ? true
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 250 },
    );
    expect(await contents('postgres_dest', dest)).toEqual(want);
    expect(
      copiedNotice((await timelineAfterCopy(bridge.id)).deliveries),
    ).toBeTruthy();
  }, 240_000);
});
