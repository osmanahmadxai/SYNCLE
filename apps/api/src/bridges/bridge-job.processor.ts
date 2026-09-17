/**
 * BullMQ worker that executes a bridge job. one queue entry == one bridge job
 * (the BullMQ id IS the job id), so the bridge job's lifecycle is the queue
 * entry's lifecycle, no cross-entry bookkeeping.
 *
 * streaming: rows are read a page at a time (table) or once (query) and grouped
 * into batches of `batchSize`. each batch is one HTTP delivery. only a single
 * page is ever held in memory and deliveries are awaited sequentially, which
 * gives natural backpressure and lets `minDelayMs` pace the send rate.
 *
 * resumability: the job checkpoints `cursorOffset` at every batch boundary
 * (always batch-aligned), so a stalled-job recovery or explicit resume restarts
 * mid-stream. the `(jobId, sequence)` unique row plus a skip-set of
 * already-succeeded sequences make re-delivery idempotent.
 * `sequence = floor(rowIndex / batchSize)` is deterministic, so the numbering
 * lines up across attempts.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { BadRequestError } from '@syncle/core';
import type { Job } from 'bullmq';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { runtimeConfig } from '../common/runtime-config';
import { SettingsStoreService } from '../settings/settings-store.service';
import { sleep } from './delivery.service';
import { BridgeSinkService } from './bridge-sink.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { JobRegistryService } from './job-registry.service';
import { TableReaderService } from './table-reader.service';
import {
  BRIDGE_JOBS_QUEUE,
  type BridgeJobPayload,
  type KeysetCheckpoint,
  type ResolvedBridge,
} from './bridges.types';

interface StreamItem {
  row: Record<string, unknown>;
  index: number;
  /** present on keyset-paginated streams: this row's checkpointable key */
  keyset?: KeysetCheckpoint;
}

/**
 * read the keyset checkpoint out of a job's cursorJson, if one was stored.
 * watch cursors share the column but use their own shape (no `keyset` key),
 * and legacy replay jobs stored nothing — both yield null.
 */
function parseKeysetCheckpoint(cursorJson: string | null): KeysetCheckpoint | null {
  if (!cursorJson) return null;
  try {
    const keyset = (JSON.parse(cursorJson) as { keyset?: KeysetCheckpoint }).keyset;
    return keyset && typeof keyset.column === 'string'
      ? { column: keyset.column, value: keyset.value }
      : null;
  } catch {
    return null;
  }
}

