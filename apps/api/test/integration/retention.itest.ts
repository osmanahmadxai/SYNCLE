/**
 * Delivery history retention, against the real metadata store.
 *
 * The rows here are written straight into the store rather than produced by
 * running bridges: what matters is WHICH rows a sweep removes, and that needs
 * deliveries with dates in the past, in numbers, under jobs in particular
 * states — none of which a real run can be asked for.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

let app: AppHandle;
let retention: any;
let settings: any;
let jobs: any;
let conn: string;

const DAY = 86_400_000;
const NOW = new Date('2026-09-17T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

beforeAll(async () => {
  app = await bootstrapApp();
  const { RetentionService } =
    await import('../../src/bridges/retention.service');
  const { SettingsStoreService } =
    await import('../../src/settings/settings-store.service');
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  retention = app.ctx.get(RetentionService);
  settings = app.ctx.get(SettingsStoreService);
  jobs = app.ctx.get(BridgeJobService);
  conn = await connectionFor(app, 'postgres');
}, 120_000);

afterAll(async () => {
  await settings
    ?.update({ deliveryRetentionDays: 30, deliveryMaxPerJob: 100_000 })
    .catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

beforeEach(async () => {
  // every test starts from a store with no jobs, so counts are exact
  await app.prisma.bridgeDeadLetter.deleteMany({});
  await app.prisma.bridgeDelivery.deleteMany({});
  await app.prisma.bridgeJob.deleteMany({});
  await settings.update({
    deliveryRetentionDays: 30,
    deliveryMaxPerJob: 100_000,
  });
});

async function makeBridge(kind: 'replay' | 'cdc' | 'watch'): Promise<string> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const trigger =
    kind === 'replay'
      ? { kind: 'replay' }
      : kind === 'cdc'
        ? { kind: 'cdc', operations: ['insert'] }
        : { kind: 'watch', strategy: { strategy: 'increment', column: 'id' } };
  const created = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-retention-${randomUUID().slice(0, 8)}`,
      source: { kind: 'table', connectionId: conn, table: 'whatever' },
      destination: { kind: 'http', url: 'https://example.test/hook' },
      transform: {},
      trigger,
    }),
  );
  return created.id;
}

async function makeJob(
  bridgeId: string,
  opts: {
    status: string;
    finishedAt?: Date | null;
    startedAt?: Date;
    failedCount?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await app.prisma.bridgeJob.create({
    data: {
      id,
      bridgeId,
      status: opts.status,
      configSnapshotJson: await app.bridges.snapshotJson(bridgeId),
      startedAt: opts.startedAt ?? daysAgo(90),
      finishedAt: opts.finishedAt === undefined ? null : opts.finishedAt,
      failedCount: opts.failedCount ?? 0,
      sentCount: 7,
    },
  });
  return id;
}

/** `count` deliveries, sequences from `from`, one per minute starting at `at` */
async function deliveries(
  jobId: string,
  opts: { from?: number; count: number; at: Date; status?: string },
): Promise<void> {
  const from = opts.from ?? 0;
  await app.prisma.bridgeDelivery.createMany({
    data: Array.from({ length: opts.count }, (_, i) => ({
      id: randomUUID(),
      jobId,
      sequence: from + i,
      rowIndex: from + i,
      rowCount: 1,
      status: opts.status ?? 'success',
      attempts: 1,
      requestBody: '{"id":1}',
      createdAt: new Date(opts.at.getTime() + i * 60_000),
    })),
  });
}

const sequencesOf = async (jobId: string): Promise<number[]> =>
  (
    await app.prisma.bridgeDelivery.findMany({
      where: { jobId },
      select: { sequence: true },
      orderBy: { sequence: 'asc' },
    })
  ).map((d: { sequence: number }) => d.sequence);

const jobRow = (jobId: string) =>
  app.prisma.bridgeJob.findUniqueOrThrow({ where: { id: jobId } });

