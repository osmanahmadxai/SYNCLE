/**
 * event-based ("CDC") hooks, engine-agnostic orchestrator.
 *
 * each engine captures changes differently (Postgres logical replication, MySQL
 * binlog, MongoDB change streams, Redis keyspace notifications); that variation
 * lives behind the {@link CdcProvider} interface. this service is the shared
 * machinery around them: pick the provider for a connection's engine, manage the
 * run lifecycle (one resumable run per hook), and run the per-change pipeline
 * (dedupe replays, render, deliver, record, persist the cursor).
 *
 * a held streaming connection per active hook lives in `streams`. durable
 * engines (pg/mysql/mongo) persist a cursor so a restart resumes exactly; Redis
 * is real-time only (see {@link RedisCdcProvider}).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  type CdcOperation,
  type CdcReadiness,
  type CdcReadinessDTO,
  type ConnectionConfig,
  type DatabaseEngine,
  type HookRun,
} from '@syncle/core';
import { randomUUID } from 'node:crypto';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { PrismaService } from '../common/prisma.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { HookSinkService } from './hook-sink.service';
import type { ResolvedHook } from './hooks.types';
import {
  CDC_PROVIDERS,
  type CdcChange,
  type CdcProvider,
  type CdcStreamHandle,
} from './cdc/cdc-provider';
import { rowMatchesFilters } from './cdc/filter-match';

/** live runtime state for one active CDC stream */
interface Stream {
  handle: CdcStreamHandle;
  provider: CdcProvider;
  runId: string;
  seq: number;
  /** highest cursor already processed, guards against replay dupes on reconnect */
  watermark: string | null;
  /**
   * per-hook serialization chain: providers may emit concurrently (Redis fires
   * events fire-and-forget), but changes for one hook must process strictly in
   * order or concurrent handlers would reuse the same sequence number
   */
  pending: Promise<void>;
  /** the source's primary-key columns, so rowKeys stores keys, not every value */
  primaryKey: string[] | null;
}

