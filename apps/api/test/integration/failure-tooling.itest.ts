/**
 * What happens AFTER a delivery has failed: retrying all of them, retrying one,
 * and taking the failures away as a file.
 *
 * The first test is the reason the others were looked at closely. A replay
 * stops at a failure by default (on failure: abort). Fix the cause, press
 * "Retry failed" — and the failed delivery went through, the job turned
 * `completed`, and every row AFTER the failure, which the run had never reached,
 * was never sent. Nothing said so.
 */
import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let jobs: any;
let controller: any;
let pg: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  jobs = app.ctx.get(BridgeJobService);
  controller = app.ctx.get(BridgesController);
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));
const dst = (sql: string) => withAdapter('postgres_dest', (a) => a.query(sql));

/** a replay into a table that refuses the name POISON, over `rows` */
async function replayBridge(
  rows: string,
  onError: 'abort' | 'continue',
  batchSize = 1,
) {
  const source = uniqueTable('ft_src');
  const dest = uniqueTable('ft_dst');
  await src(
    `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES ${rows}`,
  );
  await dst(
    `CREATE TABLE "${dest}" (id integer PRIMARY KEY, name text, CONSTRAINT "${dest}_ok" CHECK (name <> 'POISON'))`,
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
  );
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-ft-${source}`,
      source: { kind: 'table', connectionId: pg, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            keyColumns: ['id'],
            mapping: [],
            createMissingTable: false,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      delivery: { onError, maxAttempts: 1, batchSize },
      trigger: { kind: 'replay' },
    }),
  );
  return { id: bridge.id as string, source, dest };
}

async function settled(jobId: string, ...statuses: string[]) {
  return waitFor(`job ${jobId} to be ${statuses.join('/')}`, async () => {
    const j = await app.prisma.bridgeJob.findUnique({ where: { id: jobId } });
    return j && statuses.includes(j.status) ? j : null;
  });
}

const ids = async (table: string) =>
  (await destRows('postgres_dest', table)).map((r) => Number(r.id));
const cure = (dest: string) =>
  dst(`ALTER TABLE "${dest}" DROP CONSTRAINT "${dest}_ok"`);

describe('a replay that stopped at a failure', () => {
  it('"Retry failed" sends the failed delivery — and then the rows the run never reached', async () => {
    const b = await replayBridge(
      `(1,'a'),(2,'POISON'),(3,'c'),(4,'d'),(5,'e')`,
      'abort',
    );
    const started = await jobs.start(b.id);
    const stopped = await settled(started.id, 'failed');
    expect(stopped.error).toMatch(/onError=abort/);
    expect(await ids(b.dest)).toEqual([1]);

    await cure(b.dest);
    await controller.retryFailed(b.id, started.id);
    const done = await settled(started.id, 'completed', 'failed');
    expect(done.status).toBe('completed');
    expect(done.failedCount).toBe(0);
    // 3, 4 and 5 were never attempted by the first run. "completed" has to mean them too
    expect(await ids(b.dest)).toEqual([1, 2, 3, 4, 5]);
    // and no delivery was made twice
    const deliveries = await app.prisma.bridgeDelivery.findMany({
      where: { jobId: started.id },
      orderBy: { sequence: 'asc' },
    });
    expect(deliveries.map((d: any) => [d.sequence, d.status])).toEqual(
      [0, 1, 2, 3, 4].map((s) => [s, 'success']),
    );
  }, 120_000);

  it('…and stops again, at the NEXT failure, without going past it', async () => {
    const b = await replayBridge(
      `(1,'a'),(2,'POISON'),(3,'c'),(4,'POISON'),(5,'e')`,
      'abort',
    );
    const started = await jobs.start(b.id);
    await settled(started.id, 'failed');
    // only row 2 is put right at the source; row 4 is still what the target refuses
    await src(`UPDATE "${b.source}" SET name = 'b' WHERE id = 2`);
    // (the captured payload of the failed delivery still says POISON: re-sent as it was, it fails again)
    await controller.retryFailed(b.id, started.id);
    const again = await settled(started.id, 'completed', 'failed');
    expect(again.status).toBe('failed');
    expect(await ids(b.dest)).toEqual([1]);
  }, 120_000);

  it('a run that DID read to the end (on failure: continue) just completes: nothing is read twice', async () => {
    const b = await replayBridge(`(1,'a'),(2,'POISON'),(3,'c')`, 'continue');
    const started = await jobs.start(b.id);
    const first = await settled(started.id, 'completed');
    expect(first.failedCount).toBe(1);
    expect(await ids(b.dest)).toEqual([1, 3]);
    expect(await jobs.streamedToEnd(started.id)).toBe(true);

    await cure(b.dest);
    await controller.retryFailed(b.id, started.id);
    const done = await settled(started.id, 'completed', 'failed');
    expect(done).toMatchObject({ status: 'completed', failedCount: 0 });
    expect(await ids(b.dest)).toEqual([1, 2, 3]);
    const deliveries = await app.prisma.bridgeDelivery.count({
      where: { jobId: started.id },
    });
    expect(deliveries).toBe(3);
  }, 120_000);
});

describe('retrying ONE delivery', () => {
  it('re-sends that one and leaves the others as they are', async () => {
    const b = await replayBridge(
      `(1,'a'),(2,'POISON'),(3,'c'),(4,'POISON')`,
      'continue',
    );
    const started = await jobs.start(b.id);
    await settled(started.id, 'completed');
    await cure(b.dest);

    const retried = await controller.retryDelivery(b.id, started.id, '1');
    expect(retried).toMatchObject({
      sequence: 1,
      status: 'success',
      error: null,
    });
    expect(await ids(b.dest)).toEqual([1, 2, 3]);
    const job = await app.prisma.bridgeJob.findUnique({
      where: { id: started.id },
    });
    expect(job).toMatchObject({ status: 'completed', failedCount: 1 });
    const other = await app.prisma.bridgeDelivery.findUnique({
      where: { jobId_sequence: { jobId: started.id, sequence: 3 } },
    });
    expect(other.status).toBe('failed');
  }, 120_000);

  it('says what it cannot do: not a failed delivery, no such delivery, a job that is still running', async () => {
    const b = await replayBridge(`(1,'a'),(2,'POISON')`, 'continue');
    const started = await jobs.start(b.id);
    await settled(started.id, 'completed');
    await expect(
      controller.retryDelivery(b.id, started.id, '0'),
    ).rejects.toThrow(
      /Only a failed delivery can be retried; this one is success/,
    );
    await expect(
      controller.retryDelivery(b.id, started.id, '99'),
    ).rejects.toThrow(/not found/i);
    await expect(
      controller.retryDelivery(b.id, started.id, 'abc'),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      controller.retryDelivery('another-bridge', started.id, '1'),
    ).rejects.toThrow(/not found/i);

    await app.prisma.bridgeJob.update({
      where: { id: started.id },
      data: { status: 'running' },
    });
    await expect(
      controller.retryDelivery(b.id, started.id, '1'),
    ).rejects.toThrow(/still active/);
    await app.prisma.bridgeJob.update({
      where: { id: started.id },
      data: { status: 'completed' },
    });
  }, 120_000);

  it('when it was the failure a replay had stopped at, the replay carries on', async () => {
    const b = await replayBridge(
      `(1,'a'),(2,'POISON'),(3,'c'),(4,'d')`,
      'abort',
    );
    const started = await jobs.start(b.id);
    await settled(started.id, 'failed');
    await cure(b.dest);
    await controller.retryDelivery(b.id, started.id, '1');
    const done = await settled(started.id, 'completed');
    expect(done.failedCount).toBe(0);
    expect(await ids(b.dest)).toEqual([1, 2, 3, 4]);
  }, 120_000);

  it('on a live bridge, retries the rows from the dead-letter queue — re-read from the source, as they are now', async () => {
    const source = uniqueTable('ft_live');
    const dest = uniqueTable('ft_live_dst');
    await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
    await dst(
      `CREATE TABLE "${dest}" (id integer PRIMARY KEY, name text, CONSTRAINT "${dest}_ok" CHECK (name <> 'POISON'))`,
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-ft-${source}`,
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: [],
              createMissingTable: false,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        delivery: { onError: 'continue', maxAttempts: 1 },
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });
    await app.cdc.start(bridge.id);
    await src(`INSERT INTO "${source}" VALUES (1, 'POISON')`);
    const letter = await waitFor('the dead letter', () =>
      app.prisma.bridgeDeadLetter.findFirst({
        where: { bridgeId: bridge.id, status: 'pending' },
      }),
    );
    // stopped, so that what delivers the corrected row is the retry
    await app.cdc.stop(bridge.id);
    await src(`UPDATE "${source}" SET name = 'cured' WHERE id = 1`);

    // the bridge's job is paused, not finished — and this still works: the queue owns these rows
    const retried = await controller.retryDelivery(
      bridge.id,
      letter.jobId,
      String(letter.sequence),
    );
    expect(retried.status).toBe('success');
    expect(
      (await destRows('postgres_dest', dest)).map((r) => [
        Number(r.id),
        r.name,
      ]),
    ).toEqual([[1, 'cured']]);
    expect(
      await app.prisma.bridgeDeadLetter.count({
        where: { bridgeId: bridge.id, status: 'pending' },
      }),
    ).toBe(0);
  }, 120_000);
});

