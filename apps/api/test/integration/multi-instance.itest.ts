/**
 * Two API processes on one database and one Redis.
 *
 * Nothing stopped anybody from running two, and nothing made it safe: each
 * resumed every live CDC bridge at boot and kept the stream in a table of its
 * own — two readers per bridge. Here two whole applications are started side by
 * side (each with its own services, its own stream table, its own workers) and
 * what is looked at is what a person would see: a change is delivered ONCE,
 * whichever process was asked to start the bridge; "stop" stops it, whichever
 * process was asked; and when the process that was reading goes away, the other
 * one carries on from where it was.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { sleep, uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

interface Node {
  app: AppHandle;
  instance: any;
  cdc: any;
  streams: Map<string, unknown>;
  closed: boolean;
}

const nodes: Node[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function node(standby: boolean): Promise<Node> {
  const app = await bootstrapApp({ standby });
  const { InstanceService } = await import('../../src/common/instance.service');
  const n: Node = {
    app,
    instance: app.ctx.get(InstanceService),
    cdc: app.cdc,
    streams: (app.cdc as { streams: Map<string, unknown> }).streams,
    closed: false,
  };
  nodes.push(n);
  return n;
}

async function close(n: Node): Promise<void> {
  if (n.closed) return;
  n.closed = true;
  await n.app.ctx.close().catch(() => undefined);
}

afterEach(async () => {
  // (the cleanups go through whichever process is still up)
  for (const fn of cleanups.splice(0).reverse())
    await fn().catch(() => undefined);
  for (const n of nodes.splice(0)) await close(n);
}, 120_000);

const pg = (sql: string) => withAdapter('postgres', (a) => a.query(sql));

/** a live CDC bridge, created through `via`, NOT started */
async function bridge(
  via: Node,
): Promise<{ id: string; source: string; target: string }> {
  const source = uniqueTable('mi_src');
  const target = uniqueTable('mi_dst');
  await pg(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
  const { bridgeInputSchema } = await import('@syncle/core');
  const created = await via.app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-mi-${source}`,
      source: {
        kind: 'table',
        connectionId: await connectionFor(via.app, 'postgres'),
        table: source,
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: await connectionFor(via.app, 'postgres_dest'),
            table: target,
            keyColumns: ['id'],
          },
        ],
      },
      transform: { template: '{{$row}}' },
      trigger: {
        kind: 'cdc',
        operations: ['insert', 'update', 'delete'],
        startFrom: 'now',
      },
    }),
  );
  cleanups.push(async () => {
    const up = nodes.find((n) => !n.closed);
    await up?.cdc.stop(created.id).catch(() => undefined);
    await up?.cdc.cleanup(created.id).catch(() => undefined);
    await withAdapter('postgres', (a) => a.dropTable(source)).catch(
      () => undefined,
    );
    await withAdapter('postgres_dest', (a) => a.dropTable(target)).catch(
      () => undefined,
    );
  });
  return { id: created.id as string, source, target };
}

async function deliveries(n: Node, bridgeId: string): Promise<number> {
  const job = await n.app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });
  return job
    ? n.app.prisma.bridgeDelivery.count({
        where: { jobId: job.id, status: 'success' },
      })
    : 0;
}

describe('two processes, one of which leads', () => {
  it('exactly one leads, and both know who is there', async () => {
    const a = await node(false);
    const b = await node(true);
    expect(a.instance.isLeader()).toBe(true);
    expect(b.instance.isLeader()).toBe(false);
    const seen = await b.instance.instances();
    expect(seen.map((i: { id: string }) => i.id).sort()).toEqual(
      [a.instance.id, b.instance.id].sort(),
    );
    expect(
      seen
        .filter((i: { leader: boolean }) => i.leader)
        .map((i: { id: string }) => i.id),
    ).toEqual([a.instance.id]);
    expect(seen.find((i: { self: boolean }) => i.self).id).toBe(b.instance.id);
  }, 120_000);

  it('a bridge started through the OTHER process is read by the leader — once', async () => {
    const a = await node(false);
    const b = await node(true);
    const br = await bridge(b);
    const job = await b.cdc.start(br.id);
    expect(job.status).toBe('running');
    expect(a.streams.has(br.id)).toBe(true);
    expect(b.streams.has(br.id)).toBe(false);

    await pg(`INSERT INTO "${br.source}" VALUES (1, 'one'), (2, 'two')`);
    await waitFor('the rows', async () =>
      (await destRows('postgres_dest', br.target)).length === 2 ? true : null,
    );
    await sleep(1500);
    // two readers would have delivered it twice
    expect(await deliveries(a, br.id)).toBe(1);

    // and what the screen shows is the same whichever process answers
    expect((await b.cdc.hold(br.id))?.running).toBe(true);
    expect((await a.cdc.hold(br.id))?.running).toBe(true);
  }, 120_000);

  it('"stop", said to the other process, stops the leader’s stream before it answers', async () => {
    const a = await node(false);
    const b = await node(true);
    const br = await bridge(a);
    await a.cdc.start(br.id);
    expect(a.streams.has(br.id)).toBe(true);

    const stopped = await b.cdc.stop(br.id);
    expect(stopped?.status).toBe('paused');
    expect(a.streams.has(br.id)).toBe(false);

    await pg(`INSERT INTO "${br.source}" VALUES (1, 'while it was stopped')`);
    await sleep(1500);
    expect(await destRows('postgres_dest', br.target).catch(() => [])).toEqual(
      [],
    );

    // started again — through the other one again — it carries on from where it was
    await b.cdc.start(br.id);
    await waitFor('the row it missed', async () =>
      (await destRows('postgres_dest', br.target)).length === 1 ? true : null,
    );
    expect(a.streams.has(br.id)).toBe(true);
  }, 120_000);

  it('deleting a running bridge through the other process takes its slot with it', async () => {
    const a = await node(false);
    const b = await node(true);
    const br = await bridge(a);
    await a.cdc.start(br.id);
    const slots = async () =>
      (
        await pg(
          `select count(*)::int n from pg_replication_slots where slot_name = 'syncle_slot_${br.id.replace(/-/g, '')}'`,
        )
      ).rows[0]!.n;
    expect(await slots()).toBe(1);
    const { BridgeLifecycleService } =
      await import('../../src/bridges/bridge-lifecycle.service');
    await b.app.ctx.get(BridgeLifecycleService).teardown(br.id);
    expect(a.streams.has(br.id)).toBe(false);
    expect(await slots()).toBe(0);
  }, 120_000);
});

describe('when the leader goes away', () => {
  it('shut down cleanly: the other takes over at once, and nothing that happened in between is lost or doubled', async () => {
    const a = await node(false);
    const b = await node(true);
    const br = await bridge(a);
    await a.cdc.start(br.id);
    await pg(`INSERT INTO "${br.source}" VALUES (1, 'before')`);
    await waitFor('the first row', async () =>
      (await destRows('postgres_dest', br.target)).length === 1 ? true : null,
    );

    await close(a);
    await pg(
      `INSERT INTO "${br.source}" VALUES (2, 'while nobody was reading')`,
    );
    await waitFor(
      'the other process to lead',
      async () => (b.instance.isLeader() ? true : null),
      { timeoutMs: 15_000 },
    );
    await waitFor(
      'it to read the bridge',
      async () => (b.streams.has(br.id) ? true : null),
      { timeoutMs: 20_000 },
    );
    await pg(`INSERT INTO "${br.source}" VALUES (3, 'after')`);
    await waitFor('every row', async () =>
      (await destRows('postgres_dest', br.target)).length === 3 ? true : null,
    );
    await sleep(1000);
    expect(
      (await destRows('postgres_dest', br.target)).map((r) => Number(r.id)),
    ).toEqual([1, 2, 3]);
    // the job was never stopped: it is the same run, read by another process
    const jobs = await b.app.prisma.bridgeJob.findMany({
      where: { bridgeId: br.id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('running');
  }, 120_000);

  it('killed: the other takes over when the lease runs out', async () => {
    const a = await node(false);
    const b = await node(true);
    const br = await bridge(a);
    await a.cdc.start(br.id);
    await pg(`INSERT INTO "${br.source}" VALUES (1, 'before')`);
    await waitFor('the first row', async () =>
      (await destRows('postgres_dest', br.target)).length === 1 ? true : null,
    );

    // no goodbye: the heartbeat stops, the connections drop, the lease is left to run out
    await a.instance.crashForTest();
    await a.cdc.onModuleDestroy();
    expect(b.instance.isLeader()).toBe(false);
    await pg(
      `INSERT INTO "${br.source}" VALUES (2, 'while nobody was reading')`,
    );

    // in between, a start asked of the survivor is refused rather than faked
    const other = await bridge(b);
    await expect(b.cdc.start(other.id)).rejects.toMatchObject({
      status: 503,
      details: { reason: 'no-leader' },
    });
    expect(
      await b.app.prisma.bridgeJob.count({
        where: { bridgeId: other.id, status: 'running' },
      }),
    ).toBe(0);

    await waitFor(
      'the other process to lead',
      async () => (b.instance.isLeader() ? true : null),
      { timeoutMs: 20_000 },
    );
    await waitFor(
      'it to read the bridge',
      async () => (b.streams.has(br.id) ? true : null),
      { timeoutMs: 20_000 },
    );
    await waitFor('the row that was missed', async () =>
      (await destRows('postgres_dest', br.target)).length === 2 ? true : null,
    );
    // and now that it leads, it starts bridges itself
    await expect(b.cdc.start(other.id)).resolves.toMatchObject({
      status: 'running',
    });
    expect(b.streams.has(other.id)).toBe(true);
  }, 120_000);

  it('a leader that has lost the lease to another process stops reading', async () => {
    const a = await node(false);
    const br = await bridge(a);
    await a.cdc.start(br.id);
    expect(a.streams.has(br.id)).toBe(true);

    // somebody else holds the lease (as after a partition that healed)
    const Redis = (await import('ioredis')).default;
    const { TEST_REDIS_URL } = await import('./env');
    const redis = new Redis(TEST_REDIS_URL);
    await redis.set('syncle:leader', 'somebody-else', 'PX', 60_000);
    try {
      await waitFor(
        'it to stand down',
        async () =>
          !a.instance.isLeader() && !a.streams.has(br.id) ? true : null,
        { timeoutMs: 15_000 },
      );
      // the job is still meant to run: that is what the next leader goes by
      expect(
        await a.app.prisma.bridgeJob.count({
          where: { bridgeId: br.id, status: 'running' },
        }),
      ).toBe(1);
    } finally {
      await redis.del('syncle:leader');
      await redis.quit();
    }
    // the lease is free again: it leads again, and reads again
    await waitFor(
      'it to lead again',
      async () => (a.instance.isLeader() && a.streams.has(br.id) ? true : null),
      { timeoutMs: 30_000 },
    );
  }, 120_000);
});

describe('what every process has to agree on', () => {
  it('a setting saved through one process is the setting in the other', async () => {
    const a = await node(false);
    const b = await node(true);
    const { SettingsStoreService } =
      await import('../../src/settings/settings-store.service');
    const inA = a.app.ctx.get(SettingsStoreService);
    const inB = b.app.ctx.get(SettingsStoreService);
    const before = (await inB.resolved()).defaultMaxPerPoll;
    cleanups.push(async () => {
      await inA.update({ defaultMaxPerPoll: before });
    });
    const heard: number[] = [];
    inB.onChange((s: { defaultMaxPerPoll: number }) =>
      heard.push(s.defaultMaxPerPoll),
    );
    await inA.update({ defaultMaxPerPoll: before + 7 });
    await waitFor(
      'the other process to hear of it',
      async () =>
        inB.snapshot().defaultMaxPerPoll === before + 7 ? true : null,
      { timeoutMs: 10_000 },
    );
    expect(heard).toContain(before + 7);
  }, 120_000);

  it('a job running in one process is aborted by a cancel that reached the other', async () => {
    const a = await node(false);
    const b = await node(true);
    const { JobRegistryService } =
      await import('../../src/bridges/job-registry.service');
    const running = a.app.ctx.get(JobRegistryService).register('job-in-a');
    expect(b.app.ctx.get(JobRegistryService).abort('job-in-a')).toBe(false); // not here…
    await waitFor(
      'the process that has it to abort it',
      async () => (running.signal.aborted ? true : null),
      { timeoutMs: 10_000 },
    );
  }, 120_000);

  it('work that any process may pick up is done by one at a time', async () => {
    const a = await node(false);
    const b = await node(true);
    let inside = 0;
    let most = 0;
    const work = async () => {
      inside++;
      most = Math.max(most, inside);
      await sleep(400);
      inside--;
      return 'done';
    };
    const [first, second] = await Promise.all([
      a.instance.withLock('it-multi-instance', work),
      sleep(50).then(() => b.instance.withLock('it-multi-instance', work)),
    ]);
    expect([first, second]).toEqual(['done', null]);
    expect(most).toBe(1);
    // released: the next one gets it
    expect(await b.instance.withLock('it-multi-instance', work)).toBe('done');
  }, 120_000);

  it('a polling bridge is polled by one process at a time', async () => {
    const a = await node(false);
    const b = await node(true);
    const source = uniqueTable('mi_watch');
    const target = uniqueTable('mi_watch_dst');
    await pg(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
    await pg(
      `INSERT INTO "${source}" SELECT g, 'row' FROM generate_series(1, 6) g`,
    );
    cleanups.push(async () => {
      await withAdapter('postgres', (x) => x.dropTable(source)).catch(
        () => undefined,
      );
      await withAdapter('postgres_dest', (x) => x.dropTable(target)).catch(
        () => undefined,
      );
    });
    const { bridgeInputSchema } = await import('@syncle/core');
    const { BridgeWatchService } =
      await import('../../src/bridges/bridge-watch.service');
    const created = await a.app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-mi-watch-${source}`,
        source: {
          kind: 'table',
          connectionId: await connectionFor(a.app, 'postgres'),
          table: source,
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: await connectionFor(a.app, 'postgres_dest'),
              table: target,
              keyColumns: ['id'],
            },
          ],
        },
        transform: { template: '{{$row}}' },
        // slow on purpose: a poll that is still going when the next one fires
        delivery: { minDelayMs: 250 },
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'increment', column: 'id' },
          pollIntervalMs: 1000,
          startFrom: 'beginning',
        },
      }),
    );
    const watchA = a.app.ctx.get(BridgeWatchService);
    const watchB = b.app.ctx.get(BridgeWatchService);
    cleanups.push(() => watchA.stop(created.id).then(() => undefined));
    await watchA.start(created.id);
    // both processes are told to poll, again and again, while the first poll is still delivering
    await Promise.all([
      watchA.poll(created.id),
      sleep(100).then(() => watchB.poll(created.id)),
      sleep(300).then(() => watchB.poll(created.id)),
      sleep(600).then(() => watchA.poll(created.id)),
    ]);
    await waitFor('every row', async () =>
      (await destRows('postgres_dest', target)).length === 6 ? true : null,
    );
    await watchA.stop(created.id);
    const job = await a.app.prisma.bridgeJob.findFirst({
      where: { bridgeId: created.id },
    });
    // six rows, six deliveries: no window was read twice
    expect(
      await a.app.prisma.bridgeDelivery.count({ where: { jobId: job!.id } }),
    ).toBe(6);
  }, 120_000);
});
