/**
 * A replay bridge with a cron line: the scheduler in Redis follows the bridge,
 * a tick starts a FRESH run and never a second one beside a running one — and,
 * once, the real thing: a line that fires every minute is left to fire.
 */
import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let controller: any;
let schedule: any;
let jobs: any;
let queue: Queue;
let pg: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { BridgeScheduleService } =
    await import('../../src/bridges/bridge-schedule.service');
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  const { BRIDGE_SCHEDULE_QUEUE } =
    await import('../../src/bridges/bridges.types');
  controller = app.ctx.get(BridgesController);
  schedule = app.ctx.get(BridgeScheduleService);
  jobs = app.ctx.get(BridgeJobService);
  queue = app.ctx.get(getQueueToken(BRIDGE_SCHEDULE_QUEUE));
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));
const scheduler = (id: string) => queue.getJobScheduler(`schedule_${id}`);
const jobsOf = (bridgeId: string) =>
  app.prisma.bridgeJob.findMany({
    where: { bridgeId, status: { not: 'draft' } },
    orderBy: { startedAt: 'asc' },
  });
const finished = (jobId: string) =>
  waitFor('the run to end', async () => {
    const j = await app.prisma.bridgeJob.findUnique({ where: { id: jobId } });
    return j && ['completed', 'failed', 'canceled'].includes(j.status)
      ? j
      : null;
  });

async function make(
  opts: {
    cron?: string | null;
    timezone?: string;
    rows?: number;
    delivery?: Record<string, unknown>;
    enabled?: boolean;
  } = {},
) {
  const source = uniqueTable('sch_src');
  const dest = uniqueTable('sch_dst');
  await src(
    `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" SELECT g, 'n' || g FROM generate_series(1, ${opts.rows ?? 3}) g`,
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
  const input = bridgeInputSchema.parse({
    name: `it-sch-${source}`,
    source: { kind: 'table', connectionId: pg, table: source },
    destination: {
      kind: 'database',
      targets: [
        {
          connectionId: pgDest,
          table: dest,
          keyColumns: ['id'],
          createMissingTable: true,
        },
      ],
    },
    transform: { template: '{{$row}}' },
    delivery: opts.delivery ?? {},
    enabled: opts.enabled ?? true,
    trigger:
      opts.cron === null
        ? { kind: 'replay' }
        : {
            kind: 'replay',
            schedule: {
              cron: opts.cron ?? '0 3 * * *',
              timezone: opts.timezone ?? 'UTC',
            },
          },
  });
  const bridge = await controller.create(input);
  cleanups.push(() => controller.remove(bridge.id).then(() => undefined));
  return { id: bridge.id as string, source, dest, input };
}

describe('the scheduler in Redis follows the bridge', () => {
  it('saved with a line: registered, in its zone, and the page knows when it fires next', async () => {
    const b = await make({ cron: '30 2 * * *', timezone: 'Asia/Kabul' });
    expect(await scheduler(b.id)).toMatchObject({
      pattern: '30 2 * * *',
      tz: 'Asia/Kabul',
    });
    const status = await controller.scheduleStatus(b.id);
    expect(status).toMatchObject({
      active: true,
      lastTickAt: null,
      lastOutcome: null,
      schedule: { cron: '30 2 * * *', timezone: 'Asia/Kabul', enabled: true },
    });
    expect(status.nextRuns).toHaveLength(3);
    // 02:30 in Kabul (+04:30, no summer time) is 22:00 UTC the day before
    for (const at of status.nextRuns) expect(at).toMatch(/T22:00:00\.000Z$/);
    expect(new Date(status.nextRuns[0]).getTime()).toBeGreaterThan(Date.now());
    expect(new Date((await scheduler(b.id))!.next!).toISOString()).toBe(
      status.nextRuns[0],
    );
  });

  it('edited: a new line replaces the old; switched off, the bridge disabled, or no longer scheduled — it is gone', async () => {
    const b = await make({ cron: '0 3 * * *' });
    const withSchedule = (
      schedule: unknown,
      over: Record<string, unknown> = {},
    ) =>
      controller.update(b.id, {
        ...b.input,
        ...over,
        trigger: schedule ? { kind: 'replay', schedule } : { kind: 'replay' },
      });

    await withSchedule({
      cron: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
    });
    expect(await scheduler(b.id)).toMatchObject({ pattern: '*/10 * * * *' });

    await withSchedule({
      cron: '*/10 * * * *',
      timezone: 'UTC',
      enabled: false,
    });
    expect(await scheduler(b.id)).toBeFalsy();
    expect(await controller.scheduleStatus(b.id)).toMatchObject({
      active: false,
      nextRuns: [],
      schedule: { enabled: false },
    });

    await withSchedule({
      cron: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
    });
    expect(await scheduler(b.id)).toBeTruthy();
    await withSchedule(
      { cron: '*/10 * * * *', timezone: 'UTC', enabled: true },
      { enabled: false },
    );
    expect(await scheduler(b.id)).toBeFalsy();

    await withSchedule(
      { cron: '*/10 * * * *', timezone: 'UTC', enabled: true },
      { enabled: true },
    );
    expect(await scheduler(b.id)).toBeTruthy();
    await withSchedule(null);
    expect(await scheduler(b.id)).toBeFalsy();
    expect(await controller.scheduleStatus(b.id)).toMatchObject({
      schedule: null,
      active: false,
      nextRuns: [],
    });
  });

  it('deleted: the scheduler goes with it', async () => {
    const b = await make({});
    expect(await scheduler(b.id)).toBeTruthy();
    await controller.remove(b.id);
    expect(await scheduler(b.id)).toBeFalsy();
  });

  it('a line is refused with the reason — by the schema, and by the preview', async () => {
    const { bridgeInputSchema, replayScheduleSchema } =
      await import('@syncle/core');
    const bad = bridgeInputSchema.safeParse({
      ...(await make({ cron: null })).input,
      trigger: { kind: 'replay', schedule: { cron: '0 25 * * *' } },
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error!.issues)).toMatch(/is not a hour/);
    const preview = controller.schedulePreview(
      replayScheduleSchema.parse({
        cron: '0 9 * * mon-fri',
        timezone: 'Europe/Rome',
      }),
    );
    expect(preview.nextRuns).toHaveLength(5);
    for (const at of preview.nextRuns) {
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Rome',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(at));
      expect(local).toMatch(/^(Mon|Tue|Wed|Thu|Fri),? 09:00$/);
    }
  });

  it('at boot: a scheduler nobody wants is removed, one that is missing is put back', async () => {
    const b = await make({ cron: '0 4 * * *' });
    await queue.removeJobScheduler(`schedule_${b.id}`);
    await queue.upsertJobScheduler(
      'schedule_no-such-bridge',
      { pattern: '0 5 * * *' },
      { name: 'tick', data: { bridgeId: 'no-such-bridge' } },
    );
    const result = await schedule.reconcile();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await queue.getJobScheduler('schedule_no-such-bridge')).toBeFalsy();
    expect(await scheduler(b.id)).toMatchObject({ pattern: '0 4 * * *' });
  });
});

