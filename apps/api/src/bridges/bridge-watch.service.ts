/**
 * "watch" bridges: live listeners that poll a table for new rows and deliver them
 * as they show up. each watch bridge drives a single long-lived "watch job"
 * (status `running`) plus a BullMQ job scheduler that fires a poll every
 * `pollIntervalMs`. schedulers persist in Redis, so listening survives restarts;
 * `onModuleInit` re-registers any that should still be active.
 *
 * the change-detection itself is the pure engine in `@syncle/core`
 * (`watchQuery` / `advanceCursor`); this service is the I/O around it: fetch a
 * page, deliver the new rows, persist the advanced cursor.
 */
import { createHash, randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  advanceCursor,
  emptyCursor,
  rowKey,
  watchQuery,
  watchStrategySchema,
  type BridgeJob,
  type WatchCursor,
  type WatchStrategyConfig,
} from '@syncle/core';
import { Queue } from 'bullmq';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { PrismaService } from '../common/prisma.service';
import { sleep } from './delivery.service';
import { BridgeSinkService } from './bridge-sink.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { JobRegistryService } from './job-registry.service';
import type { ResolvedBridge } from './bridges.types';
import { BRIDGE_WATCH_QUEUE, type BridgeWatchPayload } from './bridges.types';

type TableSource = Extract<ResolvedBridge['source'], { kind: 'table' }>;

@Injectable()
export class BridgeWatchService implements OnModuleInit {
  private readonly logger = new Logger('BridgeWatch');
  /** in-process guard: never poll the same bridge concurrently (single worker) */
  private readonly polling = new Set<string>();
  /** adaptive cadence: empty-poll streak + currently-scheduled interval per bridge */
  private readonly emptyStreak = new Map<string, number>();
  private readonly scheduledEvery = new Map<string, number>();

