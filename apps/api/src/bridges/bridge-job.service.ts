/**
 * bridge-job lifecycle + queue glue. owns every Prisma write to `bridge_jobs` /
 * `bridge_deliveries` and the BullMQ enqueue/cancel paths, so the processor only
 * has to stream and deliver.
 *
 * durability model: one BullMQ entry per bridge job (queue id = job id). a
 * crashed job is
 * recovered by BullMQ's stalled-job detection and resumed from its checkpoint
 * (`cursorOffset`, plus the last keyset value for keyset-paginated streams);
 * on boot we also re-enqueue any non-terminal job so nothing is orphaned.
 */
import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  type CdcOperation,
  type DeliveryStatus,
  type BridgeDelivery,
  type BridgeJob,
  type BridgeJobStatus,
  NotFoundError,
} from '@syncle/core';
import { Queue } from 'bullmq';
import type {
  BridgeDelivery as DeliveryRow,
  BridgeJob as JobRow,
} from '@prisma/client';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { PrismaService } from '../common/prisma.service';
import { BridgeStoreService } from './bridge-store.service';
import { DeliveryService, sleep } from './delivery.service';
import { DatabaseSinkService } from './database-sink.service';
import { JobRegistryService } from './job-registry.service';
import {
  BRIDGE_JOBS_QUEUE,
  type DeliveryOutcome,
  type BridgeJobPayload,
  type KeysetCheckpoint,
} from './bridges.types';
import { ensureQueueReady } from './queue.util';

const ACTIVE: BridgeJobStatus[] = ['queued', 'running', 'canceling'];
const TERMINAL: BridgeJobStatus[] = [
  'completed',
  'failed',
  'canceled',
  'interrupted',
];

