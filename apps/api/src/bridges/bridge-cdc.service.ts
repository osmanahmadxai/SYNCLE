/**
 * event-based ("CDC") bridges, engine-agnostic orchestrator.
 *
 * each engine captures changes differently (Postgres logical replication, MySQL
 * binlog, MongoDB change streams, Redis keyspace notifications); that variation
 * lives behind the {@link CdcProvider} interface. this service is the shared
 * machinery around them: pick the provider for a connection's engine, manage the
 * job lifecycle (one resumable job per bridge), and runs the per-change pipeline
 * (dedupe replays, render, deliver, record, persist the cursor).
 *
 * a held streaming connection per active bridge lives in `streams`. durable
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
  type BridgeJob,
  UNCHANGED,
} from '@syncle/core';
import { randomUUID } from 'node:crypto';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { BridgeSinkService } from './bridge-sink.service';
import type { DeliveryOutcome, ResolvedBridge } from './bridges.types';
import { previewBody } from './database-sink.service';
import { DeadLetterService, type NewDeadLetter } from './dead-letter.service';
import { isolateFailures } from './cdc/isolate-failures';
import {
  CDC_PROVIDERS,
  backoffMs,
  type CdcChange,
  type CdcProvider,
  type CdcStreamHandle,
} from './cdc/cdc-provider';
import { rowMatchesFilters } from './cdc/filter-match';
import { CdcSpoolService, type SpoolEntry, type SpooledItem } from './cdc/cdc-spool.service';

/** live runtime state for one active CDC stream */
interface Stream {
  handle: CdcStreamHandle;
  provider: CdcProvider;
  jobId: string;
  seq: number;
  /** highest cursor already processed, guards against replay dupes on reconnect */
  watermark: string | null;
  /**
   * per-bridge serialization chain: providers may emit concurrently (Redis fires
   * events fire-and-forget), but changes for one bridge must process strictly in
   * order or concurrent handlers would reuse the same sequence number
   */
  pending: Promise<void>;
  /** the source's primary-key columns, so rowKeys stores keys, not every value */
  primaryKey: string[] | null;
  /** changes accepted but not yet delivered; flushed as ONE delivery */
  buffer: Buffered[];
  /** the operation every buffered change shares; a different op forces a flush */
  bufferOp: CdcOperation | null;
  /** key signatures already in the buffer, so one batch never repeats a key */
  bufferKeys: Set<string>;
  /**
   * the furthest position the pending batch covers. normally its last row's,
   * but it runs ahead of that whenever the stream passes something that is not
   * delivered — a transaction marker, a filtered-out row. such a position may
   * only be confirmed to the source IN ORDER, once every row ahead of it has
   * landed, so it is not checkpointed on sight: it rides the batch, and the
   * batch's single checkpoint (taken after a successful delivery) covers it.
   */
  tailCursor: string | null;
  /** linger timer, so a partial batch still leaves promptly */
  timer: ReturnType<typeof setTimeout> | null;
  /** what the running timer is waiting to flush (see `scheduleFlush`) */
  timerFor: 'rows' | 'position' | null;
  /** rows per delivery for this bridge */
  maxBatch: number;
  /** rows the byte budget allows, from the first row of the current batch */
  byteCappedBatch: number | null;
  /** the delivery currently being written, if any (at most one) */
  inflight: Promise<void> | null;
  /** the resolved bridge, so a flush needs no extra arguments */
  bridge: ResolvedBridge;
  /** changes go through the durable spool instead of straight to the sink */
  spooled: boolean;
  /** set to stop the spool consumer loop */
  consumerStop: boolean;
  /** the running consumer, awaited on teardown so it exits cleanly */
  consumer: Promise<void> | null;
  /**
   * set the instant a failure stops the bridge. the actual teardown runs a tick
   * later (it has to happen outside the change chain), and in that gap a flush
   * already waiting on `inflight` would wake up first, deliver the NEXT batch
   * and checkpoint past the one that just failed. everything that delivers or
   * advances checks this flag, so nothing moves once it is set.
   */
  halted: boolean;
  /** batches in a row that delivered nothing, to spot a dead destination */
  consecutiveFailures: number;
  /**
   * does a destination store the row as ONE value (a key-value store)? such a
   * write cannot "leave a column alone". resolved on first need; see
   * `completeRow`
   */
  wholeValueTarget: boolean | null;
}

/** one change held in the pending batch */
interface Buffered {
  change: CdcChange;
  row: Record<string, unknown>;
  /** identity of the row within this batch, or null when there is no key */
  keySig: string | null;
}

type Row = Record<string, unknown>;

/** dead-letter entries are chunked so no single stored row is enormous */
const DEAD_LETTER_CHUNK = 500;
/** poison-row isolation limits (see isolate-failures.ts) */
const ISOLATION = { maxAttempts: 128, maxPoisoned: 100, failuresBeforeSystemic: 14 } as const;
/** attempts at the metadata-store writes that follow a delivery */
const SETTLE_ATTEMPTS = 3;
/**
 * how long a batch holding only a position (nothing to deliver) may wait. a
 * busy database emits a BEGIN/COMMIT pair per transaction even when none touch
 * the bridge's table; checkpointing each one would be a metadata-store write
 * per transaction on the source. once a second keeps the slot moving at a
 * negligible cost.
 */
const POSITION_LINGER_MS = 1_000;

