/**
 * Reading a MongoDB collection by its `_id`.
 *
 * A row shows an ObjectId as its 24 hex characters, and that text is what came
 * back in every filter on `_id`: the replay's "documents after the last one",
 * the keys of the rows picked in the builder, the keys a dead-letter retry
 * re-reads its rows by. MongoDB does not compare an ObjectId with a string, so
 * each of those matched nothing — quietly:
 *
 *  - a replay ended, `completed`, after its first page (200 documents)
 *  - a bridge over selected rows delivered none of them
 *  - a dead-letter retry could not find the row it was retrying, took it for
 *    deleted at the source, and resolved the entry without ever delivering it
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  writeSourceRows,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let jobs: any;
let mongo: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  jobs = app.ctx.get(BridgeJobService);
  mongo = await connectionFor(app, 'mongodb');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function collection(
  docs: Array<Record<string, unknown>>,
): Promise<string> {
  const table = uniqueTable('mr');
  await writeSourceRows('mongodb', table, docs);
  cleanups.push(() =>
    withAdapter('mongodb', (a) => a.dropTable(table)).then(() => undefined),
  );
  return table;
}

function target(dest: string, extra: Record<string, unknown> = {}) {
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  return {
    kind: 'database',
    targets: [
      {
        connectionId: pgDest,
        table: dest,
        keyColumns: ['id'],
        mapping: [
          { source: 'id', target: 'id' },
          { source: 'name', target: 'name' },
        ],
        createMissingTable: true,
        ...extra,
      },
    ],
  };
}

async function replay(input: Record<string, unknown>): Promise<any> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      transform: { template: '{{$row}}' },
      trigger: { kind: 'replay' },
      ...input,
    }),
  );
  const started = await jobs.start(bridge.id);
  return waitFor(
    `replay ${started.id}`,
    async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j && ['completed', 'failed'].includes(j.status) ? j : null;
    },
    { timeoutMs: 90_000 },
  );
}

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `row-${i + 1}`,
    age: i % 90,
  }));

describe('a replay from MongoDB', () => {
  it('reads a collection keyed by ObjectId to its end, not to the end of its first page', async () => {
    const table = await collection(people(1250));
    const dest = uniqueTable('mr_dst');
    const job = await replay({
      name: `it-${dest}`,
      source: { kind: 'table', connectionId: mongo, table },
      destination: target(dest),
      delivery: { batchSize: 100, pageSize: 200 },
    });
    expect(job.status, job.error).toBe('completed');
    expect(job.failedCount).toBe(0);
    const rows = await destRows('postgres_dest', dest);
    expect(rows).toHaveLength(1250);
    expect(rows[1249]).toMatchObject({ id: 1250, name: 'row-1250' });
  }, 180_000);

  it('…also when the builder’s own order (`_id` ascending) is set on the bridge', async () => {
    const table = await collection(people(450));
    const dest = uniqueTable('mr_dst');
    await replay({
      name: `it-${dest}`,
      source: {
        kind: 'table',
        connectionId: mongo,
        table,
        sort: [{ column: '_id', direction: 'asc' }],
      },
      destination: target(dest),
      delivery: { batchSize: 100 },
    });
    expect(await destRows('postgres_dest', dest)).toHaveLength(450);
  }, 180_000);

  it('…and in an order of the bridge’s own, which is kept', async () => {
    const table = await collection(people(450));
    const dest = uniqueTable('mr_dst');
    const job = await replay({
      name: `it-${dest}`,
      source: {
        kind: 'table',
        connectionId: mongo,
        table,
        sort: [{ column: 'id', direction: 'desc' }],
      },
      destination: target(dest),
      delivery: { batchSize: 1 },
    });
    expect(await destRows('postgres_dest', dest)).toHaveLength(450);
    const first = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: job.id, sequence: 0 },
    });
    expect(JSON.parse(first.rowKeysJson ?? '[]')).toHaveLength(1);
    expect(first.requestBody ?? '').toContain('row-450');
  }, 180_000);

  it('reads a collection whose `_id`s are of several kinds — numbers, text, ObjectIds — all of them', async () => {
    const docs = [
      ...Array.from({ length: 150 }, (_, i) => ({
        _id: i + 1,
        id: i + 1,
        name: 'number',
      })),
      ...Array.from({ length: 150 }, (_, i) => ({
        _id: `key-${String(i).padStart(3, '0')}`,
        id: 1000 + i,
        name: 'text',
      })),
      // 24 hex characters that ARE text, beside real ObjectIds
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', id: 5000, name: 'hex-text' },
      ...Array.from({ length: 150 }, (_, i) => ({
        id: 2000 + i,
        name: 'objectid',
      })),
    ];
    const table = await collection(docs);
    const dest = uniqueTable('mr_dst');
    await replay({
      name: `it-${dest}`,
      source: { kind: 'table', connectionId: mongo, table },
      destination: target(dest),
      delivery: { batchSize: 100, pageSize: 100 },
    });
    const rows = await destRows('postgres_dest', dest);
    expect(rows).toHaveLength(451);
    const kinds = rows.reduce<Record<string, number>>(
      (n, r) => ({ ...n, [String(r.name)]: (n[String(r.name)] ?? 0) + 1 }),
      {},
    );
    expect(kinds).toEqual({
      number: 150,
      text: 150,
      'hex-text': 1,
      objectid: 150,
    });
  }, 180_000);

  it('applies TWO conditions on one column: the second used to replace the first', async () => {
    const table = await collection(people(180));
    const dest = uniqueTable('mr_dst');
    await replay({
      name: `it-${dest}`,
      source: {
        kind: 'table',
        connectionId: mongo,
        table,
        filters: [
          { column: 'age', operator: 'gte', value: 18 },
          { column: 'age', operator: 'lt', value: 65 },
        ],
      },
      destination: target(dest),
      delivery: { batchSize: 100 },
    });
    const ids = (await destRows('postgres_dest', dest)).map((r) =>
      Number(r.id),
    );
    const want = people(180)
      .filter((p) => p.age >= 18 && p.age < 65)
      .map((p) => p.id);
    expect(ids).toEqual(want);
  }, 180_000);

  it('delivers the rows that were PICKED (the builder’s row selection is a list of `_id`s as the grid shows them)', async () => {
    const table = await collection(people(30));
    const shown = await withAdapter('mongodb', (a) =>
      a.browse({ table, limit: 30, offset: 0 }),
    );
    const picked = shown.rows
      .filter((r) => [3, 7, 21].includes(Number(r.id)))
      .map((r) => r._id);
    expect(
      picked.every((id) => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id)),
    ).toBe(true);
    const dest = uniqueTable('mr_dst');
    await replay({
      name: `it-${dest}`,
      source: {
        kind: 'table',
        connectionId: mongo,
        table,
        filters: [{ column: '_id', operator: 'in', value: picked }],
      },
      destination: target(dest),
    });
    expect(
      (await destRows('postgres_dest', dest)).map((r) => Number(r.id)),
    ).toEqual([3, 7, 21]);
  }, 180_000);
});

describe('a dead letter of a MongoDB bridge', () => {
  it('is retried against the document as it is NOW — which has to be found first', async () => {
    const table = await collection([{ id: 1, name: 'fine' }]);
    const dest = uniqueTable('mr_dl');
    await withAdapter('postgres_dest', (a) =>
      a.query(
        `CREATE TABLE "${dest}" (id integer PRIMARY KEY, name text, CONSTRAINT "${dest}_ok" CHECK (name <> 'POISON'))`,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const { DeadLetterService } =
      await import('../../src/bridges/dead-letter.service');
    const deadLetters = app.ctx.get(DeadLetterService);
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-${dest}`,
        source: { kind: 'table', connectionId: mongo, table },
        destination: target(dest, { createMissingTable: false }),
        transform: { template: '{{$row}}' },
        delivery: { onError: 'continue' },
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });
    await app.cdc.start(bridge.id);
    await withAdapter('mongodb', (a) =>
      a.insertRow({ table, values: { id: 2, name: 'POISON' } }),
    );
    await waitFor('the dead letter', async () =>
      (await app.prisma.bridgeDeadLetter.count({
        where: { bridgeId: bridge.id, status: 'pending' },
      })) === 1
        ? true
        : null,
    );

    // stopped, so that what delivers the corrected document is the retry
    await app.cdc.stop(bridge.id);
    await withAdapter('mongodb', (a) =>
      a.updateRow({ table, identity: { id: 2 }, changes: { name: 'cured' } }),
    );
    expect(await deadLetters.retry(bridge.id, { force: false })).toMatchObject({
      resolved: 1,
      stillFailing: 0,
    });
    // not "resolved" by taking the document for deleted: it is THERE
    expect(
      (await destRows('postgres_dest', dest)).map((r) => [
        Number(r.id),
        r.name,
      ]),
    ).toContainEqual([2, 'cured']);
  }, 180_000);
});