describe('taking the failures away as a file', () => {
  /** the download handler writes to an HTTP response: give it a real one */
  async function download(
    bridgeId: string,
    jobId: string,
    format?: string,
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    const server = http.createServer((_req, res) => {
      controller
        .downloadFailures(bridgeId, jobId, format, res as never)
        .catch((err: Error) => {
          res.statusCode = 400;
          res.end(err.message);
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      );
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: await res.text(),
      };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it('CSV: one line per failed delivery, with the rows’ keys, the error and what was sent', async () => {
    const b = await replayBridge(
      `(1,'a'),(2,'POISON'),(3,'=HYPERLINK("http://evil.example","x")'),(4,'POISON')`,
      'continue',
      2,
    );
    const started = await jobs.start(b.id);
    await settled(started.id, 'completed');
    const res = await download(b.id, started.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="syncle-failures-${started.id}.csv"`,
    );

    const lines = res.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'sequence,operation,rows,row_keys,attempts,http_status,error,at,payload',
    );
    // both batches hold a POISON row: both failed, whole
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^0,,2,"\[1,2\]",1,,/);
    expect(lines[2]).toMatch(/^1,,2,"\[3,4\]",1,,/);
    expect(res.body).toContain('violates check constraint');
    // the payload is there, as JSON in one cell, quotes doubled
    expect(lines[1]).toContain('""name"":""POISON""');
  }, 120_000);

  it('NDJSON: the same, one object per line', async () => {
    const b = await replayBridge(`(1,'a'),(2,'POISON')`, 'continue');
    const started = await jobs.start(b.id);
    await settled(started.id, 'completed');
    const res = await download(b.id, started.id, 'ndjson');
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const records = res.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sequence: 1,
      rows: 1,
      row_keys: [2],
      attempts: 1,
      http_status: null,
    });
    expect(records[0].error).toMatch(/check constraint/);
    // (one row per delivery here, so the payload is the row itself)
    expect(JSON.parse(records[0].payload)).toEqual({ id: 2, name: 'POISON' });
  }, 120_000);

  it('a job with no failures is a header and nothing else; an unknown format is refused', async () => {
    const b = await replayBridge(`(1,'a')`, 'continue');
    const started = await jobs.start(b.id);
    await settled(started.id, 'completed');
    expect((await download(b.id, started.id)).body).toBe(
      'sequence,operation,rows,row_keys,attempts,http_status,error,at,payload\r\n',
    );
    expect((await download(b.id, started.id, 'ndjson')).body).toBe('');
    const bad = await download(b.id, started.id, 'xlsx');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatch(/csv.*ndjson/);
  }, 120_000);
});
