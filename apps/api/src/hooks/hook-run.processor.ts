/**
 * BullMQ worker that executes a hook run. one job == one run (`jobId = runId`),
 * so the run's lifecycle is the job's lifecycle, no cross-job bookkeeping.
 *
 * streaming: rows are read a page at a time (table) or once (query) and grouped
 * into batches of `batchSize`. each batch is one HTTP delivery. only a single
 * page is ever held in memory and deliveries are awaited sequentially, which
 * gives natural backpressure and lets `minDelayMs` pace the send rate.
 *
 * resumability: the run checkpoints `cursorOffset` at every batch boundary
 * (always batch-aligned), so a stalled-job recovery or explicit resume restarts
 * mid-stream. the `(runId, sequence)` unique row plus a skip-set of
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
import { HookSinkService } from './hook-sink.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { RunRegistryService } from './run-registry.service';
import { HOOK_RUNS_QUEUE, type HookRunJob, type ResolvedHook } from './hooks.types';

interface StreamItem {
  row: Record<string, unknown>;
  index: number;
}

@Processor(HOOK_RUNS_QUEUE, { concurrency: runtimeConfig.hookConcurrency })
export class HookRunProcessor extends WorkerHost {
  private readonly logger = new Logger('HookRunProcessor');

  constructor(
    private readonly runs: HookRunService,
    private readonly store: HookStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: HookSinkService,
    private readonly registry: RunRegistryService,
  ) {
    super();
  }

  async process(job: Job<HookRunJob>): Promise<void> {
    const { runId } = job.data;
    const row = await this.runs.getRunRow(runId);

    // already settled by a previous attempt, or canceled before we started
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(row.status)) return;
    if (row.status === 'canceling') {
      await this.runs.finalize(runId, 'canceled');
      return;
    }

    const controller = this.registry.register(runId);
    try {
      // 'resend' jobs re-POST the captured payloads of failed deliveries; a
      // normal run streams rows from the source. both share the registry's
      // abort machinery so cancel works identically for either mode.
      if (job.data.mode === 'resend') {
        await this.runs.executeResend(runId, controller.signal);
      } else {
        await this.execute(runId, row.cursorOffset, row.configSnapshotJson, controller.signal);
      }
    } finally {
      this.registry.release(runId);
    }
  }

  private async execute(
    runId: string,
    startOffset: number,
    snapshotJson: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.runs.markRunning(runId);
    const hook = this.store.resolveSnapshot(snapshotJson);
    const { delivery } = hook;
    const batchSize = delivery.batchSize;
    const table = hook.source.kind === 'table' ? hook.source.table : '(query)';
    // single-column primary key (if any) is stored per delivery so failed rows
    // can later be retried precisely
    const pkColumn =
      hook.source.kind === 'table' ? await this.resolvePk(hook.source) : null;
    // sequences we must not (re)send: already delivered, or skipped
    const done = await this.runs.settledSequences(runId);
    // database targets that already committed inside failed deliveries: a
    // retry must skip those targets or insert mode would duplicate their rows
    const priorTargets = await this.runs.succeededTargetsBySequence(runId);

    // control polling is throttled to keep DB load negligible on big runs. it
    // serves two cross-process signals: cancellation (any worker may own the
    // job) and newly-queued skips (the UI can skip a row before we reach it)
    let lastControlCheck = 0;
    const stopRequested = async (): Promise<boolean> => {
      if (signal.aborted) return true;
      const now = Date.now();
      if (now - lastControlCheck < 750) return false;
      lastControlCheck = now;
      const [cancel, skips] = await Promise.all([
        this.runs.cancelRequested(runId),
        this.runs.skippedSequences(runId),
      ]);
      for (const s of skips) done.add(s);
      return cancel;
    };

    let buffer: Record<string, unknown>[] = [];
    let bufferStart = startOffset;

    try {
      for await (const item of this.streamRows(hook, runId, startOffset)) {
        if (await stopRequested()) {
          await this.runs.finalize(runId, 'canceled');
          return;
        }
        buffer.push(item.row);
        if (buffer.length === batchSize) {
          const stop = await this.flush(runId, table, buffer, bufferStart, done, priorTargets, hook, pkColumn, signal);
          buffer = [];
          bufferStart = item.index + 1;
          await this.runs.setCursor(runId, bufferStart);
          if (stop) {
            await this.runs.finalize(runId, 'failed', 'Stopped after a failed delivery (onError=abort).');
            return;
          }
          await sleep(delivery.minDelayMs, signal);
        }
      }

      if (buffer.length > 0) {
        if (await stopRequested()) {
          await this.runs.finalize(runId, 'canceled');
          return;
        }
        const stop = await this.flush(runId, table, buffer, bufferStart, done, priorTargets, hook, pkColumn, signal);
        if (stop) {
          await this.runs.finalize(runId, 'failed', 'Stopped after a failed delivery (onError=abort).');
          return;
        }
      }

      await this.runs.finalize(runId, (await stopRequested()) ? 'canceled' : 'completed');
    } catch (err) {
      if (signal.aborted || (await this.runs.cancelRequested(runId))) {
        await this.runs.finalize(runId, 'canceled');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Run ${runId} failed: ${message}`);
      await this.runs.finalize(runId, 'failed', message);
    }
  }

  /** render + deliver one batch, returns true if the run should abort */
  private async flush(
    runId: string,
    table: string,
    rows: Record<string, unknown>[],
    startIndex: number,
    done: Set<number>,
    priorTargets: Map<number, string[]>,
    hook: ResolvedHook,
    pkColumn: string | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    const batchSize = hook.delivery.batchSize;
    const sequence = Math.floor(startIndex / batchSize);
    if (done.has(sequence)) return false; // already delivered on an earlier attempt

    const now = new Date().toISOString();
    const { outcome } = await this.sink.deliver(
      hook,
      rows,
      { table, now, startIndex, skipTargets: priorTargets.get(sequence) },
      signal,
      `${runId}:${sequence}`,
    );
    const rowKeys = pkColumn ? rows.map((r) => r[pkColumn]) : null;
    await this.runs.recordDelivery(
      runId,
      { sequence, rowIndex: startIndex, rowCount: rows.length, rowKeys },
      outcome,
    );
    return outcome.status === 'failed' && hook.delivery.onError === 'abort';
  }

  /** the single-column primary key of a table source, if any */
  private async resolvePk(
    source: Extract<ResolvedHook['source'], { kind: 'table' }>,
  ): Promise<string | null> {
    const probe = await this.pool.withAdapter(source.connectionId, source.database, (a) =>
      a.browse({ schema: source.schema, table: source.table, limit: 1, offset: 0 }),
    );
    return probe.primaryKey.length === 1 ? probe.primaryKey[0]! : null;
  }

  /* ----- row streaming ----- */

  private streamRows(
    hook: ResolvedHook,
    runId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    return hook.source.kind === 'table'
      ? this.streamTable(hook, runId, startOffset)
      : this.streamQuery(hook, runId, startOffset);
  }

  private async *streamTable(
    hook: ResolvedHook,
    runId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    if (hook.source.kind !== 'table') return;
    const src = hook.source;
    const { sort, total, keysetColumn } = await this.resolveTableOrder(hook);
    await this.runs.setTotal(runId, total);
    const pageSize = hook.delivery.pageSize;
    const browse = (params: BrowseParams) =>
      this.pool.withAdapter(src.connectionId, src.database, (a) => a.browse(params));

    // keyset pagination on a unique key, O(1) per page no matter how deep we
    // are, so a multi-million-row replay stays fast (no OFFSET re-scan)
    if (keysetColumn) {
      let lastKey: unknown = null;
      let index = startOffset;
      if (startOffset > 0) {
        // resume: find the key of the last already-delivered row (one seek)
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
          yield { row, index };
          index++;
          lastKey = row[keysetColumn];
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
    hook: ResolvedHook,
  ): Promise<{ sort: SortSpec[]; total: number | null; keysetColumn: string | null }> {
    if (hook.source.kind !== 'table') return { sort: [], total: null, keysetColumn: null };
    const src = hook.source;
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
      `Table "${src.table}" has no primary key, so rows cannot be paged in a stable order. Add a sort to the hook to replay it safely.`,
    );
  }

  private async *streamQuery(
    hook: ResolvedHook,
    runId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    if (hook.source.kind !== 'query') return;
    const src = hook.source;
    const result = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.query(src.statement),
    );
    if (result.truncated) {
      throw new BadRequestError(
        `Query result was capped at ${result.rowCount} rows (limit ${runtimeConfig.maxQueryRows}). ` +
          `Narrow the query, or use a table source to replay every row.`,
      );
    }
    await this.runs.setTotal(runId, result.rows.length);
    for (let i = startOffset; i < result.rows.length; i++) {
      yield { row: result.rows[i]!, index: i };
    }
  }
}