describe('a finished replay', () => {
  it('loses its delivery details once the JOB is older than the retention — all at once', async () => {
    const bridge = await makeBridge('replay');
    const old = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(45),
    });
    const recent = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(3),
      startedAt: daysAgo(3),
    });
    await deliveries(old, { count: 40, at: daysAgo(45) });
    await deliveries(recent, { count: 12, at: daysAgo(3) });

    const result = await retention.sweep(NOW);
    expect(result).toMatchObject({
      expiredDeliveries: 40,
      jobsEmptied: 1,
      overflowDeliveries: 0,
      limited: false,
    });
    expect(await sequencesOf(old)).toEqual([]);
    expect((await sequencesOf(recent)).length).toBe(12);

    // the numbers on screen do not change, and the job knows what is gone
    const row = await jobRow(old);
    expect(row).toMatchObject({
      sentCount: 7,
      prunedDeliveries: 40,
      prunedBelowSequence: 40,
    });
    const dto = (await jobs.listJobs(bridge)).find(
      (j: { id: string }) => j.id === old,
    );
    expect(dto).toMatchObject({
      prunedDeliveries: 40,
      prunedBelowSequence: 40,
      sentCount: 7,
    });
  });

  it('is not emptied row by row: a job that finished recently keeps even its oldest rows', async () => {
    const bridge = await makeBridge('replay');
    // a long run: started 40 days ago, finished yesterday
    const job = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(1),
      startedAt: daysAgo(40),
    });
    await deliveries(job, { count: 10, at: daysAgo(40) });
    await retention.sweep(NOW);
    expect((await sequencesOf(job)).length).toBe(10);
  });

  it('is left entirely alone while it is queued or running', async () => {
    const bridge = await makeBridge('replay');
    const running = await makeJob(bridge, {
      status: 'running',
      finishedAt: null,
    });
    // resumed after failing long ago: whatever its finish date still says, it
    // is running NOW, and that is what decides
    const resumed = await makeJob(bridge, {
      status: 'queued',
      finishedAt: daysAgo(50),
    });
    await deliveries(running, { count: 10, at: daysAgo(60) });
    await deliveries(resumed, { count: 10, at: daysAgo(60) });
    await retention.sweep(NOW);
    // they are its guard against delivering a sequence twice after a crash
    expect((await sequencesOf(running)).length).toBe(10);
    expect((await sequencesOf(resumed)).length).toBe(10);
  });

  it('says why a retry is impossible, instead of "no failed rows"', async () => {
    const bridge = await makeBridge('replay');
    const job = await makeJob(bridge, {
      status: 'failed',
      finishedAt: daysAgo(45),
      failedCount: 3,
    });
    await deliveries(job, { count: 3, at: daysAgo(45), status: 'failed' });
    await retention.sweep(NOW);
    await expect(jobs.resendFailed(bridge, job)).rejects.toThrow(
      /delivery details have been removed.*3 failed deliveries/s,
    );
  });
});

describe('a live job', () => {
  it('loses only the rows older than the retention, and remembers where they ended', async () => {
    const bridge = await makeBridge('cdc');
    const job = await makeJob(bridge, { status: 'running', finishedAt: null });
    await deliveries(job, { from: 0, count: 25, at: daysAgo(40) });
    await deliveries(job, { from: 25, count: 15, at: daysAgo(2) });

    const result = await retention.sweep(NOW);
    expect(result.expiredDeliveries).toBe(25);
    expect(await sequencesOf(job)).toEqual(
      Array.from({ length: 15 }, (_, i) => 25 + i),
    );
    expect(await jobRow(job)).toMatchObject({
      prunedDeliveries: 25,
      prunedBelowSequence: 25,
    });
  });

  it('a paused one is treated the same — it is still the bridge’s one job', async () => {
    const bridge = await makeBridge('watch');
    const job = await makeJob(bridge, {
      status: 'paused',
      finishedAt: daysAgo(35),
    });
    await deliveries(job, { from: 0, count: 5, at: daysAgo(50) });
    await deliveries(job, { from: 5, count: 5, at: daysAgo(36) });
    await deliveries(job, { from: 10, count: 5, at: daysAgo(1) });
    await retention.sweep(NOW);
    expect(await sequencesOf(job)).toEqual([10, 11, 12, 13, 14]);
  });

  it('keeps at most the newest N, however recent they are', async () => {
    await settings.update({ deliveryMaxPerJob: 100 });
    const bridge = await makeBridge('cdc');
    const job = await makeJob(bridge, { status: 'running', finishedAt: null });
    await deliveries(job, { count: 350, at: daysAgo(0.2) });

    const result = await retention.sweep(NOW);
    expect(result).toMatchObject({
      expiredDeliveries: 0,
      overflowDeliveries: 250,
    });
    const left = await sequencesOf(job);
    expect(left.length).toBe(100);
    expect(left[0]).toBe(250);
    expect(left.at(-1)).toBe(349);
    // a second sweep has nothing to do
    expect((await retention.sweep(NOW)).overflowDeliveries).toBe(0);
  });

  it('the cap does not apply to a replay, whose grid would get holes', async () => {
    await settings.update({ deliveryMaxPerJob: 100 });
    const bridge = await makeBridge('replay');
    const job = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(1),
      startedAt: daysAgo(1),
    });
    await deliveries(job, { count: 300, at: daysAgo(1) });
    await retention.sweep(NOW);
    expect((await sequencesOf(job)).length).toBe(300);
  });

  it('never removes a failed delivery whose rows still wait in the dead-letter queue', async () => {
    await settings.update({ deliveryMaxPerJob: 100 });
    const bridge = await makeBridge('cdc');
    const job = await makeJob(bridge, { status: 'running', finishedAt: null });
    await deliveries(job, {
      from: 0,
      count: 5,
      at: daysAgo(60),
      status: 'failed',
    });
    await deliveries(job, { from: 5, count: 300, at: daysAgo(0.2) });
    const parked = (sequence: number, status: string) =>
      app.prisma.bridgeDeadLetter.create({
        data: {
          id: randomUUID(),
          bridgeId: bridge,
          jobId: job,
          sequence,
          rowsJson: '[{"id":1}]',
          rowCount: 1,
          status,
          createdAt: daysAgo(60),
          resolvedAt: status === 'pending' ? null : daysAgo(50),
        },
      });
    await parked(1, 'pending');
    await parked(3, 'pending');
    await parked(2, 'resolved');
    await parked(4, 'discarded');

    const result = await retention.sweep(NOW);
    const left = await sequencesOf(job);
    // 1 and 3 are where a retry reports back to: too old AND over the cap, and still there
    expect(left.slice(0, 2)).toEqual([1, 3]);
    expect(left.length).toBe(2 + 100);
    // the settled dead letters were only a record; the pending ones are data
    expect(result.deadLetters).toBe(2);
    const stillParked = await app.prisma.bridgeDeadLetter.findMany({
      where: { jobId: job },
    });
    expect(
      stillParked.map((d: { sequence: number }) => d.sequence).sort(),
    ).toEqual([1, 3]);
  });

  it('an older job of a bridge that was later made live is a finished replay, not "the live job"', async () => {
    const bridge = await makeBridge('cdc');
    const before = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(80),
      startedAt: daysAgo(81),
    });
    const live = await makeJob(bridge, {
      status: 'running',
      finishedAt: null,
      startedAt: daysAgo(10),
    });
    await deliveries(before, { count: 8, at: daysAgo(81) });
    await deliveries(live, { count: 4, at: daysAgo(5) });
    const result = await retention.sweep(NOW);
    expect(result.jobsEmptied).toBe(1);
    expect(await jobRow(before)).toMatchObject({ prunedBelowSequence: 8 });
    expect((await sequencesOf(live)).length).toBe(4);
  });
});