/** read the persisted resume cursor from a job's cursorJson (legacy `lsn` ok) */
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
export class BridgeCdcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BridgeCdc');
  private readonly streams = new Map<string, Stream>();
  private readonly providers = new Map<DatabaseEngine, CdcProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly connStore: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly jobs: BridgeJobService,
    private readonly spool: CdcSpoolService,
    private readonly deadLetters: DeadLetterService,
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

  async start(bridgeId: string): Promise<BridgeJob> {
    const bridge = await this.store.resolve(bridgeId);
    if (bridge.trigger.kind !== 'cdc') {
      throw new BadRequestError('This bridge is not configured for event-based delivery.');
    }
    if (bridge.source.kind !== 'table') {
      throw new BadRequestError('Event-based bridges must read from a table.');
    }
    const conn = await this.connStore.resolve(bridge.source.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      throw new BadRequestError(
        `Event-based delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
      );
    }

    if (bridge.trigger.operations.includes('truncate') && !provider.capturesTruncate) {
      throw new BadRequestError(
        `${conn.engine} does not report a TRUNCATE as a change, so this bridge would never see one. ` +
          'Remove "truncate" from its operations (it is available for PostgreSQL sources).',
      );
    }

    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) throw new ConflictError('This bridge is already running. Stop it first.');

    const ready = await provider.readiness(
      {
        connectionId: bridge.source.connectionId,
        database: bridge.source.database,
        schema: bridge.source.schema,
        table: bridge.source.table,
      },
      conn,
    );
    if (!ready.ready) {
      throw new BadRequestError(
        `${conn.engine} isn't ready for event-based delivery. ${ready.instructions.join(' ')}`,
      );
    }

    await provider.provision(bridgeId, bridge, conn);

    // one job per bridge: resume the existing (paused) job in place rather than
    // spawning a new one. durable engines keep their cursor so it continues cleanly
    const latest = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
    });
    const job = latest
      ? await this.prisma.bridgeJob.update({
          where: { id: latest.id },
          data: { status: 'running', error: null, finishedAt: null },
        })
      : await this.prisma.bridgeJob.create({
          data: {
            id: randomUUID(),
            bridgeId,
            status: 'running',
            configSnapshotJson: await this.store.snapshotJson(bridgeId),
            cursorOffset: 0,
            totalCount: null,
          },
        });

    await this.beginStream(bridgeId, bridge, conn, provider, job.id, job.cursorOffset, readCursor(job.cursorJson));
    this.logger.log(`Streaming changes for bridge ${bridgeId} (job ${job.id}, ${conn.engine})`);
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** pause: stop the live stream but keep durable state so a resume continues */
  async stop(bridgeId: string): Promise<BridgeJob | null> {
    await this.teardown(bridgeId);
    const job = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!job) return null;
    await this.jobs.finalize(job.id, 'paused');
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** full teardown when a bridge is deleted: stop stream and drop provider state */
  async cleanup(bridgeId: string): Promise<void> {
    await this.teardown(bridgeId);
    try {
      const bridge = await this.store.resolve(bridgeId);
      if (bridge.source.kind !== 'table') return;
      const conn = await this.connStore.resolve(bridge.source.connectionId);
      const provider = this.providerFor(conn.engine);
      await provider?.deprovision(bridgeId, bridge, conn).catch(() => undefined);
    } catch {
      /* bridge/connection already gone, nothing to deprovision */
    }
  }

  /** close every streaming connection on shutdown, no zombie streamers */
  async onModuleDestroy(): Promise<void> {
    for (const bridgeId of [...this.streams.keys()]) {
      await this.teardown(bridgeId);
    }
  }

  private async teardown(bridgeId: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return;
    // let the in-flight chain settle so a half-built batch is not abandoned
    // mid-flush, then drop the entry so nothing new is accepted
    await stream.pending.catch(() => undefined);
    this.streams.delete(bridgeId);
    if (stream.timer) clearTimeout(stream.timer);
    stream.consumerStop = true;
    await stream.consumer?.catch(() => undefined);
    // a delivery may still be writing; let it finish so its checkpoint lands
    await stream.inflight?.catch(() => undefined);
    // whatever is still buffered is simply dropped. it was never checkpointed
    // or acked, so the source hands it over again on the next start — and a
    // stream that is no longer registered must not deliver anything
    await stream.handle.stop().catch(() => undefined);
  }

  /* ----- the shared change pipeline ----- */

  private async beginStream(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
    provider: CdcProvider,
    jobId: string,
    startSeq: number,
    startCursor: string | null,
  ): Promise<void> {
    // two live streams for one bridge would double-deliver every change
    if (this.streams.has(bridgeId)) {
      throw new ConflictError('This bridge already has a live stream. Stop it first.');
    }
    const stream: Stream = {
      handle: { stop: async () => undefined },
      provider,
      jobId,
      seq: startSeq,
      watermark: startCursor,
      pending: Promise.resolve(),
      primaryKey: await this.resolvePrimaryKey(bridge),
      buffer: [],
      bufferOp: null,
      bufferKeys: new Set(),
      tailCursor: null,
      timer: null,
      timerFor: null,
      // a database destination may batch freely: writes are idempotent upserts
      // keyed by column, so N-at-once is indistinguishable from N one-at-a-time.
      // an HTTP destination must keep delivery.batchSize, because there the
      // batch size IS the payload the receiver sees.
      maxBatch:
        bridge.destination.kind === 'database'
          ? Math.max(1, runtimeConfig.cdcBatchSize)
          : Math.max(1, bridge.delivery.batchSize),
      bridge,
      byteCappedBatch: null,
      inflight: null,
      spooled: runtimeConfig.cdcSpool,
      consumerStop: false,
      consumer: null,
      halted: false,
      consecutiveFailures: 0,
      wholeValueTarget: null,
    };
    this.streams.set(bridgeId, stream);

    let handle: CdcStreamHandle;
    try {
      handle = await provider.startStream({
        bridgeId,
        bridge,
        conn,
        fromCursor: startCursor,
        handlers: {
          onChange: (change) => this.handleChange(bridgeId, bridge, change),
          onSkip: (cursor) => this.handleSkip(bridgeId, cursor),
          onNotice: (message, cursor) => this.handleNotice(bridgeId, message, cursor),
          onError: (err) => this.logger.warn(`CDC stream error for ${bridgeId}: ${err.message}`),
        },
      });
    } catch (err) {
      // a failed start must not strand the job as 'running' behind a dead
      // placeholder (that would be a permanent ConflictError on retry)
      if (this.streams.get(bridgeId) === stream) this.streams.delete(bridgeId);
      await this.jobs.finalize(jobId, 'failed', (err as Error).message).catch(() => undefined);
      throw err;
    }
    // stop() may have raced us during startStream: it removed the entry and
    // "stopped" the placeholder, so close the real handle instead of leaking it
    if (this.streams.get(bridgeId) !== stream) {
      await handle.stop().catch(() => undefined);
      return;
    }
    // the provider may have already begun emitting, only replace the placeholder
    stream.handle = handle;
    // the spool consumer runs alongside the reader, draining to the destination
    if (stream.spooled) this.startConsumer(bridgeId, stream);
  }

  /** the source's primary-key columns (best-effort), cached on the stream */
  private async resolvePrimaryKey(bridge: ResolvedBridge): Promise<string[] | null> {
    if (bridge.source.kind !== 'table') return null;
    const src = bridge.source;
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
   * changes for one bridge are queued onto the stream's promise chain and
   * processed strictly in order. returning the chain tail keeps backpressure
   * intact for providers that await onChange.
   */
  private handleChange(bridgeId: string, bridge: ResolvedBridge, change: CdcChange): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(() => this.accept(bridgeId, bridge, stream, change))
      .catch((err) => {
        // accept() handles its own failures; this only guards the chain
        this.logger.error(`CDC change chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /** a position passed without delivering anything; ordered like any change */
  private handleSkip(bridgeId: string, cursor: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(() => this.notePosition(bridgeId, stream, cursor))
      .catch((err) => {
        this.logger.error(`CDC skip chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /**
   * something happened at the source that was deliberately not applied (a
   * TRUNCATE on a bridge that does not mirror them). it goes on the timeline IN
   * ORDER — after everything read before it has been delivered — as a skipped
   * cell carrying the explanation, and the stream then moves past it.
   */
  private handleNotice(bridgeId: string, message: string, cursor: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(async () => {
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        // an event, so it is deduplicated the way a change is: against what has
        // been durably processed, not against what is merely buffered
        if (!stream.provider.cursorAfter(cursor, stream.watermark)) return;
        await this.flush(bridgeId, stream);
        if (stream.inflight) await stream.inflight.catch(() => undefined);
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        this.logger.warn(`CDC ${bridgeId}: ${message}`);
        if (stream.spooled) {
          // the consumer owns the sequence numbers here, so the notice queues up
          // behind the changes already spooled and is recorded when reached
          await this.spoolBatch(bridgeId, stream, [{ op: 'notice', row: { message }, cursor }], cursor);
          return;
        }
        await this.settle(bridgeId, stream, async () => {
          const seq = stream.seq;
          await this.jobs.recordNotice(stream.jobId, seq, message);
          await this.checkpoint(stream, seq + 1, cursor);
        });
      })
      .catch((err) => {
        this.logger.error(`CDC notice chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /**
   * Postgres leaves a large (TOASTed) column out of an UPDATE that did not
   * touch it, and the row arrives with UNCHANGED in its place.
   *
   * For a table-shaped destination that is all that is needed: the column is
   * left out of the upsert, and the destination keeps the copy it has. But some
   * things need the VALUE, and leaving it out is wrong for them:
   *
   *  - a source filter on that column cannot be evaluated without it
   *  - an HTTP payload would go out with the column missing
   *  - a key-value destination stores the row as one value: a write without the
   *    column REPLACES a value that had it
   *  - a row that moved to a new key has no earlier copy at the destination to
   *    keep anything from
   *
   * For those, the row is read back from the source by its key and the missing
   * columns are filled in from it. That is the row as it is NOW, which may be a
   * moment newer than this change — the changes in between are still on their
   * way and will write the same values again, so the destination converges.
   *
   * Returns the row to carry on with, or null when the read kept failing and
   * the bridge was stopped (the cursor has not moved, so nothing is lost).
   */
  private async completeRow(
    bridgeId: string,
    bridge: ResolvedBridge,
    stream: Stream,
    change: CdcChange,
  ): Promise<Row | null> {
    const row = change.row;
    if (bridge.source.kind !== 'table') return row;
    const src = bridge.source;
    const missing = Object.keys(row).filter((c) => row[c] === UNCHANGED);

    const needed =
      change.keyChanged === true ||
      bridge.destination.kind === 'http' ||
      (src.filters ?? []).some((f) => missing.includes(f.column)) ||
      (await this.hasWholeValueTarget(bridge, stream));
    if (!needed) return row;

    // without the missing columns, an HTTP payload simply does not have them —
    // better than the text of a marker. tables ignore them either way
    const without = (): Row =>
      bridge.destination.kind === 'http'
        ? Object.fromEntries(Object.entries(row).filter(([, v]) => v !== UNCHANGED))
        : row;

    const key = stream.primaryKey;
    if (!key?.length || key.some((c) => row[c] === undefined || row[c] === null || row[c] === UNCHANGED)) {
      return without();
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            filters: key.map((column) => ({ column, operator: 'eq' as const, value: row[column] })),
            limit: 1,
            offset: 0,
          }),
        );
        const current = page.rows[0];
        // gone since: its delete is further along the stream
        if (!current) return without();
        const filled: Row = { ...row };
        for (const column of missing) {
          if (column in current) filled[column] = current[column];
        }
        return bridge.destination.kind === 'http'
          ? Object.fromEntries(Object.entries(filled).filter(([, v]) => v !== UNCHANGED))
          : filled;
      } catch (err) {
        if (this.streams.get(bridgeId) !== stream || stream.halted) return null;
        if (attempt >= 2) {
          await this.halt(
            bridgeId,
            stream,
            'failed',
            `Could not read a row back from the source to complete a change, stopped without advancing the cursor so nothing is lost: ${(err as Error).message}`,
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }
  }

  /** is any database target a store that holds a row as one value? */
  private async hasWholeValueTarget(bridge: ResolvedBridge, stream: Stream): Promise<boolean> {
    if (stream.wholeValueTarget !== null) return stream.wholeValueTarget;
    let found = false;
    if (bridge.destination.kind === 'database') {
      for (const target of bridge.destination.targets) {
        try {
          const conn = await this.connStore.resolve(target.connectionId);
          if (conn.engine === 'redis') found = true;
        } catch {
          found = true; // unknown: the complete row is the safe assumption
        }
      }
    }
    stream.wholeValueTarget = found;
    return found;
  }

  /** extend the pending batch's reach to `cursor` without adding a row */
  private notePosition(bridgeId: string, stream: Stream, cursor: string): void {
    if (this.streams.get(bridgeId) !== stream || stream.halted) return;
    // replays after a reconnect re-send positions we are already past
    if (!stream.provider.cursorAfter(cursor, stream.tailCursor ?? stream.watermark)) return;
    stream.tailCursor = cursor;
    this.scheduleFlush(bridgeId, stream);
  }

  /** identity of a row within a batch, or null when the source has no key */
  private keySignature(stream: Stream, row: Record<string, unknown>): string | null {
    if (!stream.primaryKey?.length) return null;
    try {
      return JSON.stringify(stream.primaryKey.map((c) => row[c]));
    } catch {
      return null;
    }
  }

  /**
   * take one change: drop replays, handle filtered rows, otherwise add it to
   * the pending batch and flush when the batch is complete.
   */
  private async accept(
    bridgeId: string,
    bridge: ResolvedBridge,
    stream: Stream,
    change: CdcChange,
  ): Promise<void> {
    // the stream may have been stopped/replaced while queued behind the chain
    if (this.streams.get(bridgeId) !== stream || bridge.source.kind !== 'table') return;
    // a failure has stopped this bridge: take nothing more. whatever arrives
    // now is un-acked, so the source replays it on the next start
    if (stream.halted) return;
    // strict exactly-once: never re-process a position we've already done
    // (durable engines replay from the last acked cursor after a reconnect)
    if (!stream.provider.cursorAfter(change.cursor, stream.watermark)) return;

    const op = change.op as CdcOperation;

    // a truncate carries no row: nothing to filter, nothing to key, and nothing
    // may share its batch. everything read before it is delivered first, then
    // it goes alone, then the stream carries on — so a row inserted after the
    // TRUNCATE at the source still exists at the destination afterwards
    if (op === 'truncate') {
      await this.flush(bridgeId, stream);
      if (this.streams.get(bridgeId) !== stream || stream.halted) return;
      stream.buffer.push({ change, row: {}, keySig: null });
      stream.tailCursor = change.cursor;
      stream.bufferOp = op;
      await this.flush(bridgeId, stream);
      return;
    }

    // columns the source left out because they did not change (see UNCHANGED)
    if (Object.values(change.row).includes(UNCHANGED)) {
      const row = await this.completeRow(bridgeId, bridge, stream, change);
      if (row === null) return; // the bridge was stopped; nothing moved
      change = { ...change, row };
    }

    // source filters: replay pushes them into SQL, but a CDC stream sees every
    // row of the table, so evaluate them in-process here. skipped rows still
    // advance the durable cursor (and the provider's server-side ack point) so
    // a filtered-out backlog never replays on resume or pins WAL on the source.
    // delete images may carry only the key columns, hence passMissingColumns
    if (
      !stream.provider.handlesSourceFilters &&
      !rowMatchesFilters(change.row, bridge.source.filters, {
        passMissingColumns: op === 'delete',
      })
    ) {
      // its cursor may only be passed once everything ORDERED BEFORE it has
      // landed. checkpointing it right here would race the batch still being
      // written: if that batch then failed (or the process died), the cursor
      // would already sit beyond it and those rows would never be read again
      this.notePosition(bridgeId, stream, change.cursor);
      return;
    }

    const keySig = this.keySignature(stream, change.row);

    // two reasons a change cannot join the current batch: a different operation
    // has no single route through the sink, and a repeated key would make one
    // multi-row upsert touch the same row twice, which Postgres rejects outright
    const conflicts =
      stream.buffer.length > 0 &&
      (stream.bufferOp !== op || (keySig !== null && stream.bufferKeys.has(keySig)));
    if (conflicts) {
      await this.flush(bridgeId, stream);
      if (this.streams.get(bridgeId) !== stream) return;
    }

    if (stream.buffer.length === 0) {
      // one measurement per batch: the stream carries a single table's shape,
      // so its rows are the same size to within a rounding error
      let bytes = 0;
      try {
        bytes = JSON.stringify(change.row).length;
      } catch {
        bytes = 0;
      }
      stream.byteCappedBatch =
        bytes > 0
          ? Math.max(1, Math.floor(runtimeConfig.cdcBatchBytes / bytes))
          : null;
    }

    stream.buffer.push({ change, row: change.row, keySig });
    stream.tailCursor = change.cursor;
    stream.bufferOp = op;
    if (keySig !== null) stream.bufferKeys.add(keySig);

    const limit = Math.min(stream.maxBatch, stream.byteCappedBatch ?? stream.maxBatch);
    if (stream.buffer.length >= limit) {
      // a full batch is delivered before this returns, so a provider that
      // awaits onChange still feels backpressure and the buffer stays bounded
      await this.flush(bridgeId, stream);
      return;
    }
    this.scheduleFlush(bridgeId, stream);
  }

  /**
   * flush a partial batch after a short linger, so a quiet stream is not stuck.
   * a batch holding rows leaves after the linger; one holding only a position
   * can wait {@link POSITION_LINGER_MS} — and is cut short the moment a row
   * joins it, so a row never inherits the longer wait.
   */
  private scheduleFlush(bridgeId: string, stream: Stream): void {
    const want = stream.buffer.length > 0 ? 'rows' : 'position';
    if (stream.timer) {
      if (stream.timerFor === want || stream.timerFor === 'rows') return;
      clearTimeout(stream.timer); // a row arrived behind a bare position
    }
    const delay =
      want === 'rows'
        ? Math.max(0, runtimeConfig.cdcLingerMs)
        : Math.max(POSITION_LINGER_MS, runtimeConfig.cdcLingerMs);
    stream.timerFor = want;
    const timer = setTimeout(() => {
      stream.timer = null;
      stream.timerFor = null;
      if (this.streams.get(bridgeId) !== stream) return;
      // queued on the same chain, so a timed flush can never interleave with
      // a change being accepted
      stream.pending = stream.pending
        .then(() => this.flush(bridgeId, stream))
        .catch((err) => {
          this.logger.error(`CDC timed flush failed for ${bridgeId}: ${(err as Error).message}`);
        });
    }, delay);
    // a pending linger must not hold the process open
    timer.unref?.();
    stream.timer = timer;
  }

  /**
   * deliver the pending batch as ONE delivery, then checkpoint once and ack
   * once. per-row work here is what set the old throughput ceiling: a delivery,
   * a delivery record, a cursor write and a source ack for every single row.
   *
   * the cursor advances only after a successful delivery, so a crash mid-batch
   * replays that batch — absorbed by the watermark dedupe and by writes being
   * idempotent upserts.
   */
  private async flush(bridgeId: string, stream: Stream): Promise<void> {
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = null;
      stream.timerFor = null;
    }
    if (stream.tailCursor === null || stream.halted) return;

    // At most ONE delivery in flight. Waiting for the previous one here does
    // two things: batches reach the destination in the order they were read,
    // and the reader is throttled to one batch ahead rather than running away.
    // What it no longer does is make the reader wait for the WRITE — reading
    // the next batch now overlaps with writing this one.
    if (stream.inflight) await stream.inflight.catch(() => undefined);
    if (this.streams.get(bridgeId) !== stream) return;
    // the delivery we just waited for may have failed and stopped the bridge.
    // delivering the next batch now would checkpoint PAST the failed one
    if (stream.halted || stream.tailCursor === null) return;

    const items = stream.buffer;
    const op = stream.bufferOp ?? undefined;
    const reach = stream.tailCursor;
    stream.tailCursor = null;
    stream.buffer = [];
    stream.bufferKeys = new Set();
    stream.bufferOp = null;
    stream.byteCappedBatch = null;

    // deliberately not awaited: the caller returns to reading, and the next
    // flush awaits this through `inflight`
    stream.inflight = this.deliverBatch(bridgeId, stream, items, op, reach);
  }

  /** write one batch, record it, checkpoint the source */
  private async deliverBatch(
    bridgeId: string,
    stream: Stream,
    items: Buffered[],
    op: CdcOperation | undefined,
    /** how far the batch reaches: its last row, or a skipped position beyond it */
    lastCursor: string,
  ): Promise<void> {
    if (stream.halted) return;
    const bridge = stream.bridge;
    if (bridge.source.kind !== 'table') return;

    if (stream.spooled) {
      const entries = items.map((i) => ({ op: i.change.op, row: i.row, cursor: i.change.cursor }));
      await this.spoolBatch(bridgeId, stream, entries, lastCursor);
      return;
    }

    if (items.length === 0) {
      // nothing to deliver, only a position to move past
      await this.settle(bridgeId, stream, () => this.checkpoint(stream, stream.seq, lastCursor));
      return;
    }

    const rows = items.map((i) => i.row);
    const seq = stream.seq;
    // key on the batch's last cursor (stable per batch) so an at-least-once
    // re-delivery after a reconnect carries the SAME Idempotency-Key
    const idem =
      bridge.destination.kind === 'http' && bridge.destination.idempotency
        ? `${stream.jobId}:${lastCursor}`
        : undefined;

    // the operation drives both the {{$op}} token (HTTP) and insert/upsert vs
    // delete routing (database destinations)
    const outcome = await this.attempt(stream, rows, op, seq, undefined, idem);

    await this.settle(bridgeId, stream, async () => {
      if (outcome.status === 'success') {
        await this.record(stream, seq, rows, outcome);
        stream.consecutiveFailures = 0;
        await this.checkpoint(stream, seq + 1, lastCursor);
        return;
      }
      const nextSeq = await this.handleFailedBatch(bridgeId, stream, {
        rows,
        op,
        seq,
        cursor: lastCursor,
        outcome,
      });
      // null = the bridge was stopped. the cursor stays where it is, so the
      // next start reads this batch again
      if (nextSeq !== null) await this.checkpoint(stream, nextSeq, lastCursor);
    });
  }

  /* ----- delivery building blocks (shared by the direct and spooled paths) ----- */

  /** one delivery attempt. the sink reports failures as outcomes; a throw is folded into one */
  private async attempt(
    stream: Stream,
    rows: Row[],
    op: CdcOperation | undefined,
    seq: number,
    skipTargets?: readonly string[],
    idempotencyKey?: string,
  ): Promise<DeliveryOutcome> {
    const bridge = stream.bridge;
    const started = performance.now();
    try {
      const { outcome } = await this.sink.deliver(
        bridge,
        rows,
        {
          table: bridge.source.kind === 'table' ? bridge.source.table : '(query)',
          now: new Date().toISOString(),
          startIndex: seq,
          op,
          ...(skipTargets?.length ? { skipTargets: [...skipTargets] } : {}),
        },
        new AbortController().signal,
        idempotencyKey,
      );
      return outcome;
    } catch (err) {
      return {
        status: 'failed',
        httpStatus: null,
        attempts: 1,
        error: err instanceof Error ? err.message : String(err),
        requestBody: null,
        responseBody: null,
        durationMs: Math.round(performance.now() - started),
        op: op ?? null,
      };
    }
  }

  /** primary-key value(s) per row, matching the shape the replay path records */
  private rowKeys(stream: Stream, rows: Row[]): unknown[] | null {
    const pk = stream.primaryKey;
    if (!pk?.length) return null;
    return rows.map((r) => (pk.length === 1 ? r[pk[0]!] : pk.map((c) => r[c])));
  }

  private record(
    stream: Stream,
    sequence: number,
    rows: Row[],
    outcome: DeliveryOutcome,
  ): Promise<void> {
    return this.jobs.recordDelivery(
      stream.jobId,
      { sequence, rowIndex: sequence, rowCount: rows.length, rowKeys: this.rowKeys(stream, rows) },
      outcome,
    );
  }

  /**
   * make progress durable, then let the source forget it — in that order. the
   * provider's ack point (the Postgres slot's confirmed LSN) may only move once
   * the cursor is stored; a missed ack merely widens the replay window the
   * watermark dedupe absorbs.
   */
  private async checkpoint(stream: Stream, nextSeq: number, cursor: string): Promise<void> {
    if (stream.halted) return;
    await this.prisma.bridgeJob.update({
      where: { id: stream.jobId },
      data: { cursorOffset: nextSeq, cursorJson: JSON.stringify({ cursor }) },
    });
    stream.seq = nextSeq;
    stream.watermark = cursor;
    try {
      await stream.handle.ack?.(cursor);
    } catch {
      /* best-effort by contract */
    }
  }

  /**
   * run the metadata-store writes that follow a delivery (record, park,
   * checkpoint). every one of them is idempotent, so a blip in the store is
   * retried. if the store stays down the bridge stops WITHOUT advancing:
   * moving on from a write that may not have been recorded is how rows vanish,
   * and the source still holds everything after the last ack.
   */
  private async settle(
    bridgeId: string,
    stream: Stream,
    work: () => Promise<void>,
  ): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (stream.halted) return;
      try {
        await work();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CDC ${bridgeId}: could not record progress (attempt ${attempt + 1}/${SETTLE_ATTEMPTS}): ${lastError}`,
        );
        if (attempt < SETTLE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
    }
    await this.halt(
      bridgeId,
      stream,
      'failed',
      `Stopped without advancing, so nothing is skipped: progress could not be saved (${lastError}). Start the bridge again once the metadata store is reachable.`,
    );
  }

  /**
   * stop the bridge because of a failure. `halted` is set synchronously so the
   * change chain cannot deliver or checkpoint anything more; the teardown
   * itself has to happen outside that chain, because the provider's stop() may
   * wait for in-flight handlers — i.e. for this very call.
   */
  private async halt(
    bridgeId: string,
    stream: Stream,
    status: 'paused' | 'failed',
    message: string,
  ): Promise<void> {
    if (stream.halted) return;
    stream.halted = true;
    this.logger.warn(`CDC ${bridgeId}: ${message}`);
    await this.jobs.finalize(stream.jobId, status, message).catch(() => undefined);
    setImmediate(() => void this.teardown(bridgeId).catch(() => undefined));
  }

  /**
   * a batch failed. decide what happens to it, and return the sequence the
   * stream continues from — or null when the bridge was stopped instead.
   *
   * `abort`: stop, without moving. the batch is retried on the next start.
   *
   * `continue`: the bridge moves on, but never past rows that exist nowhere
   * else. the rows actually at fault are isolated from the healthy ones in
   * their batch and parked, in full, in the dead-letter queue FIRST. three
   * things turn a `continue` into a stop, because carrying on would only pour
   * the change stream into the metadata store: the failure is not confined to
   * a few rows, several batches in a row delivered nothing, or the queue is
   * full. in each case the cursor stays put and nothing is lost.
   */
  private async handleFailedBatch(
    bridgeId: string,
    stream: Stream,
    batch: {
      rows: Row[];
      op: CdcOperation | undefined;
      seq: number;
      cursor: string;
      outcome: DeliveryOutcome;
    },
  ): Promise<number | null> {
    const { rows, op, seq, cursor, outcome } = batch;
    const bridge = stream.bridge;
    const dest = bridge.destination;
    const reason = outcome.error ?? 'delivery failed';

    const stop = async (message: string): Promise<null> => {
      // recorded at `seq`, which is not consumed: the retried batch lands in
      // the same cell and turns it green
      await this.record(stream, seq, rows, outcome);
      await this.halt(bridgeId, stream, 'paused', message);
      return null;
    };

    if (bridge.delivery.onError === 'abort') {
      return stop(`Paused after a failed delivery (onError=abort): ${reason}`);
    }

    // ---- which rows are actually at fault?
    let delivered: Row[] = [];
    let attempts = outcome.attempts;
    let failed: { rows: Row[]; error: string; succeededTargets: string[] }[];

    // isolation re-delivers the healthy rows in smaller groups. that is only
    // safe to repeat where writes are idempotent: an append-only (`insert`)
    // target would hold those rows twice if the bridge then stopped and the
    // batch replayed. HTTP is excluded too — there the batch IS the payload
    const canIsolate =
      dest.kind === 'database' &&
      rows.length > 1 &&
      dest.targets.every((t) => t.writeMode !== 'insert');

    if (canIsolate) {
      const found = await isolateFailures(
        rows,
        async (part, skip) => {
          const o = await this.attempt(stream, part, op, seq, [...skip]);
          return {
            ok: o.status === 'success',
            error: o.error,
            succeededTargets: o.succeededTargets ?? [],
          };
        },
        { ...ISOLATION, batchError: reason, alreadySucceeded: outcome.succeededTargets ?? [] },
      );
      attempts += found.attempts;
      if (found.systemic) {
        return stop(
          `Stopped without advancing: this is not a few bad rows — ${found.reason}. Fix the destination and start the bridge again; the batch will be retried.`,
        );
      }
      delivered = found.delivered;
      failed = found.poisoned.map((p) => ({
        rows: [p.row],
        error: p.error,
        succeededTargets: p.succeededTargets,
      }));
    } else {
      failed = [];
      for (let i = 0; i < rows.length; i += DEAD_LETTER_CHUNK) {
        failed.push({
          rows: rows.slice(i, i + DEAD_LETTER_CHUNK),
          error: reason,
          succeededTargets: outcome.succeededTargets ?? [],
        });
      }
    }

    if (failed.length === 0) {
      // the batch failed as a whole but every row then went through on its
      // own: a transient failure, and nothing is left over
      stream.consecutiveFailures = 0;
      await this.record(stream, seq, rows, this.recovered(stream, rows, attempts, op));
      return seq + 1;
    }

    // ---- is carrying on actually safe?
    stream.consecutiveFailures = delivered.length > 0 ? 0 : stream.consecutiveFailures + 1;
    if (stream.consecutiveFailures >= runtimeConfig.maxConsecutiveFailures) {
      return stop(
        `Stopped without advancing: ${stream.consecutiveFailures} batches in a row delivered nothing, which points at the destination rather than the rows. Last error: ${reason}`,
      );
    }
    const failedRows = failed.reduce((n, f) => n + f.rows.length, 0);
    const held = await this.deadLetters.pendingRows(bridgeId);
    if (held + failedRows > runtimeConfig.deadLetterMaxRows) {
      return stop(
        `Stopped without advancing: the dead-letter queue is full (${held} rows waiting, limit ${runtimeConfig.deadLetterMaxRows}). Retry or discard them, then start the bridge again. Last error: ${reason}`,
      );
    }

    // ---- park first, record second, and only then (in the caller) advance.
    // delivered rows take `seq`; the rows set aside take the next cell, so the
    // timeline and the counters say exactly what happened to each
    const failedSeq = delivered.length > 0 ? seq + 1 : seq;
    const entries: NewDeadLetter[] = failed.map((f) => ({
      bridgeId,
      jobId: stream.jobId,
      sequence: failedSeq,
      op: op ?? null,
      rows: f.rows,
      cursor,
      error: f.error,
      succeededTargets: f.succeededTargets,
    }));
    await this.deadLetters.park(entries, { replaceFrom: seq });

    if (delivered.length > 0) {
      await this.record(stream, seq, delivered, this.recovered(stream, delivered, attempts, op));
    }
    const allFailed = failed.flatMap((f) => f.rows);
    await this.record(stream, failedSeq, allFailed, {
      ...outcome,
      attempts,
      error: `${failed[0]!.error} — ${failedRows} row${failedRows === 1 ? '' : 's'} moved to the dead-letter queue`,
      ...(dest.kind === 'database' ? previewBody(allFailed, dest.targets) : {}),
      op: op ?? null,
      // the queue tracks which targets each row still needs
      succeededTargets: null,
    });
    this.logger.warn(
      `CDC ${bridgeId}: ${failedRows} row(s) moved to the dead-letter queue, ${delivered.length} delivered: ${failed[0]!.error}`,
    );
    return failedSeq + 1;
  }

  /** the success record for rows that landed during (or because of) isolation */
  private recovered(
    stream: Stream,
    rows: Row[],
    attempts: number,
    op: CdcOperation | undefined,
  ): DeliveryOutcome {
    const dest = stream.bridge.destination;
    return {
      status: 'success',
      httpStatus: null,
      attempts,
      error: null,
      ...(dest.kind === 'database'
        ? previewBody(rows, dest.targets)
        : { requestBody: null, bodyTruncated: false }),
      responseBody: `wrote ${rows.length} after the batch was split to isolate failing rows`,
      durationMs: 0,
      op: op ?? null,
      succeededTargets: null,
    };
  }

  /**
   * Hand a batch to the durable spool and checkpoint the SOURCE against it.
   *
   * This is the point of the spool: once the changes are durably in Redis the
   * source's log may advance, so a slow or unreachable destination can no
   * longer pin WAL on the production database. The destination is caught up
   * separately by the consumer.
   */
  private async spoolBatch(
    bridgeId: string,
    stream: Stream,
    entries: SpoolEntry[],
    lastCursor: string,
  ): Promise<void> {
    // bounded: an unbounded spool would just move the unbounded growth from
    // the source's WAL into Redis. Blocking here propagates backpressure all
    // the way back to the reader, which is what we want when the destination
    // cannot keep up.
    while (this.streams.get(bridgeId) === stream) {
      let depth: number;
      try {
        depth = await this.spool.depth(bridgeId);
      } catch {
        break; // depth is only advisory; a failed append below is the real guard
      }
      if (depth < runtimeConfig.cdcSpoolMax) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.streams.get(bridgeId) !== stream || stream.halted) return;

    // the cursor may only advance once the spool has the changes, so a failed
    // append must never checkpoint. retry briefly, then stop the stream: the
    // source still holds everything after the last ack, so a restart replays
    // it and nothing is lost
    // a batch of nothing but filtered-out changes has no rows to spool, only a
    // position to move past
    let appended = entries.length === 0;
    for (let attempt = 0; attempt < 3 && !appended; attempt++) {
      try {
        await this.spool.append(bridgeId, entries);
        appended = true;
      } catch (err) {
        if (attempt === 2) {
          const message = (err as Error).message;
          await this.halt(
            bridgeId,
            stream,
            'failed',
            `Spool unavailable, stopped without advancing the cursor so nothing is lost: ${message}`,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }

    stream.watermark = lastCursor;
    try {
      await this.prisma.bridgeJob.update({
        where: { id: stream.jobId },
        data: { cursorJson: JSON.stringify({ cursor: lastCursor }) },
      });
      await stream.handle.ack?.(lastCursor);
    } catch (err) {
      // the changes are safely spooled; a missed checkpoint only means the
      // source replays them, which the watermark dedupe absorbs
      this.logger.warn(
        `CDC ${bridgeId}: spooled but could not checkpoint: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Split spooled items into runs that can each go out as ONE delivery: the
   * same operation throughout, and no repeated key — a multi-row upsert cannot
   * touch the same row twice.
   */
  private deliverableRuns(items: SpooledItem[], pk: string[] | null): SpooledItem[][] {
    const runs: SpooledItem[][] = [];
    let current: SpooledItem[] = [];
    let currentOp: string | null = null;
    let seen = new Set<string>();

    for (const item of items) {
      const sig = pk?.length
        ? JSON.stringify(pk.map((c) => item.entry.row[c]))
        : null;
      // a truncate or a notice is never part of a larger delivery
      const alone = (o: string | null): boolean => o === 'truncate' || o === 'notice';
      const breaks =
        current.length > 0 &&
        (currentOp !== item.entry.op ||
          alone(item.entry.op) ||
          (sig !== null && seen.has(sig)));
      if (breaks) {
        runs.push(current);
        current = [];
        seen = new Set();
      }
      current.push(item);
      currentOp = item.entry.op;
      if (sig !== null) seen.add(sig);
    }
    if (current.length > 0) runs.push(current);
    return runs;
  }

  /**
   * Drain the spool into the destination. Entries are trimmed only after they
   * have been delivered (or recorded as failed), so a crash redelivers them —
   * at-least-once, absorbed by the idempotent writes.
   */
  private startConsumer(bridgeId: string, stream: Stream): void {
    stream.consumer = (async () => {
      while (!stream.consumerStop && !stream.halted) {
        let items: SpooledItem[];
        try {
          items = await this.spool.read(bridgeId, stream.maxBatch);
        } catch (err) {
          this.logger.warn(
            `CDC ${bridgeId}: spool read failed: ${(err as Error).message}`,
          );
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (items.length === 0) {
          await new Promise((r) =>
            setTimeout(r, Math.max(10, runtimeConfig.cdcLingerMs)),
          );
          continue;
        }

        for (const run of this.deliverableRuns(items, stream.primaryKey)) {
          if (stream.consumerStop || stream.halted) return;
          const aborted = await this.deliverSpooled(bridgeId, stream, run);
          if (aborted) return;
        }
      }
    })().catch((err) => {
      this.logger.error(
        `CDC ${bridgeId}: spool consumer stopped: ${(err as Error).message}`,
      );
    });
  }

  /**
   * deliver one run, record it, and trim it from the spool. true = stop.
   *
   * the spool is this path's cursor: a run is trimmed only once it has been
   * delivered — or its failed rows parked in the dead-letter queue — so a stop
   * leaves it in place and the next start delivers it again.
   */
  private async deliverSpooled(
    bridgeId: string,
    stream: Stream,
    run: SpooledItem[],
  ): Promise<boolean> {
    const bridge = stream.bridge;
    if (bridge.source.kind !== 'table') return true;

    const rows = run.map((i) => i.entry.row);
    const entryOp = run[0]!.entry.op;
    const lastId = run[run.length - 1]!.id;
    const lastCursor = run[run.length - 1]!.entry.cursor;
    const seq = stream.seq;

    if (entryOp === 'notice') {
      await this.settle(bridgeId, stream, async () => {
        await this.jobs.recordNotice(stream.jobId, seq, String(rows[0]?.message ?? ''));
        await this.spool.trimThrough(bridgeId, lastId);
        await this.prisma.bridgeJob.update({
          where: { id: stream.jobId },
          data: { cursorOffset: seq + 1 },
        });
        stream.seq = seq + 1;
      });
      return stream.halted;
    }
    const op = entryOp;
    const idem =
      bridge.destination.kind === 'http' && bridge.destination.idempotency
        ? `${stream.jobId}:${lastCursor}`
        : undefined;

    const outcome = await this.attempt(stream, rows, op, seq, undefined, idem);

    const advance = async (nextSeq: number): Promise<void> => {
      // delivered (or safely parked): the spool may forget it. the head
      // advances, so reads stay cheap however many millions have passed through
      await this.spool.trimThrough(bridgeId, lastId);
      await this.prisma.bridgeJob.update({
        where: { id: stream.jobId },
        data: { cursorOffset: nextSeq },
      });
      stream.seq = nextSeq;
    };

    await this.settle(bridgeId, stream, async () => {
      if (outcome.status === 'success') {
        await this.record(stream, seq, rows, outcome);
        stream.consecutiveFailures = 0;
        await advance(seq + 1);
        return;
      }
      const nextSeq = await this.handleFailedBatch(bridgeId, stream, {
        rows,
        op,
        seq,
        cursor: lastCursor,
        outcome,
      });
      if (nextSeq !== null) await advance(nextSeq);
    });
    return stream.halted;
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let jobs: { bridgeId: string; id: string; cursorOffset: number; cursorJson: string | null }[];
    try {
      jobs = await this.prisma.bridgeJob.findMany({
        where: { status: 'running' },
        select: { bridgeId: true, id: true, cursorOffset: true, cursorJson: true },
      });
    } catch {
      return;
    }
    for (const r of jobs) {
      try {
        const bridge = await this.store.resolve(r.bridgeId);
        if (bridge.trigger.kind !== 'cdc' || !bridge.enabled || bridge.source.kind !== 'table') continue;
        const conn = await this.connStore.resolve(bridge.source.connectionId);
        const provider = this.providerFor(conn.engine);
        if (!provider) continue;
        await provider.provision(r.bridgeId, bridge, conn).catch(() => undefined);
        await this.beginStream(r.bridgeId, bridge, conn, provider, r.id, r.cursorOffset, readCursor(r.cursorJson));
        this.logger.log(`Resumed CDC stream for bridge ${r.bridgeId} (${conn.engine})`);
      } catch (err) {
        this.logger.warn(`Could not resume CDC ${r.bridgeId}: ${(err as Error).message}`);
      }
    }
  }
}