  /** fastest cadence (ms) when rows are actively flowing */
  private static readonly FAST_MS = 1000;
  /** stay fast for this many empty polls after activity before backing off */
  private static readonly COOLDOWN_POLLS = 4;
  /**
   * scan budget per poll cycle: how many pages one poll may fetch while digging
   * through fully-deduped pages (rows sharing one boundary timestamp, or a
   * snapshot table larger than a page). without this, a boundary denser than
   * `maxPerPoll` would refetch the identical first page forever and livelock.
   */
  private static readonly SCAN_PAGES_PER_POLL = 50;
  /** resolved primary key per bridge (probed once per table identity) */
  private readonly pkCache = new Map<string, { sig: string; pk: string[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly jobs: BridgeJobService,
    private readonly registry: JobRegistryService,
    @InjectQueue(BRIDGE_WATCH_QUEUE) private readonly queue: Queue<BridgeWatchPayload>,
  ) {}

  /* ----- start / stop ----- */

  async start(bridgeId: string): Promise<BridgeJob> {
    const bridge = await this.store.resolve(bridgeId);
    if (bridge.trigger.kind !== 'watch') {
      throw new BadRequestError('This bridge is not configured to listen.');
    }
    if (bridge.source.kind !== 'table') {
      throw new BadRequestError('Watch bridges must read from a table.');
    }
    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) {
      throw new ConflictError('This bridge is already running. Stop it first.');
    }

    await this.ensureQueueReady();
    // one job per bridge: resume the existing (paused) job in place, keeping its
    // cursor, rather than spawning a new one each time
    const latest = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
    });
    const job =
      latest && latest.cursorJson
        ? await this.prisma.bridgeJob.update({
            where: { id: latest.id },
            data: this.cursorMatches(bridge, latest.cursorJson)
              ? { status: 'running', error: null, finishedAt: null }
              : {
                  // the strategy changed since the cursor was persisted (or the
                  // cursor is corrupt): rebuild it instead of resuming a
                  // mismatched cursor that would brick or mis-filter the bridge
                  status: 'running',
                  error: null,
                  finishedAt: null,
                  cursorJson: JSON.stringify(await this.initialCursor(bridge)),
                  configSnapshotJson: await this.store.snapshotJson(bridgeId),
                },
          })
        : await this.prisma.bridgeJob.create({
            data: {
              id: randomUUID(),
              bridgeId,
              status: 'running',
              configSnapshotJson: await this.store.snapshotJson(bridgeId),
              cursorJson: JSON.stringify(await this.initialCursor(bridge)),
              cursorOffset: 0,
              totalCount: null,
            },
          });
    // start responsive, adapt() eases off when the table goes quiet
    const fast = Math.min(BridgeWatchService.FAST_MS, bridge.trigger.pollIntervalMs);
    this.emptyStreak.set(bridgeId, 0);
    this.scheduledEvery.set(bridgeId, fast);
    await this.schedule(bridgeId, fast);
    this.logger.log(`Listening on bridge ${bridgeId} (job ${job.id})`);
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** true when a persisted cursor parses and matches the bridge's CURRENT strategy */
  private cursorMatches(bridge: ResolvedBridge, cursorJson: string): boolean {
    if (bridge.trigger.kind !== 'watch') return false;
    try {
      const cursor = JSON.parse(cursorJson) as WatchCursor;
      const strategy = watchStrategySchema.parse(bridge.trigger.strategy);
      if (cursor.strategy !== strategy.strategy) return false;
      // a cursor value only means something against the column it was read
      // from — editing the watch column must rebuild the cursor, not apply the
      // stale value to the new column (which would silently skip rows). legacy
      // cursors persisted without `column` are accepted and gain it on the
      // next advance.
      if (
        cursor.strategy !== 'snapshot' &&
        'column' in strategy &&
        cursor.column != null &&
        cursor.column !== strategy.column
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async stop(bridgeId: string): Promise<BridgeJob | null> {
    await this.unschedule(bridgeId);
    const job = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!job) return null;
    // abort any in-flight poll so Stop takes effect mid-page, not after the
    // whole page has been delivered
    this.registry.abort(job.id);
    await this.jobs.finalize(job.id, 'paused');
    return this.jobs.getJob(bridgeId, job.id);
  }

  /* ----- the poll cycle (invoked by the processor) ----- */

  async poll(bridgeId: string): Promise<void> {
    if (this.polling.has(bridgeId)) return; // skip an overlapping fire
    this.polling.add(bridgeId);
    try {
      await this.runPoll(bridgeId);
    } catch (err) {
      this.logger.warn(`Watch poll for ${bridgeId} failed: ${(err as Error).message}`);
    } finally {
      this.polling.delete(bridgeId);
    }
  }

  private async runPoll(bridgeId: string): Promise<void> {
    const job = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: 'running', cursorJson: { not: null } },
      orderBy: { startedAt: 'desc' },
    });
    if (!job) {
      // nothing is listening (stopped/never started), retire the scheduler
      await this.unschedule(bridgeId);
      return;
    }

    const bridge = await this.store.resolve(bridgeId);
    if (!bridge.enabled || bridge.trigger.kind !== 'watch' || bridge.source.kind !== 'table') {
      await this.jobs.finalize(job.id, 'canceled');
      await this.unschedule(bridgeId);
      return;
    }

    const strategy = watchStrategySchema.parse(bridge.trigger.strategy);
    let cursor: WatchCursor;
    try {
      cursor = JSON.parse(job.cursorJson!) as WatchCursor;
    } catch {
      const msg = `Watch job ${job.id} has an unparseable cursor — marking it failed so the user can restart cleanly.`;
      this.logger.error(msg);
      await this.jobs.finalize(job.id, 'failed', msg);
      await this.unschedule(bridgeId);
      return;
    }
    const src = bridge.source;
    const userFilters = src.filters ?? [];
    // the primary key drives deterministic ordering (timestamp tiebreakers,
    // snapshot scan order) — resolve it BEFORE building the query, not from
    // the page that the query returned
    const pk = await this.resolvePk(bridgeId, src);
    const limit =
      strategy.strategy === 'snapshot'
        ? Math.min(strategy.maxTracked, 1000)
        : bridge.trigger.maxPerPoll;
    const pageLimit = Math.min(limit, 1000);

    // registry-backed abort so Stop cancels an in-flight poll mid-page
    const controller = this.registry.register(job.id);
    const signal = controller.signal;
    try {
      let seq = job.cursorOffset;
      let delivered = 0;
      let offset = 0;
      let pages = 0;
      // one poll normally fetches a single page. two situations dig deeper:
      // a fully-deduped full page (rows sharing one boundary timestamp, or a
      // snapshot table larger than a page) pages on at the same cursor so the
      // watch can't livelock, and an advanced cursor with a full page re-reads
      // from the window top to drain a burst — both under one scan budget.
      while (delivered < limit && pages < BridgeWatchService.SCAN_PAGES_PER_POLL) {
        if (signal.aborted) return;
        const { filters, sort } = watchQuery(strategy, cursor, pk);
        const allFilters = [...userFilters, ...filters];
        const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            filters: allFilters.length ? allFilters : undefined,
            sort: sort.length ? sort : undefined,
            limit: pageLimit,
            offset,
          }),
        );
        pages++;
        const effPk = pk.length ? pk : page.primaryKey;
        const { newRows, cursor: next } = advanceCursor(strategy, cursor, page.rows, effPk);

        for (const row of newRows) {
          if (signal.aborted) return;
          const now = new Date().toISOString();
          // idempotency keys on stable row identity, NOT the mutable sequence:
          // a crash that re-fetches this page redelivers under the same key so
          // the receiver can dedupe
          const idem =
            bridge.destination.kind === 'http' && bridge.destination.idempotency
              ? this.idempotencyKey(job.id, strategy, row, effPk)
              : undefined;
          const { outcome } = await this.sink.deliver(
            bridge,
            [row],
            { table: src.table, now, startIndex: seq },
            signal,
            idem,
          );
          await this.jobs.recordDelivery(
            job.id,
            {
              sequence: seq,
              rowIndex: seq,
              rowCount: 1,
              rowKeys: effPk.length ? effPk.map((c) => row[c]) : null,
            },
            outcome,
          );
          seq++;
          // checkpoint the sequence immediately: a crash mid-page must never
          // reuse a sequence (the upsert would overwrite a delivered row)
          await this.prisma.bridgeJob.update({
            where: { id: job.id },
            data: { cursorOffset: seq },
          });
          if (outcome.status === 'failed' && bridge.delivery.onError === 'abort') {
            // stop-on-error: unschedule and leave the job paused with the
            // reason, WITHOUT persisting this page's advanced cursor — the
            // next start re-fetches the window, so the failed row is retried
            // (stable idempotency keys make the overlap safe for receivers)
            this.logger.warn(
              `Watch ${bridgeId}: pausing after a failed delivery (onError=abort)`,
            );
            await this.unschedule(bridgeId);
            await this.jobs.finalize(
              job.id,
              'paused',
              'Paused after a failed delivery (onError=abort).',
            );
            return;
          }
          if (bridge.delivery.minDelayMs) await sleep(bridge.delivery.minDelayMs, signal);
        }
        if (signal.aborted) return;

        const advanced = JSON.stringify(next) !== JSON.stringify(cursor);
        cursor = next;
        delivered += newRows.length;
        await this.prisma.bridgeJob.update({
          where: { id: job.id },
          data: { cursorJson: JSON.stringify(cursor), cursorOffset: seq },
        });

        const full = page.rows.length >= pageLimit;
        if (!full) break; // drained everything matching the filter window
        if (newRows.length === 0 && !advanced) {
          // dense boundary: every row of a full page was already delivered and
          // the cursor can't move yet — dig into the next page of the window
          if (offset === 0) {
            this.logger.warn(
              `Watch ${bridgeId}: paging within a dense boundary (${pageLimit}+ rows share the cursor position)`,
            );
          }
          offset += page.rows.length;
          continue;
        }
        // the cursor advanced and the page was full: more rows may be waiting —
        // restart from the top of the (new) window
        offset = 0;
      }
      if (pages >= BridgeWatchService.SCAN_PAGES_PER_POLL) {
        this.logger.warn(
          `Watch ${bridgeId}: scan budget exhausted (${pages} pages in one poll) — will continue next poll`,
        );
      }

      await this.adapt(bridgeId, bridge.trigger.pollIntervalMs, delivered > 0);
    } finally {
      this.registry.release(job.id);
    }
  }

  /**
   * idempotency key from stable row identity, salted with the tracked
   * timestamp so a genuine later update of the same row still delivers fresh.
   * hashed: raw pk values can carry characters that don't belong in an HTTP
   * header (and composite keys can be arbitrarily long).
   */
  private idempotencyKey(
    jobId: string,
    strategy: WatchStrategyConfig,
    row: Record<string, unknown>,
    pk: string[],
  ): string {
    const tracked = strategy.strategy === 'timestamp' ? row[strategy.column] : null;
    const salt = tracked instanceof Date ? tracked.toISOString() : String(tracked ?? '');
    const identity = createHash('sha256')
      .update(`${rowKey(row, pk)} ${salt}`)
      .digest('hex')
      .slice(0, 32);
    return `${jobId}:${identity}`;
  }

  /** resolve (and cache) the source table's primary key for stable ordering */
  private async resolvePk(bridgeId: string, src: TableSource): Promise<string[]> {
    const sig = `${src.connectionId}:${src.database ?? ''}:${src.schema ?? ''}:${src.table}`;
    const hit = this.pkCache.get(bridgeId);
    if (hit && hit.sig === sig) return hit.pk;
    const probe = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.browse({ schema: src.schema, table: src.table, limit: 1, offset: 0 }),
    );
    this.pkCache.set(bridgeId, { sig, pk: probe.primaryKey });
    return probe.primaryKey;
  }

  /**
   * adaptive cadence: poll fast while rows are flowing, then ease back to the
   * configured (idle) interval after a short cooldown. keeps a busy table
   * near-real-time while a quiet one barely touches the database, all without
   * any DB-side changes.
   */
  private async adapt(bridgeId: string, idleMs: number, hadRows: boolean): Promise<void> {
    // stop() may have raced this poll: re-registering the scheduler here would
    // resurrect a stopped watcher for one extra fire
    if (!this.scheduledEvery.has(bridgeId)) return;
    const fast = Math.min(BridgeWatchService.FAST_MS, idleMs);
    const streak = hadRows ? 0 : (this.emptyStreak.get(bridgeId) ?? 0) + 1;
    this.emptyStreak.set(bridgeId, streak);
    const desired = streak < BridgeWatchService.COOLDOWN_POLLS ? fast : idleMs;
    if (this.scheduledEvery.get(bridgeId) !== desired) {
      this.scheduledEvery.set(bridgeId, desired);
      await this.schedule(bridgeId, desired);
    }
  }

  /* ----- initial cursor, so `startFrom: now` ignores existing rows ----- */

  private async initialCursor(bridge: ResolvedBridge): Promise<WatchCursor> {
    if (bridge.trigger.kind !== 'watch' || bridge.source.kind !== 'table') {
      throw new BadRequestError('Watch bridges must read from a table.');
    }
    const strategy = watchStrategySchema.parse(bridge.trigger.strategy);
    if (bridge.trigger.startFrom === 'beginning') return emptyCursor(strategy);

    const src = bridge.source;
    const cid = src.connectionId;
    const db = src.database;
    // seeds must look at the same row universe the polls will: apply the
    // bridge's own source filters to every seeding query
    const userFilters = src.filters ?? [];
    const withUser = (extra: typeof userFilters) => {
      const all = [...userFilters, ...extra];
      return all.length ? all : undefined;
    };

    if (strategy.strategy === 'increment') {
      const page = await this.pool.withAdapter(cid, db, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          filters: withUser([]),
          sort: [{ column: strategy.column, direction: 'desc' }],
          limit: 1,
          offset: 0,
        }),
      );
      return {
        strategy: 'increment',
        value: page.rows[0]?.[strategy.column] ?? null,
        column: strategy.column,
      };
    }

    if (strategy.strategy === 'timestamp') {
      const top = await this.pool.withAdapter(cid, db, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          filters: withUser([]),
          sort: [{ column: strategy.column, direction: 'desc' }],
          limit: 1,
          offset: 0,
        }),
      );
      const maxTs = top.rows[0]?.[strategy.column];
      if (maxTs == null) return emptyCursor(strategy);
      // remember every row already at the max timestamp so it isn't re-sent —
      // paged, because a bulk-loaded table can hold far more than one page of
      // rows at a single timestamp. pk tiebreakers keep the offset paging
      // stable (rows sharing the timestamp would otherwise shuffle per page)
      const pk = await this.resolvePk(bridge.id, src);
      const tiebreakers = pk
        .filter((c) => c !== strategy.column)
        .map((c) => ({ column: c, direction: 'asc' as const }));
      const boundaryKeys: string[] = [];
      for (let offset = 0; offset < 20_000; offset += 1000) {
        const at = await this.pool.withAdapter(cid, db, (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            filters: withUser([
              { column: strategy.column, operator: 'gte', value: maxTs },
            ]),
            sort: [{ column: strategy.column, direction: 'asc' }, ...tiebreakers],
            limit: 1000,
            offset,
          }),
        );
        boundaryKeys.push(...at.rows.map((r) => rowKey(r, pk.length ? pk : at.primaryKey)));
        if (at.rows.length < 1000) break;
      }
      return {
        strategy: 'timestamp',
        ts: maxTs instanceof Date ? maxTs.toISOString() : maxTs,
        boundaryKeys,
        column: strategy.column,
      };
    }

    // snapshot: seed the seen-set with current primary keys (bounded), scanned
    // in pk order so the seed and the polls walk the table the same way
    const pk = await this.resolvePk(bridge.id, src);
    const seen: string[] = [];
    for (let offset = 0; offset < strategy.maxTracked; offset += 1000) {
      const page = await this.pool.withAdapter(cid, db, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          filters: withUser([]),
          sort: pk.length
            ? pk.map((c) => ({ column: c, direction: 'asc' as const }))
            : undefined,
          limit: Math.min(strategy.maxTracked - offset, 1000),
          offset,
        }),
      );
      seen.push(...page.rows.map((r) => rowKey(r, pk.length ? pk : page.primaryKey)));
      if (page.rows.length < 1000) break;
    }
    return { strategy: 'snapshot', seen };
  }

  /* ----- scheduler plumbing ----- */

  private schedulerId(bridgeId: string): string {
    return `watch:${bridgeId}`;
  }

  private async schedule(bridgeId: string, every: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      this.schedulerId(bridgeId),
      { every },
      { name: 'poll', data: { bridgeId } },
    );
  }

  private async unschedule(bridgeId: string): Promise<void> {
    this.emptyStreak.delete(bridgeId);
    this.scheduledEvery.delete(bridgeId);
    this.pkCache.delete(bridgeId);
    await this.queue.removeJobScheduler(this.schedulerId(bridgeId)).catch(() => false);
  }

  private async ensureQueueReady(): Promise<void> {
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000),
        ),
      ]);
    } catch {
      throw new AppError(
        'CONNECTION_FAILED',
        'The job queue (Redis) is unavailable. Start it with `docker compose up -d redis` or set REDIS_URL.',
        503,
      );
    }
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let rows: { bridgeId: string }[];
    try {
      rows = await this.prisma.bridgeJob.findMany({
        where: { status: 'running', cursorJson: { not: null } },
        select: { bridgeId: true },
      });
    } catch (err) {
      this.logger.warn(`Skipped watch recovery: ${(err as Error).message}`);
      return;
    }
    for (const { bridgeId } of rows) {
      try {
        const bridge = await this.store.get(bridgeId);
        if (bridge.trigger.kind === 'watch' && bridge.enabled) {
          await this.schedule(bridgeId, bridge.trigger.pollIntervalMs);
        }
      } catch (err) {
        this.logger.warn(`Could not resume watch ${bridgeId}: ${(err as Error).message}`);
      }
    }
    if (rows.length) this.logger.log(`Resumed ${rows.length} watch listener(s)`);
  }
}