/** read the persisted resume cursor from a run's cursorJson (legacy `lsn` ok) */
function readCursor(cursorJson: string | null): string | null {
  if (!cursorJson) return null;
  try {
    const o = JSON.parse(cursorJson) as { cursor?: string; lsn?: string };
    return o.cursor ?? o.lsn ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class HookCdcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('HookCdc');
  private readonly streams = new Map<string, Stream>();
  private readonly providers = new Map<DatabaseEngine, CdcProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: HookStoreService,
    private readonly connStore: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: HookSinkService,
    private readonly runs: HookRunService,
    @Inject(CDC_PROVIDERS) providers: CdcProvider[],
  ) {
    for (const p of providers) this.providers.set(p.engine, p);
  }

  private providerFor(engine: DatabaseEngine): CdcProvider | null {
    return this.providers.get(engine) ?? null;
  }

  /* ----- readiness, drives the builder's setup panel ----- */

  async readiness(dto: CdcReadinessDTO): Promise<CdcReadiness> {
    const conn = await this.connStore.resolve(dto.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      return {
        engine: conn.engine,
        supported: false,
        ready: false,
        checks: [],
        instructions: [
          `Event-based (CDC) delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
        ],
      };
    }
    return provider.readiness(dto, conn);
  }

  /* ----- start / stop ----- */

  async start(hookId: string): Promise<HookRun> {
    const hook = await this.store.resolve(hookId);
    if (hook.trigger.kind !== 'cdc') {
      throw new BadRequestError('This hook is not configured for event-based delivery.');
    }
    if (hook.source.kind !== 'table') {
      throw new BadRequestError('Event-based hooks must read from a table.');
    }
    const conn = await this.connStore.resolve(hook.source.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      throw new BadRequestError(
        `Event-based delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
      );
    }

    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) throw new ConflictError('This hook is already running. Stop it first.');

    const ready = await provider.readiness(
      {
        connectionId: hook.source.connectionId,
        database: hook.source.database,
        schema: hook.source.schema,
        table: hook.source.table,
      },
      conn,
    );
    if (!ready.ready) {
      throw new BadRequestError(
        `${conn.engine} isn't ready for event-based delivery. ${ready.instructions.join(' ')}`,
      );
    }

    await provider.provision(hookId, hook, conn);

    // one run per hook: resume the existing (paused) run in place rather than
    // spawning a new one. durable engines keep their cursor so it continues cleanly
    const latest = await this.prisma.hookRun.findFirst({
      where: { hookId },
      orderBy: { startedAt: 'desc' },
    });
    const run = latest
      ? await this.prisma.hookRun.update({
          where: { id: latest.id },
          data: { status: 'running', error: null, finishedAt: null },
        })
      : await this.prisma.hookRun.create({
          data: {
            id: randomUUID(),
            hookId,
            status: 'running',
            configSnapshotJson: await this.store.snapshotJson(hookId),
            cursorOffset: 0,
            totalCount: null,
          },
        });

    await this.beginStream(hookId, hook, conn, provider, run.id, run.cursorOffset, readCursor(run.cursorJson));
    this.logger.log(`Streaming changes for hook ${hookId} (run ${run.id}, ${conn.engine})`);
    return this.runs.getRun(hookId, run.id);
  }

  /** pause: stop the live stream but keep durable state so a resume continues */
  async stop(hookId: string): Promise<HookRun | null> {
    await this.teardown(hookId);
    const run = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return null;
    await this.runs.finalize(run.id, 'paused');
    return this.runs.getRun(hookId, run.id);
  }

  /** full teardown when a hook is deleted: stop stream and drop provider state */
  async cleanup(hookId: string): Promise<void> {
    await this.teardown(hookId);
    try {
      const hook = await this.store.resolve(hookId);
      if (hook.source.kind !== 'table') return;
      const conn = await this.connStore.resolve(hook.source.connectionId);
      const provider = this.providerFor(conn.engine);
      await provider?.deprovision(hookId, hook, conn).catch(() => undefined);
    } catch {
      /* hook/connection already gone, nothing to deprovision */
    }
  }

  /** close every streaming connection on shutdown, no zombie streamers */
  async onModuleDestroy(): Promise<void> {
    for (const hookId of [...this.streams.keys()]) {
      await this.teardown(hookId);
    }
  }

  private async teardown(hookId: string): Promise<void> {
    const stream = this.streams.get(hookId);
    if (!stream) return;
    this.streams.delete(hookId);
    await stream.handle.stop().catch(() => undefined);
  }

  /* ----- the shared change pipeline ----- */

  private async beginStream(
    hookId: string,
    hook: ResolvedHook,
    conn: ConnectionConfig,
    provider: CdcProvider,
    runId: string,
    startSeq: number,
    startCursor: string | null,
  ): Promise<void> {
    // two live streams for one hook would double-deliver every change
    if (this.streams.has(hookId)) {
      throw new ConflictError('This hook already has a live stream. Stop it first.');
    }
    const stream: Stream = {
      handle: { stop: async () => undefined },
      provider,
      runId,
      seq: startSeq,
      watermark: startCursor,
      pending: Promise.resolve(),
      primaryKey: await this.resolvePrimaryKey(hook),
    };
    this.streams.set(hookId, stream);

    let handle: CdcStreamHandle;
    try {
      handle = await provider.startStream({
        hookId,
        hook,
        conn,
        fromCursor: startCursor,
        handlers: {
          onChange: (change) => this.handleChange(hookId, hook, change),
          onError: (err) => this.logger.warn(`CDC stream error for ${hookId}: ${err.message}`),
        },
      });
    } catch (err) {
      // a failed start must not strand the run as 'running' behind a dead
      // placeholder (that would be a permanent ConflictError on retry)
      if (this.streams.get(hookId) === stream) this.streams.delete(hookId);
      await this.runs.finalize(runId, 'failed', (err as Error).message).catch(() => undefined);
      throw err;
    }
    // stop() may have raced us during startStream: it removed the entry and
    // "stopped" the placeholder, so close the real handle instead of leaking it
    if (this.streams.get(hookId) !== stream) {
      await handle.stop().catch(() => undefined);
      return;
    }
    // the provider may have already begun emitting, only replace the placeholder
    stream.handle = handle;
  }

  /** the source's primary-key columns (best-effort), cached on the stream */
  private async resolvePrimaryKey(hook: ResolvedHook): Promise<string[] | null> {
    if (hook.source.kind !== 'table') return null;
    const src = hook.source;
    try {
      const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a.browse({ schema: src.schema, table: src.table, limit: 1, offset: 0 }),
      );
      return page.primaryKey.length ? page.primaryKey : null;
    } catch {
      return null; // unknown, deliveries fall back to null rowKeys
    }
  }

  /**
   * providers may emit concurrently (Redis resolves values out-of-band), so
   * changes for one hook are queued onto the stream's promise chain and
   * processed strictly in order. returning the chain tail keeps backpressure
   * intact for providers that await onChange.
   */
  private handleChange(hookId: string, hook: ResolvedHook, change: CdcChange): Promise<void> {
    const stream = this.streams.get(hookId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(() => this.processChange(hookId, hook, stream, change))
      .catch((err) => {
        // processChange handles its own failures; this only guards the chain
        this.logger.error(`CDC change chain broke for ${hookId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /** for one change: dedupe, filter, render, deliver, record, persist cursor, ack */
  private async processChange(
    hookId: string,
    hook: ResolvedHook,
    stream: Stream,
    change: CdcChange,
  ): Promise<void> {
    // the stream may have been stopped/replaced while queued behind the chain
    if (this.streams.get(hookId) !== stream || hook.source.kind !== 'table') return;
    // strict exactly-once: never re-process a position we've already done
    // (durable engines replay from the last acked cursor after a reconnect)
    if (!stream.provider.cursorAfter(change.cursor, stream.watermark)) return;

    // source filters: replay pushes them into SQL, but a CDC stream sees every
    // row of the table, so evaluate them in-process here. skipped rows still
    // advance the durable cursor (and the provider's server-side ack point) so
    // a filtered-out backlog never replays on resume or pins WAL on the source.
    // delete images may carry only the key columns, hence passMissingColumns
    if (
      !stream.provider.handlesSourceFilters &&
      !rowMatchesFilters(change.row, hook.source.filters, {
        passMissingColumns: change.op === 'delete',
      })
    ) {
      stream.watermark = change.cursor;
      try {
        await this.prisma.hookRun.update({
          where: { id: stream.runId },
          data: { cursorJson: JSON.stringify({ cursor: change.cursor }) },
        });
        await stream.handle.ack?.(change.cursor);
      } catch {
        /* a replay after a restart just re-evaluates the filter and skips again */
      }
      return;
    }

    const seq = stream.seq;
    const now = new Date().toISOString();
    const rowKeys = stream.primaryKey ? stream.primaryKey.map((c) => change.row[c]) : null;
    // key on the cursor (stable per change) so an at-least-once re-delivery after
    // a reconnect carries the SAME Idempotency-Key for the receiver to dedupe
    const idem =
      hook.destination.kind === 'http' && hook.destination.idempotency
        ? `${stream.runId}:${change.cursor}`
        : undefined;
    const signal = new AbortController().signal;
    try {
      // the operation drives both the {{$op}} token (HTTP) and insert/upsert vs
      // delete routing (database destinations)
      const { outcome } = await this.sink.deliver(
        hook,
        [change.row],
        { table: hook.source.table, now, startIndex: seq, op: change.op as CdcOperation },
        signal,
        idem,
      );

      await this.runs.recordDelivery(
        stream.runId,
        { sequence: seq, rowIndex: seq, rowCount: 1, rowKeys },
        outcome,
      );
      if (outcome.status === 'failed' && hook.delivery.onError === 'abort') {
        // stop-on-error: pause the run and stop the stream WITHOUT advancing
        // the watermark or acking, so this change replays on the next start.
        // teardown happens outside the change chain — the provider's stop()
        // may wait for in-flight handlers (i.e. this very call)
        this.logger.warn(`CDC ${hookId}: pausing after a failed delivery (onError=abort)`);
        await this.runs.finalize(
          stream.runId,
          'paused',
          'Paused after a failed delivery (onError=abort).',
        );
        setImmediate(() => void this.teardown(hookId).catch(() => undefined));
        return;
      }
      stream.seq = seq + 1;
      stream.watermark = change.cursor;
      await this.prisma.hookRun.update({
        where: { id: stream.runId },
        data: { cursorOffset: stream.seq, cursorJson: JSON.stringify({ cursor: change.cursor }) },
      });
      // the checkpoint is durable, so the provider may now advance its
      // server-side ack point (the Postgres slot's confirmed LSN). a missed
      // ack only widens the replay window the watermark dedupe absorbs
      try {
        await stream.handle.ack?.(change.cursor);
      } catch {
        /* best-effort by contract */
      }
    } catch (err) {
      // a transient pipeline error (Prisma/pool hiccup) must leave a trace: the
      // event becomes a FAILED delivery row, visible in the timeline + retryable
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.runs.recordDelivery(
          stream.runId,
          { sequence: seq, rowIndex: seq, rowCount: 1, rowKeys },
          {
            status: 'failed',
            httpStatus: null,
            attempts: 1,
            error: message,
            requestBody: null,
            responseBody: null,
            durationMs: 0,
          },
        );
        stream.seq = seq + 1;
        stream.watermark = change.cursor;
        this.logger.warn(`CDC delivery for ${hookId} failed and was recorded: ${message}`);
      } catch {
        // can't even record the failure: stop instead of silently acking away
        this.logger.error(
          `CDC pipeline for ${hookId} is failing and the failure could not be recorded — stopping the stream: ${message}`,
        );
        await this.teardown(hookId).catch(() => undefined);
        await this.runs.finalize(stream.runId, 'failed', message).catch(() => undefined);
      }
    }
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let runs: { hookId: string; id: string; cursorOffset: number; cursorJson: string | null }[];
    try {
      runs = await this.prisma.hookRun.findMany({
        where: { status: 'running' },
        select: { hookId: true, id: true, cursorOffset: true, cursorJson: true },
      });
    } catch {
      return;
    }
    for (const r of runs) {
      try {
        const hook = await this.store.resolve(r.hookId);
        if (hook.trigger.kind !== 'cdc' || !hook.enabled || hook.source.kind !== 'table') continue;
        const conn = await this.connStore.resolve(hook.source.connectionId);
        const provider = this.providerFor(conn.engine);
        if (!provider) continue;
        await provider.provision(r.hookId, hook, conn).catch(() => undefined);
        await this.beginStream(r.hookId, hook, conn, provider, r.id, r.cursorOffset, readCursor(r.cursorJson));
        this.logger.log(`Resumed CDC stream for hook ${r.hookId} (${conn.engine})`);
      } catch (err) {
        this.logger.warn(`Could not resume CDC ${r.hookId}: ${(err as Error).message}`);
      }
    }
  }
}