describe('the settings', () => {
  it('0 days keeps everything for ever; 0 rows means no cap', async () => {
    await settings.update({ deliveryRetentionDays: 0, deliveryMaxPerJob: 0 });
    const replay = await makeBridge('replay');
    const old = await makeJob(replay, {
      status: 'completed',
      finishedAt: daysAgo(900),
    });
    await deliveries(old, { count: 5, at: daysAgo(900) });
    const cdc = await makeBridge('cdc');
    const live = await makeJob(cdc, { status: 'running', finishedAt: null });
    await deliveries(live, { count: 400, at: daysAgo(900) });

    expect(await retention.sweep(NOW)).toEqual({
      expiredDeliveries: 0,
      overflowDeliveries: 0,
      deadLetters: 0,
      jobsEmptied: 0,
      limited: false,
    });
    expect((await sequencesOf(old)).length).toBe(5);
    expect((await sequencesOf(live)).length).toBe(400);
  });

  it('take effect on the next sweep, without a restart', async () => {
    const bridge = await makeBridge('replay');
    const job = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(10),
      startedAt: daysAgo(10),
    });
    await deliveries(job, { count: 6, at: daysAgo(10) });
    expect((await retention.sweep(NOW)).expiredDeliveries).toBe(0);
    await settings.update({ deliveryRetentionDays: 7 });
    expect((await retention.sweep(NOW)).expiredDeliveries).toBe(6);
  });

  it('reject nonsense', async () => {
    await expect(
      settings.update({ deliveryRetentionDays: -1 }),
    ).rejects.toThrow();
    await expect(settings.update({ deliveryMaxPerJob: 1.5 })).rejects.toThrow();
  });
});

describe('a large backlog', () => {
  it('goes in batches, and the job’s record is right after every one', async () => {
    const bridge = await makeBridge('replay');
    const job = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(45),
    });
    for (let from = 0; from < 5000; from += 1000)
      await deliveries(job, { from, count: 1000, at: daysAgo(45) });
    const result = await retention.sweep(NOW);
    expect(result.expiredDeliveries).toBe(5000);
    expect(await jobRow(job)).toMatchObject({
      prunedDeliveries: 5000,
      prunedBelowSequence: 5000,
    });
  });

  it('two sweeps at once are one sweep', async () => {
    const bridge = await makeBridge('replay');
    const job = await makeJob(bridge, {
      status: 'completed',
      finishedAt: daysAgo(45),
    });
    await deliveries(job, { count: 50, at: daysAgo(45) });
    const [a, b] = await Promise.all([
      retention.sweep(NOW),
      retention.sweep(NOW),
    ]);
    expect(a).toBe(b);
    expect(a.expiredDeliveries).toBe(50);
  });
});
