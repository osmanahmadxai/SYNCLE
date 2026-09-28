/**
 * A polling watch on a Redis source, and the queue behind every watch.
 *
 * Redis pages by a cursor of its own (SCAN). The watch used to page it by
 * OFFSET, which the adapter can only do by scanning from the top every time:
 * a keyspace of a hundred thousand keys was a hundred scans of it per poll.
 * And every poll left its job record in Redis for ever.
 */
import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowseParams, BrowseResult, DatabaseAdapter } from '@syncle/core';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let watch: any;
let queue: any;
let pool: any;
let redis: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

const source = (commands: string[]) =>
  withAdapter('redis', (a) => a.query(commands.join('\n')));

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgeWatchService } =
    await import('../../src/bridges/bridge-watch.service');
  const { AdapterPoolService } =
    await import('../../src/connections/adapter-pool.service');
  const { BRIDGE_WATCH_QUEUE } =
    await import('../../src/bridges/bridges.types');
  watch = app.ctx.get(BridgeWatchService);
  pool = app.ctx.get(AdapterPoolService);
  queue = app.ctx.get(getQueueToken(BRIDGE_WATCH_QUEUE));
  redis = await connectionFor(app, 'redis');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function seed(prefix: string, count: number, from = 0): Promise<void> {
  const lines = Array.from(
    { length: count },
    (_, i) => `SET ${prefix}:${String(from + i).padStart(5, '0')} v${from + i}`,
  );
  for (let i = 0; i < lines.length; i += 100)
    await source(lines.slice(i, i + 100));
  cleanups.push(async () => {
    const keys = Array.from(
      { length: count },
      (_, i) => `${prefix}:${String(from + i).padStart(5, '0')}`,
    );
    for (let i = 0; i < keys.length; i += 100)
      await source([`DEL ${keys.slice(i, i + 100).join(' ')}`]);
  });
}

/** every browse the watch asks of the Redis connection, as it asked it */
function recordBrowses(): BrowseParams[] {
  const calls: BrowseParams[] = [];
  const original = pool.withAdapter.bind(pool);
  vi.spyOn(pool, 'withAdapter').mockImplementation(
    (
      id: string,
      db: string | undefined,
      fn: (a: DatabaseAdapter) => Promise<unknown>,
    ) =>
      original(id, db, (a: DatabaseAdapter) =>
        fn(
          id === redis
            ? new Proxy(a, {
                get(target, prop, receiver) {
                  if (prop === 'browse')
                    return (params: BrowseParams): Promise<BrowseResult> => {
                      calls.push(params);
                      return target.browse(params);
                    };
                  const value = Reflect.get(target, prop, receiver);
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value;
                },
              })
            : a,
        ),
      ),
  );
  return calls;
}