// the decorator is evaluated at import, before any saved setting can be read:
// it carries the environment's value, and `followSettings` takes over at boot
@Processor(BRIDGE_JOBS_QUEUE, { concurrency: runtimeConfig.jobConcurrency })
export class BridgeJobProcessor extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BridgeJobProcessor');
  private unfollow: (() => void) | null = null;

  constructor(
    private readonly jobs: BridgeJobService,
    private readonly store: BridgeStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly registry: JobRegistryService,
    private readonly settings: SettingsStoreService,
    private readonly reader: TableReaderService,
  ) {
    super();
  }

  /**
   * "Job concurrency" in Settings was stored and shown — with a note that it
   * applied after a restart — and then never read: the worker ran with the
   * environment's value whatever the dialog said. it now follows the setting,
   * at boot and whenever it is changed. (a BullMQ worker's concurrency can be
   * changed while it runs; jobs already in flight finish as they are.)
   */
  onApplicationBootstrap(): void {
    this.unfollow = this.settings.onChange((settings) => this.applyConcurrency(settings.jobConcurrency));
  }

  onModuleDestroy(): void {
    this.unfollow?.();
    this.unfollow = null;
  }

  private applyConcurrency(wanted: number): void {
    if (!Number.isInteger(wanted) || wanted < 1) return;
    try {
      if (this.worker.concurrency === wanted) return;
      this.worker.concurrency = wanted;
      this.logger.log(`Running up to ${wanted} replay job${wanted === 1 ? '' : 's'} at a time`);
    } catch (err) {
      // the worker is not up (no Redis yet): the decorator's value stands
      this.logger.debug(`Could not apply job concurrency: ${(err as Error).message}`);
    }
  }

  async process(job: Job<BridgeJobPayload>): Promise<void> {
    const { jobId } = job.data;
    const row = await this.jobs.getJobRow(jobId);

    // already settled by a previous attempt, or canceled before we started
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(row.status)) return;
    if (row.status === 'canceling') {
      await this.jobs.finalize(jobId, 'canceled');
      return;
    }

    const controller = this.registry.register(jobId);
    try {
      // 'resend' jobs re-POST the captured payloads of failed deliveries; a
      // normal job streams rows from the source. both share the registry's
      // abort machinery so cancel works identically for either mode.
      if (job.data.mode === 'resend') {
        await this.jobs.executeResend(jobId, controller.signal);
      } else {
        await this.execute(
          jobId,
          row.cursorOffset,
          parseKeysetCheckpoint(row.cursorJson),
          row.configSnapshotJson,
          row.bridgeId,
          controller.signal,
        );
      }
    } finally {
      this.registry.release(jobId);
    }
  }

  private async execute(
    jobId: string,
    startOffset: number,
    resumeKey: KeysetCheckpoint | null,
    snapshotJson: string,
    bridgeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.jobs.markRunning(jobId);
    const bridge = this.store.resolveSnapshot(snapshotJson, bridgeId);
    const { delivery } = bridge;
    const batchSize = delivery.batchSize;
    const table = bridge.source.kind === 'table' ? bridge.source.table : '(query)';
    // single-column primary key (if any) is stored per delivery so failed rows
    // can later be retried precisely
    const pkColumn =
      bridge.source.kind === 'table' ? await this.resolvePk(bridge.source) : null;
    // sequences we must not (re)send: already delivered, or skipped
    const done = await this.jobs.settledSequences(jobId);
    // database targets that already committed inside failed deliveries: a
    // retry must skip those targets or insert mode would duplicate their rows
    const priorTargets = await this.jobs.succeededTargetsBySequence(jobId);

    // control polling is throttled to keep DB load negligible on big jobs. it
    // serves two cross-process signals: cancellation (any worker may own the
    // job) and newly-queued skips (the UI can skip a row before we reach it)
    let lastControlCheck = 0;
    const stopRequested = async (): Promise<boolean> => {
      if (signal.aborted) return true;
      const now = Date.now();
      if (now - lastControlCheck < 750) return false;
      lastControlCheck = now;
      const [cancel, skips] = await Promise.all([
        this.jobs.cancelRequested(jobId),
        this.jobs.skippedSequences(jobId),
      ]);
      for (const s of skips) done.add(s);
      return cancel;
    };

    let buffer: Record<string, unknown>[] = [];
    let bufferStart = startOffset;
    // the keyset value of the newest row in the flushed prefix; checkpointed
    // with the offset so a resume lands on the exact next row even when the
    // table mutated between attempts (an OFFSET re-seek cannot promise that)
    let lastKeyset: KeysetCheckpoint | undefined;

    try {
      for await (const item of this.streamRows(bridge, jobId, startOffset, resumeKey)) {
        if (await stopRequested()) {
          await this.jobs.finalize(jobId, 'canceled');
          return;
        }
        buffer.push(item.row);
        if (item.keyset) lastKeyset = item.keyset;
        if (buffer.length === batchSize) {
          const stop = await this.flush(jobId, table, buffer, bufferStart, done, priorTargets, bridge, pkColumn, signal);
          buffer = [];
          bufferStart = item.index + 1;
          await this.jobs.setCursor(jobId, bufferStart, lastKeyset);
          if (stop) {
            await this.jobs.finalize(jobId, 'failed', 'Stopped after a failed delivery (onError=abort).');
            return;
          }
          await sleep(delivery.minDelayMs, signal);
        }
      }

      if (buffer.length > 0) {
        if (await stopRequested()) {
          await this.jobs.finalize(jobId, 'canceled');
          return;
        }
        const stop = await this.flush(jobId, table, buffer, bufferStart, done, priorTargets, bridge, pkColumn, signal);
        if (stop) {
          await this.jobs.finalize(jobId, 'failed', 'Stopped after a failed delivery (onError=abort).');
          return;
        }
      }

      await this.jobs.finalize(jobId, (await stopRequested()) ? 'canceled' : 'completed');
    } catch (err) {
      if (signal.aborted || (await this.jobs.cancelRequested(jobId))) {
        await this.jobs.finalize(jobId, 'canceled');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Job ${jobId} failed: ${message}`);
      await this.jobs.finalize(jobId, 'failed', message);
    }
  }

  /** render + deliver one batch, returns true if the job should abort */
  private async flush(
    jobId: string,
    table: string,
    rows: Record<string, unknown>[],
    startIndex: number,
    done: Set<number>,
    priorTargets: Map<number, string[]>,
    bridge: ResolvedBridge,
    pkColumn: string | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    const batchSize = bridge.delivery.batchSize;
    const sequence = Math.floor(startIndex / batchSize);
    if (done.has(sequence)) return false; // already delivered on an earlier attempt

    const now = new Date().toISOString();
    const { outcome } = await this.sink.deliver(
      bridge,
      rows,
      { table, now, startIndex, skipTargets: priorTargets.get(sequence) },
      signal,
      `${jobId}:${sequence}`,
    );
    const rowKeys = pkColumn ? rows.map((r) => r[pkColumn]) : null;
    await this.jobs.recordDelivery(
      jobId,
      { sequence, rowIndex: startIndex, rowCount: rows.length, rowKeys },
      outcome,
    );
    return outcome.status === 'failed' && bridge.delivery.onError === 'abort';
  }

  /** the single-column primary key of a table source, if any */
  private async resolvePk(
    source: Extract<ResolvedBridge['source'], { kind: 'table' }>,
  ): Promise<string | null> {
    const probe = await this.pool.withAdapter(source.connectionId, source.database, (a) =>
      a.browse({ schema: source.schema, table: source.table, limit: 1, offset: 0 }),
    );
    return probe.primaryKey.length === 1 ? probe.primaryKey[0]! : null;
  }

  /* ----- row streaming ----- */

  private streamRows(
    bridge: ResolvedBridge,
    jobId: string,
    startOffset: number,
    resumeKey: KeysetCheckpoint | null,
  ): AsyncGenerator<StreamItem> {
    return bridge.source.kind === 'table'
      ? this.streamTable(bridge, jobId, startOffset, resumeKey)
      : this.streamQuery(bridge, jobId, startOffset);
  }

  private async *streamTable(
    bridge: ResolvedBridge,
    jobId: string,
    startOffset: number,
    resumeKey: KeysetCheckpoint | null,
  ): AsyncGenerator<StreamItem> {
    // the paging itself lives in TableReaderService: a change-stream bridge
    // that copies its table first reads it the same way
    const order = await this.reader.resolveOrder(bridge);
    await this.jobs.setTotal(jobId, order.total);
    yield* this.reader.rows(bridge, { startOffset, resumeKey, order });
  }

  private async *streamQuery(
    bridge: ResolvedBridge,
    jobId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    if (bridge.source.kind !== 'query') return;
    const src = bridge.source;
    const result = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.query(src.statement),
    );
    if (result.truncated) {
      throw new BadRequestError(
        `Query result was capped at ${result.rowCount} rows — the "max query rows" limit (Settings › Engine, or the connection's own). ` +
          `Narrow the query, raise the limit, or use a table source to replay every row.`,
      );
    }
    await this.jobs.setTotal(jobId, result.rows.length);
    for (let i = startOffset; i < result.rows.length; i++) {
      yield { row: result.rows[i]!, index: i };
    }
  }
}