describe('a tick', () => {
  it('starts a run, marked as the schedule’s — and the rows arrive', async () => {
    const b = await make({});
    expect(await schedule.tick(b.id)).toBe('started');
    const [job] = await jobsOf(b.id);
    expect(job).toMatchObject({ startedBy: 'schedule' });
    expect(await finished(job.id)).toMatchObject({
      status: 'completed',
      sentCount: 3,
    });
    expect(await destRows('postgres_dest', b.dest)).toHaveLength(3);
    expect(await controller.scheduleStatus(b.id)).toMatchObject({
      lastOutcome: 'started',
      lastError: null,
    });
    expect((await jobs.getJob(b.id, job.id)).startedBy).toBe('schedule');
    // a run somebody starts is theirs
    const manual = await jobs.start(b.id);
    expect(manual.startedBy).toBe('manual');
    await finished(manual.id);
  });

  it('never beside a run that is still going: skipped, said, and the next one starts again', async () => {
    const b = await make({
      rows: 6,
      delivery: { batchSize: 1, minDelayMs: 400 },
    });
    expect(await schedule.tick(b.id)).toBe('started');
    expect(await schedule.tick(b.id)).toBe('skipped-active');
    expect(await jobsOf(b.id)).toHaveLength(1);
    expect(await controller.scheduleStatus(b.id)).toMatchObject({
      lastOutcome: 'skipped-active',
    });
    await finished((await jobsOf(b.id))[0]!.id);
    expect(await schedule.tick(b.id)).toBe('started');
    expect(await jobsOf(b.id)).toHaveLength(2);
    await finished((await jobsOf(b.id))[1]!.id);
  });

  it('starts from the top: a run that stopped half-way is history, not something to pick up', async () => {
    const b = await make({
      rows: 4,
      delivery: { batchSize: 1, onError: 'abort' },
    });
    // the destination refuses row 3: the first run stops there
    await withAdapter('postgres_dest', (a) =>
      a.query(
        `CREATE TABLE "${b.dest}" (id integer PRIMARY KEY, name text CHECK (name <> 'n3'))`,
      ),
    );
    await schedule.tick(b.id);
    const first = await finished((await jobsOf(b.id))[0]!.id);
    // (the cursor is past the delivery that failed: that one is kept as failed, for "Retry failed")
    expect(first).toMatchObject({
      status: 'failed',
      sentCount: 2,
      failedCount: 1,
      cursorOffset: 3,
    });

    // pressing Run would resume THAT job. the schedule does not
    await src(`UPDATE "${b.source}" SET name = 'fixed' WHERE id = 3`);
    await src(`UPDATE "${b.source}" SET name = 'changed since' WHERE id = 1`);
    expect(await schedule.tick(b.id)).toBe('started');
    const all = await jobsOf(b.id);
    expect(all).toHaveLength(2);
    expect(all[1]!.id).not.toBe(first.id);
    expect(await finished(all[1]!.id)).toMatchObject({
      status: 'completed',
      sentCount: 4,
    });
    const rows = Object.fromEntries(
      (await destRows('postgres_dest', b.dest)).map((r) => [
        Number(r.id),
        r.name,
      ]),
    );
    // row 1 was before the point the first run stopped at: only a run from the top brings it up to date
    expect(rows).toEqual({ 1: 'changed since', 2: 'n2', 3: 'fixed', 4: 'n4' });
  });

  it('for a bridge that is gone, switched off or no longer scheduled: nothing, and the scheduler is retired', async () => {
    const b = await make({});
    await app.prisma.bridge.update({
      where: { id: b.id },
      data: { enabled: false },
    });
    expect(await schedule.tick(b.id)).toBe('gone');
    expect(await scheduler(b.id)).toBeFalsy();
    expect(await jobsOf(b.id)).toHaveLength(0);
    expect(await schedule.tick('no-such-bridge')).toBe('gone');
  });

  it('that cannot start a run says why, and is there to be seen', async () => {
    const b = await make({});
    // (a replay that turned into a live bridge behind the scheduler's back)
    const start = jobs.start.bind(jobs);
    jobs.start = async () => {
      throw new Error('The job queue (Redis) is unavailable.');
    };
    try {
      expect(await schedule.tick(b.id)).toBe('failed');
    } finally {
      jobs.start = start;
    }
    expect(await controller.scheduleStatus(b.id)).toMatchObject({
      lastOutcome: 'failed',
      lastError: 'The job queue (Redis) is unavailable.',
    });
  });
});