@Injectable()
export class BridgeJobService implements OnModuleInit {
  private readonly logger = new Logger('BridgeJob');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly registry: JobRegistryService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
    private readonly databaseSink: DatabaseSinkService,
    @InjectQueue(BRIDGE_JOBS_QUEUE) private readonly queue: Queue<BridgeJobPayload>,
  ) {}

  /**
   * queue a RESEND of a job's failed deliveries: their captured request bodies
   * are re-POSTed to the bridge's CURRENT destination, works for every bridge type
   * (replay / watch / cdc), ideal after fixing a bad URL or a down endpoint.
   * a delivery that succeeds flips from failed to success (counters adjust).
   *
   * two retry flavors exist, keep them straight:
   *  - resend (this): re-send the CAPTURED payloads as-is, no source access.
   *  - retryFailed (`start({retryFailedOf})`): re-STREAM the failed rows from
   *    the source and re-render them (fresh data, fresh config).
   *
   * the loop itself runs on the BullMQ worker ({@link executeResend}) so this
   * endpoint returns immediately and the operation is cancelable through the
   * job registry, exactly like a normal job.
   */
  async resendFailed(bridgeId: string, jobId: string): Promise<BridgeJob> {
    const job = await this.getJobRow(jobId);
    if (job.bridgeId !== bridgeId) throw new NotFoundError(`Job "${jobId}" not found`);
    // an active job may still be writing these same delivery rows; re-sending
    // concurrently would interleave upserts on the same (jobId, sequence) keys
    if (ACTIVE.includes(job.status as BridgeJobStatus)) {
      throw new ConflictError(
        'This job is still active. Stop it (or wait for it to finish) before retrying failed deliveries.',
      );
    }
    await this.store.get(bridgeId); // 404s if the bridge is gone
    const failedCount = await this.prisma.bridgeDelivery.count({
      where: { jobId, status: 'failed' },
    });
    if (failedCount === 0) throw new BadRequestError('No failed deliveries to retry.');

    await ensureQueueReady(this.queue);
    await this.clearSettledJob(jobId);
    const row = await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: { status: 'queued', error: null, finishedAt: null },
    });
    await this.enqueue(jobId, bridgeId, 'resend');
    return this.toJob(row);
  }

  /**
   * worker-side body of a resend (see {@link resendFailed}), invoked by the
   * processor with the job registry's abort signal so a cancel stops it
   * between deliveries. deliveries that cannot be replayed faithfully — the
   * captured body was truncated at the storage cap, or no rows can be
   * recovered from it — are refused with a per-delivery error and stay
   * failed; they must be retried from the source instead. a database delivery
   * is NEVER flipped to success unless rows were actually written.
   */
  async executeResend(jobId: string, signal: AbortSignal): Promise<void> {
    const job = await this.getJobRow(jobId);
    await this.markRunning(jobId);
    const bridge = await this.store.resolve(job.bridgeId);
    const failed = await this.prisma.bridgeDelivery.findMany({
      where: { jobId, status: 'failed' },
      orderBy: { sequence: 'asc' },
      take: 2000,
    });
    const dest = bridge.destination;

    // cross-process control polling, throttled like the job processor's.
    // 'canceled' = a cancel was requested; 'detached' = something else already
    // re-statused the job (e.g. watch/cdc stop() paused it out from under us),
    // so stand down WITHOUT overwriting that externally-set status.
    let lastControlCheck = 0;
    const stopRequested = async (): Promise<'canceled' | 'detached' | null> => {
      if (signal.aborted) return 'canceled';
      const now = Date.now();
      if (now - lastControlCheck < 750) return null;
      lastControlCheck = now;
      const r = await this.prisma.bridgeJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (!r || r.status === 'canceling' || r.status === 'canceled') return 'canceled';
      return r.status === 'running' ? null : 'detached';
    };

    try {
      for (const d of failed) {
        const stop = await stopRequested();
        if (stop) {
          if (stop === 'canceled') await this.finalize(jobId, 'canceled');
          return;
        }

        // a failed delivery keeps its existing (failed) status and context,
        // only the error text changes to say why the resend refused it
        const refuse = (why: string): DeliveryOutcome => ({
          status: 'failed',
          httpStatus: d.httpStatus,
          attempts: d.attempts,
          error: why,
          requestBody: d.requestBody,
          responseBody: d.responseBody,
          durationMs: d.durationMs ?? 0,
        });

        let outcome: DeliveryOutcome;
        if (d.bodyTruncated) {
          // the capture was cut at the storage cap: re-sending it would push
          // truncated garbage (HTTP) or write nothing at all (database)
          outcome = refuse(
            'The captured payload was truncated at the storage cap, so it cannot be re-sent faithfully. Retry the failed rows from the source instead.',
          );
        } else {
          let body: unknown = null;
          if (d.requestBody) {
            try {
              body = JSON.parse(d.requestBody);
            } catch {
              body = d.requestBody;
            }
          }
          if (dest.kind === 'database') {
            // the captured requestBody is the already-mapped target row(s);
            // replay it through the sink with identity mapping, preserving the
            // persisted operation so a CDC delete retries as a keyed delete —
            // not as an upsert that would resurrect the deleted row
            const rows = (Array.isArray(body) ? body : [body]).filter(
              (r): r is Record<string, unknown> => !!r && typeof r === 'object',
            );
            if (rows.length === 0 && d.rowCount > 0) {
              // nothing recoverable to write: succeeding here would flip the
              // cell green while zero rows actually landed in the target
              outcome = refuse(
                'No rows could be recovered from the captured payload, so nothing would be written. Retry the failed rows from the source instead.',
              );
            } else {
              const retryTargets = dest.targets.map((t) => ({ ...t, mapping: [] }));
              const skip = d.succeededTargetsJson
                ? new Set(JSON.parse(d.succeededTargetsJson) as string[])
                : undefined;
              outcome = await this.databaseSink.deliver(
                bridge,
                retryTargets,
                rows,
                (d.op ?? undefined) as CdcOperation | undefined,
                skip,
              );
            }
          } else {
            const idem = dest.idempotency ? `${jobId}:${d.sequence}` : undefined;
            outcome = await this.delivery.send(body, dest, bridge.delivery, signal, idem);
          }
        }
        await this.recordDelivery(
          jobId,
          {
            sequence: d.sequence,
            rowIndex: d.rowIndex,
            rowCount: d.rowCount,
            rowKeys: d.rowKeysJson ? (JSON.parse(d.rowKeysJson) as unknown[]) : null,
          },
          outcome,
        );
        if (bridge.delivery.minDelayMs) await sleep(bridge.delivery.minDelayMs, signal);
      }

      const remaining = await this.prisma.bridgeDelivery.count({
        where: { jobId, status: 'failed' },
      });
      lastControlCheck = 0; // force a real status check before finalizing
      const stop = await stopRequested();
      if (stop) {
        if (stop === 'canceled') await this.finalize(jobId, 'canceled');
        return;
      }
      await this.finalize(
        jobId,
        remaining === 0 ? 'completed' : 'failed',
        remaining === 0
          ? null
          : `${remaining} deliver${remaining === 1 ? 'y is' : 'ies are'} still failing after the retry.`,
      );
    } catch (err) {
      if (signal.aborted || (await this.cancelRequested(jobId))) {
        await this.finalize(jobId, 'canceled');
        return;
      }
      await this.finalize(jobId, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  /* ----- prepare (queue without sending) ----- */

  /**
   * create a "draft" job so the UI shows the planned deliveries as queued the
   * moment a bridge is created, before anything is sent. replaces any prior draft
   * for the bridge. best-effort total so the timeline can render cells.
   */
  async prepare(
    bridgeId: string,
    opts: { onlyExisting?: boolean } = {},
  ): Promise<BridgeJob | null> {
    const bridge = await this.store.get(bridgeId);
    // drafts model a finite replay; watch bridges are live listeners, not drafts
    if (bridge.trigger.kind !== 'replay') return null;
    // don't clobber an in-flight job with a draft
    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ACTIVE } },
    });
    if (active) return null;

    const { count } = await this.prisma.bridgeJob.deleteMany({
      where: { bridgeId, status: 'draft' },
    });
    // on update we only refresh a draft that already existed, never add a fresh
    // draft to a bridge that has already been run
    if (opts.onlyExisting && count === 0) return null;

    const snapshotJson = await this.store.snapshotJson(bridgeId);
    const total = await this.computeTotal(snapshotJson).catch(() => null);
    const row = await this.prisma.bridgeJob.create({
      data: {
        id: randomUUID(),
        bridgeId,
        status: 'draft',
        configSnapshotJson: snapshotJson,
        totalCount: total,
      },
    });
    return this.toJob(row);
  }

  /* ----- start / resume / retry ----- */

  async start(
    bridgeId: string,
    opts: { resumeJobId?: string; jobId?: string; retryFailedOf?: string } = {},
  ): Promise<BridgeJob> {
    const bridge = await this.store.get(bridgeId); // 404s if the bridge is gone
    // replay-only: watch/CDC bridges are live listeners with their own start
    // endpoint. pushing one through the replay queue would re-stream (and
    // re-deliver) the WHOLE table instead of its changes.
    if (bridge.trigger.kind !== 'replay') {
      throw new BadRequestError(
        'This bridge is event-driven, not replayable. Start listening with POST /bridges/:id/watch/start instead.',
      );
    }

    if (opts.retryFailedOf) return this.retryFailed(bridgeId, opts.retryFailedOf);
    if (opts.resumeJobId) return this.resume(bridgeId, opts.resumeJobId);

    // starting a prepared draft, or the bridge's existing draft if any
    const draft = opts.jobId
      ? await this.getJobRow(opts.jobId)
      : await this.prisma.bridgeJob.findFirst({
          where: { bridgeId, status: 'draft' },
        });
    if (draft && draft.bridgeId === bridgeId && draft.status === 'draft') {
      await ensureQueueReady(this.queue);
      const row = await this.prisma.bridgeJob.update({
        where: { id: draft.id },
        data: { status: 'queued', startedAt: new Date() },
      });
      await this.enqueue(draft.id, bridgeId);
      return this.toJob(row);
    }

    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ACTIVE } },
    });
    if (active) {
      throw new ConflictError(
        'A job is already in progress for this bridge. Cancel it before starting another.',
      );
    }

    // resume the most recent paused/stopped job in place (one bridge job per
    // queue entry)
    // rather than spawning a new one each time. a finished job starts fresh.
    const latest = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['paused', 'canceled', 'interrupted', 'failed'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (latest) return this.resume(bridgeId, latest.id);

    await ensureQueueReady(this.queue);
    const id = randomUUID();
    const snapshotJson = await this.store.snapshotJson(bridgeId);
    const total = await this.computeTotal(snapshotJson).catch(() => null);
    const row = await this.prisma.bridgeJob.create({
      data: {
        id,
        bridgeId,
        status: 'queued',
        configSnapshotJson: snapshotJson,
        totalCount: total,
      },
    });
    await this.enqueue(id, bridgeId);
    return this.toJob(row);
  }

  /**
   * re-send the rows that FAILED in this job, IN PLACE. the same job and the
   * same delivery cells are reused, so failed (red) rows flip to delivered
   * (green) on success. the config snapshot is refreshed to the bridge's current
   * config so a fixed URL/headers/auth take effect. resetting the cursor makes
   * the worker re-stream and re-send only the not-yet-settled (failed) rows;
   * already-delivered/skipped rows are skipped untouched.
   */
  private async retryFailed(bridgeId: string, jobId: string): Promise<BridgeJob> {
    const job = await this.getJobRow(jobId);
    if (job.bridgeId !== bridgeId)
      throw new NotFoundError(`Job "${jobId}" not found`);
    if (!TERMINAL.includes(job.status as BridgeJobStatus)) {
      throw new ConflictError('Wait for the job to finish before retrying.');
    }
    const failedCount = await this.prisma.bridgeDelivery.count({
      where: { jobId, status: 'failed' },
    });
    if (failedCount === 0)
      throw new BadRequestError('No failed rows to retry.');

    await ensureQueueReady(this.queue);
    const updated = await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: {
        status: 'queued',
        cursorOffset: 0,
        // the keyset checkpoint belongs to the reset offset — keeping it would
        // make the re-stream resume mid-table and skip the earlier failed rows
        cursorJson: null,
        error: null,
        finishedAt: null,
        configSnapshotJson: await this.store.snapshotJson(bridgeId),
      },
    });
    await this.enqueue(jobId, bridgeId);
    return this.toJob(updated);
  }

  /** best-effort planned row count for a source, used to render the timeline */
  private async computeTotal(snapshotJson: string): Promise<number | null> {
    const bridge = this.store.resolveSnapshot(snapshotJson);
    if (bridge.source.kind === 'table') {
      const src = bridge.source;
      const page = await this.pool.withAdapter(
        src.connectionId,
        src.database,
        (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            filters: src.filters,
            limit: 1,
            offset: 0,
          }),
      );
      return page.total;
    }
    const result = await this.pool.withAdapter(
      bridge.source.connectionId,
      bridge.source.database,
      (a) => a.query(bridge.source.kind === 'query' ? bridge.source.statement : ''),
    );
    return result.rows.length;
  }

  private async resume(bridgeId: string, jobId: string): Promise<BridgeJob> {
    const row = await this.getJobRow(jobId);
    if (row.bridgeId !== bridgeId)
      throw new NotFoundError(`Job "${jobId}" not found`);
    const resumable: BridgeJobStatus[] = ['failed', 'canceled', 'paused', 'interrupted'];
    if (!resumable.includes(row.status as BridgeJobStatus)) {
      throw new ConflictError(
        `Job "${jobId}" cannot be resumed (status: ${row.status}).`,
      );
    }
    await ensureQueueReady(this.queue);
    // resume the REMAINING rows with the bridge's CURRENT config, so edits made
    // after the job started (e.g. fewer columns, a new endpoint) take effect
    const reset = await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: {
        status: 'queued',
        error: null,
        finishedAt: null,
        configSnapshotJson: await this.store.snapshotJson(bridgeId),
      },
    });
    await this.enqueue(jobId, bridgeId);
    return this.toJob(reset);
  }

  private async enqueue(
    jobId: string,
    bridgeId: string,
    mode?: 'resend',
  ): Promise<void> {
    await this.queue.add(
      mode ?? 'job',
      { jobId, bridgeId, ...(mode ? { mode } : {}) },
      { jobId: jobId, removeOnComplete: true, removeOnFail: 500, attempts: 1 },
    );
  }

  /**
   * deterministic jobId (= jobId) means `add` is a no-op if a job with that id
   * already exists — including a LINGERING failed/completed one (removeOnFail
   * keeps 500) — so clear those out first or the add silently does nothing.
   * returns the lingering job's resend mode (if any) so boot recovery can
   * re-enqueue an interrupted resend as a resend, not a fresh stream.
   */
  private async clearSettledJob(jobId: string): Promise<'resend' | undefined> {
    try {
      const existing = await this.queue.getJob(jobId);
      if (!existing) return undefined;
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') await existing.remove();
      return (existing.data as BridgeJobPayload).mode;
    } catch {
      /* best-effort, the add that follows still surfaces real queue failures */
      return undefined;
    }
  }

  /* ----- cancel ----- */

  async cancel(bridgeId: string, jobId: string): Promise<BridgeJob> {
    const row = await this.getJobRow(jobId);
    if (row.bridgeId !== bridgeId)
      throw new NotFoundError(`Job "${jobId}" not found`);
    if (TERMINAL.includes(row.status as BridgeJobStatus)) return this.toJob(row);

    const updated = await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: { status: 'canceling' },
    });
    this.registry.abort(jobId); // stop the in-flight fetch immediately
    await this.queue.remove(jobId).catch(() => {}); // best-effort, worker also self-stops
    return this.toJob(updated);
  }

  /* ----- queries ----- */

  async listJobs(bridgeId: string, limit = 50): Promise<BridgeJob[]> {
    const rows = await this.prisma.bridgeJob.findMany({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toJob(r));
  }

  /**
   * latest job status for every bridge in a workspace, in one query — feeds the
   * workspace map so its edges can show live/failed/idle without N requests.
   */
  async workspaceStatuses(
    workspaceId: string,
  ): Promise<{ bridgeId: string; active: boolean; lastStatus: BridgeJobStatus }[]> {
    const latest = await this.prisma.bridgeJob.findMany({
      where: { bridge: { workspaceId } },
      orderBy: { startedAt: 'desc' },
      distinct: ['bridgeId'],
      select: { bridgeId: true, status: true },
    });
    return latest.map((r) => ({
      bridgeId: r.bridgeId,
      active: ACTIVE.includes(r.status as BridgeJobStatus),
      lastStatus: r.status as BridgeJobStatus,
    }));
  }

  async getJob(bridgeId: string, jobId: string): Promise<BridgeJob> {
    const row = await this.getJobRow(jobId);
    if (row.bridgeId !== bridgeId)
      throw new NotFoundError(`Job "${jobId}" not found`);
    return this.toJob(row);
  }

  async listDeliveries(
    jobId: string,
    opts: {
      status?: 'success' | 'failed' | 'skipped';
      /** inclusive sequence window, lets the UI page the timeline cheaply */
      from?: number;
      to?: number;
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<BridgeDelivery[]> {
    const sequence =
      opts.from != null || opts.to != null
        ? {
            ...(opts.from != null ? { gte: opts.from } : {}),
            ...(opts.to != null ? { lte: opts.to } : {}),
          }
        : undefined;
    const rows = await this.prisma.bridgeDelivery.findMany({
      where: {
        jobId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(sequence ? { sequence } : {}),
      },
      orderBy: { sequence: 'asc' },
      skip: opts.offset ?? 0,
      take: Math.min(opts.limit ?? 500, 2000),
    });
    return rows.map((r) => this.toDelivery(r));
  }

  /**
   * mark sequences to skip. best-effort: only effective while the sequence is
   * still queued (the worker checks the skip set before sending). creates a
   * `skipped` delivery row for each sequence that has no delivery yet.
   */
  async skipDeliveries(jobId: string, sequences: number[]): Promise<number> {
    const job = await this.getJobRow(jobId);
    const batchSize = this.snapshotBatchSize(job.configSnapshotJson);
    const totalCount = job.totalCount;

    const existing = await this.prisma.bridgeDelivery.findMany({
      where: { jobId, sequence: { in: sequences } },
      select: { sequence: true },
    });
    const taken = new Set(existing.map((e) => e.sequence));
    const fresh = [...new Set(sequences)].filter((s) => !taken.has(s));
    if (fresh.length === 0) return 0;

    // work out the actual row count for each sequence. the last batch may be
    // smaller than batchSize when totalCount isn't perfectly divisible
    const lastSeq =
      totalCount != null ? Math.ceil(totalCount / batchSize) - 1 : null;
    const lastBatchSize =
      lastSeq != null && totalCount != null
        ? totalCount - lastSeq * batchSize
        : batchSize;

    const rowCountFor = (seq: number): number =>
      lastSeq != null && seq === lastSeq ? lastBatchSize : batchSize;

    const skippedRows = fresh.reduce((acc, s) => acc + rowCountFor(s), 0);

    await this.prisma.$transaction([
      this.prisma.bridgeDelivery.createMany({
        data: fresh.map((sequence) => ({
          id: randomUUID(),
          jobId,
          sequence,
          rowIndex: sequence * batchSize,
          rowCount: rowCountFor(sequence),
          status: 'skipped',
          attempts: 0,
        })),
      }),
      this.prisma.bridgeJob.update({
        where: { id: jobId },
        data: { skippedCount: { increment: skippedRows } },
      }),
    ]);
    return fresh.length;
  }

  /** sequences explicitly skipped, the worker must not send these */
  async skippedSequences(jobId: string): Promise<Set<number>> {
    const rows = await this.prisma.bridgeDelivery.findMany({
      where: { jobId, status: 'skipped' },
      select: { sequence: true },
    });
    return new Set(rows.map((r) => r.sequence));
  }

  private snapshotBatchSize(snapshotJson: string): number {
    try {
      const snap = JSON.parse(snapshotJson) as {
        delivery?: { batchSize?: number };
      };
      return Math.max(1, snap.delivery?.batchSize ?? 1);
    } catch {
      return 1;
    }
  }

  /* ----- processor-facing mutations ----- */

  async getJobRow(jobId: string): Promise<JobRow> {
    const row = await this.prisma.bridgeJob.findUnique({ where: { id: jobId } });
    if (!row) throw new NotFoundError(`Job "${jobId}" not found`);
    return row;
  }

  /**
   * whether a stop was requested for this job. works across processes (any
   * BullMQ worker can own the job, so the DB status is authoritative, not just
   * the local abort signal).
   */
  async cancelRequested(jobId: string): Promise<boolean> {
    const r = await this.prisma.bridgeJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return !r || r.status === 'canceling' || r.status === 'canceled';
  }

  async markRunning(jobId: string): Promise<void> {
    await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: { status: 'running' },
    });
  }

  async setTotal(jobId: string, totalCount: number | null): Promise<void> {
    await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: { totalCount },
    });
  }

  /**
   * checkpoint the resume position. for keyset-paginated streams the actual
   * last keyset value is persisted alongside the offset: resuming from the
   * stored key lands on the exact row after the last delivered one even when
   * the table changed between attempts, which an OFFSET re-seek cannot
   * guarantee. `null` clears a stale checkpoint (offset-paginated streams).
   */
  async setCursor(
    jobId: string,
    cursorOffset: number,
    keyset?: KeysetCheckpoint | null,
  ): Promise<void> {
    await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: {
        cursorOffset,
        ...(keyset !== undefined
          ? { cursorJson: keyset ? JSON.stringify({ keyset }) : null }
          : {}),
      },
    });
  }

  /**
   * sequences the worker must not (re)send: already delivered, or skipped.
   * makes resume idempotent and honors skips queued before the job.
   */
  async settledSequences(jobId: string): Promise<Set<number>> {
    const rows = await this.prisma.bridgeDelivery.findMany({
      where: { jobId, status: { in: ['success', 'skipped'] } },
      select: { sequence: true },
    });
    return new Set(rows.map((r) => r.sequence));
  }

  /**
   * per-sequence database-target keys that already committed inside a FAILED
   * delivery (partial fan-out). the worker feeds these back to the sink on a
   * retry so the targets that succeeded aren't written twice.
   */
  async succeededTargetsBySequence(jobId: string): Promise<Map<number, string[]>> {
    const rows = await this.prisma.bridgeDelivery.findMany({
      where: { jobId, status: 'failed', succeededTargetsJson: { not: null } },
      select: { sequence: true, succeededTargetsJson: true },
    });
    const map = new Map<number, string[]>();
    for (const r of rows) {
      try {
        const keys = JSON.parse(r.succeededTargetsJson!) as string[];
        if (Array.isArray(keys) && keys.length > 0) map.set(r.sequence, keys);
      } catch {
        /* unreadable checkpoint: retry every target (safe for upsert/delete) */
      }
    }
    return map;
  }

  /** persist one delivery and advance the job's counters atomically */
  async recordDelivery(
    jobId: string,
    meta: {
      sequence: number;
      rowIndex: number;
      rowCount: number;
      rowKeys: unknown[] | null;
    },
    outcome: DeliveryOutcome,
  ): Promise<void> {
    const rowKeysJson = meta.rowKeys ? JSON.stringify(meta.rowKeys) : null;

    // a retry re-records an existing (failed) delivery, so adjust counters by
    // the delta: drop the old status' contribution, add the new one. this is
    // what flips a red cell green and keeps the stat cards correct.
    const existing = await this.prisma.bridgeDelivery.findUnique({
      where: { jobId_sequence: { jobId, sequence: meta.sequence } },
      select: { status: true, rowCount: true },
    });
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    if (existing) {
      if (existing.status === 'success') sent -= existing.rowCount;
      else if (existing.status === 'failed') failed -= existing.rowCount;
      else if (existing.status === 'skipped') skipped -= existing.rowCount;
    }
    if (outcome.status === 'success') sent += meta.rowCount;
    else failed += meta.rowCount;

    const counters: Record<string, { increment: number }> = {};
    if (sent !== 0) counters.sentCount = { increment: sent };
    if (failed !== 0) counters.failedCount = { increment: failed };
    if (skipped !== 0) counters.skippedCount = { increment: skipped };

    // retry-integrity fields: `undefined` means "the outcome doesn't know",
    // which preserves the stored value on a re-record (e.g. a refused resend
    // must keep the original op and truncation flag intact)
    const succeededTargetsJson =
      outcome.succeededTargets !== undefined
        ? {
            succeededTargetsJson: outcome.succeededTargets?.length
              ? JSON.stringify(outcome.succeededTargets)
              : null,
          }
        : {};
    const integrity = {
      ...(outcome.op !== undefined ? { op: outcome.op } : {}),
      ...(outcome.bodyTruncated !== undefined
        ? { bodyTruncated: outcome.bodyTruncated }
        : {}),
      ...succeededTargetsJson,
    };

    await this.prisma.$transaction([
      this.prisma.bridgeDelivery.upsert({
        where: { jobId_sequence: { jobId, sequence: meta.sequence } },
        create: {
          id: randomUUID(),
          jobId,
          sequence: meta.sequence,
          rowIndex: meta.rowIndex,
          rowCount: meta.rowCount,
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          attempts: outcome.attempts,
          error: outcome.error,
          rowKeysJson,
          requestBody: outcome.requestBody,
          responseBody: outcome.responseBody,
          durationMs: outcome.durationMs,
          ...integrity,
        },
        update: {
          rowKeysJson,
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          attempts: outcome.attempts,
          error: outcome.error,
          requestBody: outcome.requestBody,
          responseBody: outcome.responseBody,
          durationMs: outcome.durationMs,
          ...integrity,
        },
      }),
      this.prisma.bridgeJob.update({ where: { id: jobId }, data: counters }),
    ]);
  }

  async finalize(
    jobId: string,
    status: BridgeJobStatus,
    error?: string | null,
  ): Promise<void> {
    await this.prisma.bridgeJob.update({
      where: { id: jobId },
      data: { status, error: error ?? null, finishedAt: new Date() },
    });
  }

  /* ----- boot reconcile ----- */

  async onModuleInit(): Promise<void> {
    let rows: { id: string; bridgeId: string }[];
    try {
      rows = await this.prisma.bridgeJob.findMany({
        where: { status: { in: ACTIVE } },
        select: { id: true, bridgeId: true },
      });
    } catch (err) {
      this.logger.warn(`Skipped job recovery: ${(err as Error).message}`);
      return;
    }
    let recovered = 0;
    for (const r of rows) {
      // only replay jobs belong to this queue. watch/CDC jobs are also `running`
      // but are owned by their own services, never re-enqueue those here
      const bridge = await this.store.get(r.bridgeId).catch(() => null);
      if (!bridge || bridge.trigger.kind !== 'replay') continue;
      // an interrupted resend must recover as a resend: re-streaming it would
      // deliver nothing (its cursor sits at the end of the source)
      const mode = await this.clearSettledJob(r.id);
      await this.enqueue(r.id, r.bridgeId, mode).catch((err) =>
        this.logger.warn(
          `Could not re-enqueue job ${r.id}: ${(err as Error).message}`,
        ),
      );
      recovered++;
    }
    if (recovered) this.logger.log(`Recovered ${recovered} interrupted replay job(s)`);
  }

  /* ----- mappers ----- */

  private toJob(row: JobRow): BridgeJob {
    return {
      id: row.id,
      bridgeId: row.bridgeId,
      status: row.status as BridgeJobStatus,
      cursorOffset: row.cursorOffset,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      skippedCount: row.skippedCount,
      totalCount: row.totalCount,
      batchSize: this.snapshotBatchSize(row.configSnapshotJson),
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }

  private toDelivery(row: DeliveryRow): BridgeDelivery {
    return {
      id: row.id,
      jobId: row.jobId,
      sequence: row.sequence,
      rowIndex: row.rowIndex,
      rowCount: row.rowCount,
      status: row.status as DeliveryStatus,
      httpStatus: row.httpStatus,
      attempts: row.attempts,
      error: row.error,
      requestBody: row.requestBody,
      responseBody: row.responseBody,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
