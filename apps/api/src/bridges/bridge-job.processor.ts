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
import { Logger } from '@nestjs/common';
import {
  BadRequestError,
  type BrowseParams,
  type SortSpec,
} from '@syncle/core';
import type { Job } from 'bullmq';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { runtimeConfig } from '../common/runtime-config';
import { sleep } from './delivery.service';
import { BridgeSinkService } from './bridge-sink.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { JobRegistryService } from './job-registry.service';
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

@Processor(BRIDGE_JOBS_QUEUE, { concurrency: runtimeConfig.jobConcurrency })
export class BridgeJobProcessor extends WorkerHost {
  private readonly logger = new Logger('BridgeJobProcessor');

  constructor(
    private readonly jobs: BridgeJobService,
    private readonly store: BridgeStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly registry: JobRegistryService,
  ) {
    super();
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
    signal: AbortSignal,
  ): Promise<void> {
    await this.jobs.markRunning(jobId);
    const bridge = this.store.resolveSnapshot(snapshotJson);
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
    if (bridge.source.kind !== 'table') return;
    const src = bridge.source;
    const { sort, total, keysetColumn } = await this.resolveTableOrder(bridge);
    await this.jobs.setTotal(jobId, total);
    const pageSize = bridge.delivery.pageSize;
    const browse = (params: BrowseParams) =>
      this.pool.withAdapter(src.connectionId, src.database, (a) => a.browse(params));

    // keyset pagination on a unique key, O(1) per page no matter how deep we
    // are, so a multi-million-row replay stays fast (no OFFSET re-scan)
    if (keysetColumn) {
      let lastKey: unknown = null;
      let index = startOffset;
      if (startOffset > 0) {
        if (resumeKey && resumeKey.column === keysetColumn) {
          // exact resume from the checkpointed key — immune to rows added or
          // removed under the job, and no deep-OFFSET seek query
          lastKey = resumeKey.value;
        } else {
          // legacy jobs (no checkpoint) or a changed sort column: fall back to
          // seeking the key of the last already-delivered row by offset
          const seek = await browse({
            schema: src.schema,
            table: src.table,
            filters: src.filters,
            sort,
            limit: 1,
            offset: startOffset - 1,
          });
          lastKey = seek.rows[0]?.[keysetColumn] ?? null;
        }
      }
      for (;;) {
        const filters = [
          ...(src.filters ?? []),
          ...(lastKey != null
            ? [{ column: keysetColumn, operator: 'gt' as const, value: lastKey }]
            : []),
        ];
        const page = await browse({
          schema: src.schema,
          table: src.table,
          filters,
          sort,
          limit: pageSize,
          offset: 0,
        });
        for (const row of page.rows) {
          lastKey = row[keysetColumn];
          yield { row, index, keyset: { column: keysetColumn, value: lastKey } };
          index++;
        }
        if (!page.hasMore || page.rows.length === 0) return;
      }
    }

    // fallback: OFFSET pagination (composite key or custom non-unique sort)
    let offset = startOffset;
    for (;;) {
      const page = await browse({
        schema: src.schema,
        table: src.table,
        filters: src.filters,
        sort,
        limit: pageSize,
        offset,
      });
      for (let i = 0; i < page.rows.length; i++) {
        yield { row: page.rows[i]!, index: offset + i };
      }
      if (!page.hasMore || page.rows.length === 0) return;
      offset += page.rows.length;
    }
  }

  /**
   * a stable order is mandatory: `LIMIT/OFFSET` without `ORDER BY` can skip or
   * repeat rows across pages. use the caller's sort, else the primary key, and
   * report whether we can keyset-paginate (single, uniquely-ordered key).
   */
  private async resolveTableOrder(
    bridge: ResolvedBridge,
  ): Promise<{ sort: SortSpec[]; total: number | null; keysetColumn: string | null }> {
    if (bridge.source.kind !== 'table') return { sort: [], total: null, keysetColumn: null };
    const src = bridge.source;
    const probe = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.browse({ schema: src.schema, table: src.table, filters: src.filters, limit: 1, offset: 0 }),
    );
    const singlePk = probe.primaryKey.length === 1 ? probe.primaryKey[0]! : null;

    if (src.sort && src.sort.length > 0) {
      // keyset only if the caller's order is exactly the (unique) primary key asc
      const s = src.sort;
      const keyset =
        s.length === 1 && s[0]!.column === singlePk && s[0]!.direction === 'asc'
          ? singlePk
          : null;
      return { sort: src.sort, total: probe.total, keysetColumn: keyset };
    }
    if (probe.primaryKey.length > 0) {
      return {
        sort: probe.primaryKey.map((column) => ({ column, direction: 'asc' as const })),
        total: probe.total,
        keysetColumn: singlePk,
      };
    }
    throw new BadRequestError(
      `Table "${src.table}" has no primary key, so rows cannot be paged in a stable order. Add a sort to the bridge to replay it safely.`,
    );
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
        `Query result was capped at ${result.rowCount} rows (limit ${runtimeConfig.maxQueryRows}). ` +
          `Narrow the query, or use a table source to replay every row.`,
      );
    }
    await this.jobs.setTotal(jobId, result.rows.length);
    for (let i = startOffset; i < result.rows.length; i++) {
      yield { row: result.rows[i]!, index: i };
    }
  }
}