async function watchBridge(
  prefix: string,
): Promise<{ id: string; dest: string }> {
  const dest = uniqueTable('wr_dst');
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).catch(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-wr-${prefix}`,
      source: {
        kind: 'table',
        connectionId: redis,
        table: 'keys',
        filters: [{ column: 'key', operator: 'contains', value: `${prefix}:` }],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
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
        kind: 'watch',
        strategy: { strategy: 'snapshot', maxTracked: 10_000 },
        pollIntervalMs: 1000,
        maxPerPoll: 1000,
      },
    }),
  );
  cleanups.push(async () => {
    await watch.stop(bridge.id).catch(() => undefined);
    await app.bridges.remove(bridge.id).catch(() => undefined);
  });
  return { id: bridge.id, dest };
}

describe('a watch on a Redis source', () => {
  it('walks the keyspace by SCAN’s cursor — at the start and on every poll — never by an offset', async () => {
    const prefix = uniqueTable('wr');
    // more keys than the adapter hands over in one page (500): three pages
    await seed(prefix, 1200);
    const calls = recordBrowses();
    try {
      const b = await watchBridge(prefix);
      await watch.start(b.id);
      // the pages of the keyspace — which is what is counted below. the watch
      // also probes the source once for its primary key, with no filters, and
      // waiting on `calls` counted that probe towards the six: where the probe
      // landed inside the window, the wait ended with only five pages read
      const keyspacePages = (): BrowseParams[] =>
        calls.filter((c) =>
          c.filters?.some((f) => String(f.value).includes(prefix)),
        );
      // the snapshot taken at the start and the first poll: three pages each
      // (nothing new — every key was there at the start)
      await waitFor(
        'the first poll',
        async () => (keyspacePages().length >= 6 ? true : null),
        { timeoutMs: 20_000 },
      );
      const pages = keyspacePages();
      expect(pages.length).toBeGreaterThanOrEqual(6);
      // every page by cursor, none by offset; the pages after the first at the cursor the one before gave
      expect(
        pages.every((c) => c.cursor !== undefined && (c.offset ?? 0) === 0),
      ).toBe(true);
      expect(pages.some((c) => c.cursor !== '0')).toBe(true);

      // a change is still seen
      await seed(prefix, 3, 5000);
      const rows = await waitFor(
        'the new keys at the destination',
        async () => {
          const r = await destRows('postgres_dest', b.dest);
          return r.length >= 3 ? r : null;
        },
        { timeoutMs: 30_000 },
      );
      expect(rows.map((r) => r.id).sort()).toEqual([
        `${prefix}:05000`,
        `${prefix}:05001`,
        `${prefix}:05002`,
      ]);
      await watch.stop(b.id);
    } finally {
      vi.restoreAllMocks();
    }
  }, 120_000);
});

describe('the queue behind the watches', () => {
  it('a poll that is done is gone: no record of it stays in Redis', async () => {
    const prefix = uniqueTable('wq');
    await seed(prefix, 5);
    const b = await watchBridge(prefix);
    await watch.start(b.id);
    await new Promise((r) => setTimeout(r, 3500)); // a few polls
    expect(await queue.getCompletedCount()).toBe(0);
    await watch.stop(b.id);
  }, 60_000);

  it('a scheduler of a bridge that is gone is swept at the start; a listening one is kept; old records are cleaned', async () => {
    const prefix = uniqueTable('ws');
    await seed(prefix, 5);
    const b = await watchBridge(prefix);
    await watch.start(b.id);
    const ghost = `ghost-${prefix}`;
    // a record the way earlier releases left one: a poll of a bridge that is not there, kept when done
    const orphan = await queue.add(
      'poll',
      { bridgeId: ghost },
      { removeOnComplete: false, attempts: 1 },
    );
    await waitFor(
      'the orphan poll to finish',
      async () =>
        ['completed', 'failed'].includes(await orphan.getState()) ? true : null,
      { timeoutMs: 20_000 },
    );
    expect(await queue.getCompletedCount()).toBeGreaterThanOrEqual(1);
    // a scheduler of a bridge that is not there, with its first tick an hour away
    // (a tick of its own finds no bridge and unschedules it: a stale scheduler
    // cleans itself on its first poll — the sweep is for the ones that never get one)
    await queue.upsertJobScheduler(
      `watch:${ghost}`,
      { every: 3_600_000, startDate: Date.now() + 3_600_000 },
      { name: 'poll', data: { bridgeId: ghost } },
    );
    const keysBefore = (await queue.getJobSchedulers(0, 999, true)).map(
      (s: { key?: string; id?: string }) => s.key ?? s.id,
    );
    expect(keysBefore).toContain(`watch:${ghost}`);
    expect(keysBefore).toContain(`watch:${b.id}`);

    const done = await watch.reconcile();
    expect(done.removed).toBeGreaterThanOrEqual(1);
    const keysAfter = (await queue.getJobSchedulers(0, 999, true)).map(
      (s: { key?: string; id?: string }) => s.key ?? s.id,
    );
    expect(keysAfter).not.toContain(`watch:${ghost}`);
    expect(keysAfter).toContain(`watch:${b.id}`);
    expect(await queue.getCompletedCount()).toBe(0);
    await watch.stop(b.id);
  }, 60_000);
});