describe('a bridge that arrives with a schedule', () => {
  it('by import or as a copy: keeps the line, switched off — and says so', async () => {
    const b = await make({ cron: '15 1 * * *' });
    const copy = await controller.clone(b.id);
    cleanups.push(() => controller.remove(copy.id).then(() => undefined));
    expect(copy.trigger).toEqual({
      kind: 'replay',
      schedule: { cron: '15 1 * * *', timezone: 'UTC', enabled: false },
    });
    expect(await scheduler(copy.id)).toBeFalsy();

    const document = await controller.exportOne(b.id);
    const imported = await controller.importBridges({
      document,
      connectionMap: {},
    });
    for (const c of imported.created)
      cleanups.push(() => controller.remove(c.id).then(() => undefined));
    expect(imported.warnings.join(' ')).toMatch(
      /runs on a schedule \(15 1 \* \* \*\).*switched off/,
    );
    const saved = await app.bridges.get(imported.created[0]!.id);
    expect(saved.trigger).toMatchObject({
      schedule: { cron: '15 1 * * *', enabled: false },
    });
    expect(await scheduler(saved.id)).toBeFalsy();
    // the original is untouched
    expect(await scheduler(b.id)).toBeTruthy();
  });
});

describe('the real thing', () => {
  it('a line that fires every minute is left to fire: a run appears, started by the schedule', async () => {
    const b = await make({ cron: '* * * * *' });
    const job = await waitFor(
      'the minute to turn',
      async () =>
        (await jobsOf(b.id)).find(
          (j: { startedBy: string }) => j.startedBy === 'schedule',
        ) ?? null,
      { timeoutMs: 75_000, intervalMs: 500 },
    );
    expect(await finished(job.id)).toMatchObject({
      status: 'completed',
      sentCount: 3,
    });
    expect(await controller.scheduleStatus(b.id)).toMatchObject({
      lastOutcome: 'started',
    });
    // …and it is scheduled again, for the minute after
    expect(new Date((await scheduler(b.id))!.next!).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  }, 120_000);
});
