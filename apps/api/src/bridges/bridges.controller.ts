import { Audited } from '../audit/audited.decorator';
import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  type Bridge,
  type BridgeDelivery,
  type BridgeExportDocument,
  type BridgeImportDTO,
  type BridgeImportResult,
  type BridgeSchemaDrift,
  type BridgeInputDTO,
  type BridgeDraftPreviewDTO,
  type BridgePreview,
  type BridgePreviewDTO,
  type BridgeJob,
  type StartJobDTO,
  type SkipDTO,
  type BridgeBulkDTO,
  type BridgeBulkResult,
  type BridgeLoopStatus,
  type BridgeScheduleStatus,
  type BridgeSourceHold,
  type BridgeVerification,
  type VerifyStartDTO,
  type ReplaySchedule,
  type CdcReadiness,
  type CdcReadinessDTO,
  type LiveStartDTO,
  type PendingSourceCleanup,
  type DeadLetterDiscardDTO,
  type DeadLetterPage,
  type DeadLetterRetryDTO,
  type DeadLetterRetryResult,
  BadRequestError,
  cdcReadinessSchema,
  bridgeBulkSchema,
  bridgeDraftPreviewSchema,
  bridgeImportSchema,
  bridgeInputSchema,
  bridgePreviewSchema,
  deadLetterDiscardSchema,
  deadLetterRetrySchema,
  liveStartSchema,
  mapRow,
  renderRow,
  replayScheduleSchema,
  skipSchema,
  startJobSchema,
  verifyStartSchema,
} from '@syncle/core';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DatabaseSinkService } from './database-sink.service';
import { DeliveryService } from './delivery.service';
import { BridgeCdcService } from './bridge-cdc.service';
import { BridgeLifecycleService } from './bridge-lifecycle.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { BridgeWatchService } from './bridge-watch.service';
import type { ResolvedBridge } from './bridges.types';
import { shapeRows } from './row-shaping';
import { BridgeTransferService } from './bridge-transfer.service';
import { EchoGuardService } from './echo-guard.service';
import { SchemaDriftService } from './schema-drift.service';
import { BridgeScheduleService, nextRuns } from './bridge-schedule.service';
import { BridgeVerifyService } from './bridge-verify.service';
import { DeadLetterService } from './dead-letter.service';
import { RetentionService, type RetentionResult } from './retention.service';

/** the numbers in an answer (`{ created: 3, skipped: 1 }`), for an audit entry's details */
function summary(result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!result || typeof result !== 'object') return out;
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.length;
  }
  return out;
}

@Controller('bridges')
export class BridgesController {
  private readonly logger = new Logger('Bridges');

  constructor(
    private readonly store: BridgeStoreService,
    private readonly jobs: BridgeJobService,
    private readonly watch: BridgeWatchService,
    private readonly cdc: BridgeCdcService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
    private readonly databaseSink: DatabaseSinkService,
    private readonly lifecycle: BridgeLifecycleService,
    private readonly deadLetters: DeadLetterService,
    private readonly retention: RetentionService,
    private readonly transfer: BridgeTransferService,
    private readonly drift: SchemaDriftService,
    private readonly echo: EchoGuardService,
    private readonly schedule: BridgeScheduleService,
    private readonly verify: BridgeVerifyService,
  ) {}

  /* ----- CRUD ----- */

  @Get()
  list(@Query('workspaceId') workspaceId?: string): Promise<Bridge[]> {
    return this.store.list(workspaceId);
  }

  // latest job status per bridge in a workspace (drives the map edge colors).
  // declared before ':id' so "statuses" isn't captured as a bridge id.
  @Get('statuses')
  statuses(@Query('workspaceId') workspaceId: string) {
    return this.jobs.workspaceStatuses(workspaceId);
  }

  @Post()
  @Audited('bridge.create')
  async create(
    @Body(new ZodValidationPipe(bridgeInputSchema)) dto: BridgeInputDTO,
  ): Promise<Bridge> {
    // a cron line the firing library will not take is refused before anything is saved
    this.schedule.assertUsable(dto);
    const bridge = await this.store.create(dto);
    await this.syncSchedule(bridge);
    // the table as the builder showed it is what this bridge is built for. (an
    // imported or cloned bridge has nobody looking at the table: its first run records it)
    await this.store
      .resolve(bridge.id)
      .then((resolved) => this.drift.accept(resolved, { moved: true }))
      .catch(() => undefined);
    // queue a draft job so the timeline shows the planned deliveries right away
    await this.jobs.prepare(bridge.id).catch(() => undefined);
    return bridge;
  }

  // (registered AHEAD of `:id`, which would otherwise take "export" for a bridge's id)
  /** every bridge of a workspace as one document. no secret is in it */
  @Get('export')
  exportAll(@Query('workspaceId') workspaceId?: string): Promise<BridgeExportDocument> {
    return this.transfer.exportWorkspace(workspaceId || undefined);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Bridge> {
    return this.store.get(id);
  }

  @Put(':id')
  @Audited('bridge.update')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(bridgeInputSchema)) dto: BridgeInputDTO,
  ): Promise<Bridge> {
    this.schedule.assertUsable(dto);
    // a verification compares — and a reconcile writes — by the mapping as it
    // WAS: it stops here, and is started again against what is saved
    await this.verify.cancelAll(id).catch(() => undefined);
    // stop a live listener BEFORE the config changes, routed by the OLD trigger
    // kind — routing by the new one after an edit (say cdc → watch) would leave
    // the old stream running as a zombie, delivering into a finalized job
    const before = await this.store.get(id);
    // what a CDC bridge created on its source lives on the source AS IT WAS.
    // resolved now, because after the update nothing points there any more
    const beforeResolved = before.trigger.kind === 'cdc' ? await this.store.resolve(id) : null;
    const wasListening =
      before.trigger.kind === 'cdc' || before.trigger.kind === 'watch'
        ? await this.lifecycle.stopListener(id, before.trigger.kind)
        : false;

    const bridge = await this.store.update(id, dto);

    // no longer a CDC bridge, or no longer on that server/database: its
    // replication slot there would otherwise pin WAL for ever, unread
    if (beforeResolved && beforeResolved.source.kind === 'table') {
      const was = beforeResolved.source;
      const now = bridge.source;
      const moved =
        bridge.trigger.kind !== 'cdc' ||
        now.kind !== 'table' ||
        now.connectionId !== was.connectionId ||
        (now.database ?? '') !== (was.database ?? '');
      // from a slot of its own to the shared one, or back: what it had stays
      // behind otherwise, pinning WAL for a reader that will never come. a place
      // in one slot means nothing in another, so the bridge follows from now
      // (or copies again, if that is how it starts) — and says so
      const otherSlot = !moved && before.trigger.kind === 'cdc' && bridge.trigger.kind === 'cdc' && before.trigger.slot !== bridge.trigger.slot;
      if (moved) await this.cdc.abandon(id, beforeResolved);
      else if (otherSlot) {
        await this.cdc.abandon(id, beforeResolved, {
          gapNotice:
            `Switched to ${bridge.trigger.kind === 'cdc' && bridge.trigger.slot === 'shared' ? 'the shared replication slot' : 'a replication slot of its own'} on ${new Date().toISOString()}. ` +
            'A place in one slot means nothing in another: changes made at the source between the last delivery and the next start are NOT captured. ' +
            'Verify the bridge and reconcile it to bring the destination up to date.',
        });
      }
    }

    // a new line, a new zone, switched off, no longer a replay at all: Redis is told
    await this.syncSchedule(bridge);
    // the destination may have changed; drop the sink's ensured-table cache
    this.databaseSink.forget(id);
    // whoever saved the bridge had the table as it IS in front of them: that is
    // now what the bridge is built for — if what they saved no longer uses a
    // column that went. (best-effort: an unreachable source leaves the old
    // baseline, and the next run looks again)
    const was = before.source;
    const readsAnotherTable =
      was.kind !== bridge.source.kind ||
      was.connectionId !== bridge.source.connectionId ||
      (was.database ?? '') !== (bridge.source.database ?? '') ||
      (was.kind === 'table' &&
        bridge.source.kind === 'table' &&
        (was.table !== bridge.source.table || (was.schema ?? '') !== (bridge.source.schema ?? '')));
    await this.drift.accept(await this.store.resolve(id), { moved: readsAnotherTable }).catch(() => undefined);
    // refresh an existing draft so its queued timeline reflects the new config
    await this.jobs.prepare(id, { onlyExisting: true }).catch(() => undefined);

    // it was live when the user hit save, so bring it back up on the new config
    if (wasListening && bridge.enabled) {
      try {
        if (bridge.trigger.kind === 'cdc') await this.cdc.start(id);
        else if (bridge.trigger.kind === 'watch') await this.watch.start(id);
      } catch (err) {
        this.logger.warn(
          `Bridge ${id} was live but could not restart on the new config (left paused): ${(err as Error).message}`,
        );
      }
    }
    return bridge;
  }

  @Delete(':id')
  @Audited('bridge.delete', ({ params, result }) => ({
    target: { type: 'bridge', id: params.id, name: (result as { name?: string })?.name ?? null },
  }))
  async remove(@Param('id') id: string): Promise<{ id: string; name: string }> {
    const { name } = await this.store.get(id); // 404s if missing
    await this.lifecycle.teardown(id);
    await this.store.remove(id);
    return { id, name };
  }

  /* ----- payload preview (no delivery) ----- */

  /* ----- verify / reconcile: is the destination the copy of the source? ----- */

  /** starts in the background; poll `GET :id/verifications/:verificationId` for progress and the result */
  @Post(':id/verify')
  @Audited('bridge.verify', ({ body }) => ({ details: body as Record<string, unknown> }))
  @HttpCode(202)
  startVerification(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(verifyStartSchema)) dto: VerifyStartDTO,
  ): Promise<BridgeVerification> {
    return this.verify.start(id, dto);
  }

  @Get(':id/verifications')
  verifications(@Param('id') id: string): Promise<BridgeVerification[]> {
    return this.verify.list(id);
  }

  @Get(':id/verifications/:verificationId')
  verification(@Param('id') id: string, @Param('verificationId') verificationId: string): Promise<BridgeVerification> {
    return this.verify.get(id, verificationId);
  }

  @Post(':id/verifications/:verificationId/cancel')
  @Audited('bridge.verify_cancel', ({ params }) => ({ details: { verificationId: params.verificationId } }))
  @HttpCode(200)
  cancelVerification(@Param('id') id: string, @Param('verificationId') verificationId: string): Promise<BridgeVerification> {
    return this.verify.cancel(id, verificationId);
  }

  /* ----- scheduled replays ----- */

  /**
   * the bridge is saved either way: a queue that is down must not lose an edit.
   * the schedule is put right at the next boot, and the bridge's page says
   * meanwhile that it is not active
   */
  private async syncSchedule(bridge: Bridge): Promise<void> {
    await this.schedule.sync(bridge).catch((err) =>
      this.logger.warn(`Could not update the replay schedule of ${bridge.id}: ${(err as Error).message}`),
    );
  }

  /** when would this line fire? for the builder, while it is being typed. 400 with the reason if it cannot be used */
  @Post('schedule-preview')
  @HttpCode(200)
  schedulePreview(@Body(new ZodValidationPipe(replayScheduleSchema)) dto: ReplaySchedule): { nextRuns: string[] } {
    return { nextRuns: nextRuns(dto, 5) };
  }

  @Get(':id/schedule')
  scheduleStatus(@Param('id') id: string): Promise<BridgeScheduleStatus> {
    return this.schedule.status(id);
  }

  /* ----- loops: is this bridge tied to others that feed it what it feeds them? ----- */

  @Get(':id/loops')
  async loops(@Param('id') id: string): Promise<BridgeLoopStatus> {
    return this.echo.status(await this.store.resolve(id));
  }

  /* ----- schema drift: has the source table changed since the bridge was set up? ----- */

  @Get(':id/schema-drift')
  async schemaDrift(@Param('id') id: string): Promise<BridgeSchemaDrift> {
    return this.drift.status(await this.store.resolve(id));
  }

  /** the table as it is NOW becomes what the bridge is built for */
  @Post(':id/schema-drift/accept')
  @Audited('bridge.schema_accepted')
  @HttpCode(200)
  async acceptSchemaDrift(@Param('id') id: string): Promise<BridgeSchemaDrift> {
    const bridge = await this.store.resolve(id);
    const inTheWay = await this.drift.accept(bridge);
    if (inTheWay.length > 0) {
      throw new BadRequestError(
        `This bridge still uses ${inTheWay.join(', ')}, which the table no longer has: accepting that would write NULL in ${inTheWay.length === 1 ? 'its' : 'their'} place. ` +
          'Edit the bridge — re-map or remove it — and saving accepts the table as it is now.',
        { reason: 'schema-drift', missingUsed: inTheWay },
      );
    }
    return this.drift.status(bridge);
  }

  /* ----- export / import / clone ----- */

  @Get(':id/export')
  exportOne(@Param('id') id: string): Promise<BridgeExportDocument> {
    return this.transfer.exportOne(id);
  }

  /**
   * create the bridges of an exported document. 400 with
   * `details.reason = "unresolved-connections"` (and who the candidates are)
   * when the file refers to a connection this instance has no obvious
   * counterpart for; send again with a `connectionMap`
   */
  @Post('import')
  @Audited('bridge.import', ({ result }) => ({ target: null, details: summary(result) }))
  importBridges(@Body(new ZodValidationPipe(bridgeImportSchema)) dto: BridgeImportDTO): Promise<BridgeImportResult> {
    return this.transfer.import(dto);
  }

  /**
   * one bridge per table, for many tables at once (a whole schema, say). each is
   * made the way any bridge is made; a table none can be made for is said, with
   * the reason, and does not stop the others
   */
  @Post('bulk')
  @Audited('bridge.bulk_create', ({ result }) => ({ target: null, details: summary(result) }))
  async bulk(@Body(new ZodValidationPipe(bridgeBulkSchema)) dto: BridgeBulkDTO): Promise<BridgeBulkResult> {
    const plan = await this.transfer.planBulk(dto);
    const result: BridgeBulkResult = { created: [], skipped: plan.skipped };
    for (const { table, input } of plan.inputs) {
      try {
        const bridge = await this.create(input);
        result.created.push({ id: bridge.id, name: bridge.name, table });
      } catch (err) {
        result.skipped.push({ table, reason: (err as Error).message });
      }
    }
    return result;
  }

  @Post(':id/clone')
  @Audited('bridge.clone', ({ params }) => ({ details: { from: params.id } }))
  clone(@Param('id') id: string): Promise<Bridge> {
    return this.transfer.clone(id);
  }

  @Post(':id/preview')
  async preview(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(bridgePreviewSchema)) dto: BridgePreviewDTO,
  ): Promise<BridgePreview> {
    return this.previewOf(await this.store.resolve(id), dto);
  }

  /**
   * a dry run of a bridge that does not exist yet — the builder's draft. nothing
   * is saved, nothing is written, no table is created: the source is sampled
   * and the targets are LOOKED at, so that "this table will be created with
   * these columns, and that one cannot hold everything" is something you read
   * before the first run instead of finding in production.
   */
  @Post('preview')
  async previewDraft(
    @Body(new ZodValidationPipe(bridgeDraftPreviewSchema)) dto: BridgeDraftPreviewDTO,
  ): Promise<BridgePreview> {
    // an id of its own, so nothing about the draft lands in (or is read from)
    // the sink's per-bridge caches of a real bridge — and forgotten afterwards
    const id = `draft:${randomUUID()}`;
    const draft: ResolvedBridge = {
      id,
      name: dto.bridge.name,
      source: dto.bridge.source,
      destination: dto.bridge.destination,
      transform: dto.bridge.transform,
      delivery: dto.bridge.delivery,
      trigger: dto.bridge.trigger,
      enabled: dto.bridge.enabled,
    };
    try {
      return await this.previewOf(draft, { sampleRow: dto.sampleRow, limit: dto.limit });
    } finally {
      this.databaseSink.forget(id);
    }
  }

  private async previewOf(bridge: ResolvedBridge, dto: BridgePreviewDTO): Promise<BridgePreview> {
    const table = bridge.source.kind === 'table' ? bridge.source.table : '(query)';
    const now = new Date().toISOString();

    let rows: Record<string, unknown>[];
    let fromSource: boolean;
    if (dto.sampleRow) {
      rows = [dto.sampleRow];
      fromSource = false;
    } else {
      rows = await this.fetchSample(bridge.source, dto.limit);
      fromSource = true;
    }
    // what is shown is what would be delivered: masked, cast, computed
    const shaped = shapeRows(bridge, rows, { table, now });
    rows = shaped.rows;
    // a run would stop at these; here they are something to read first
    shaped.warnings.push(...shaped.errors.map((e) => `${e} — this would FAIL the delivery`));

    const dest = bridge.destination;

    // database destination: preview the mapped row(s) and where they land
    if (dest.kind === 'database') {
      const mapping = dest.targets[0]?.mapping ?? [];
      const warnings: string[] = [...shaped.warnings];
      if (dest.targets.some((t) => t.writeMode === 'upsert' && t.keyColumns.length === 0)) {
        warnings.push('A target is set to upsert but has no key columns selected.');
      }
      // read-only: says whether each target table exists and, if a run would
      // create it, with exactly which columns — so a type the target cannot
      // hold faithfully is a warning here instead of a surprise in production
      const targets = [];
      for (const t of dest.targets) {
        const label = t.schema ? `${t.schema}.${t.table}` : t.table;
        const described = await this.databaseSink
          .describeTarget(bridge, t, rows[0] ?? {})
          .catch(() => ({ exists: null, columns: undefined, warnings: [] }));
        for (const w of described.warnings) {
          warnings.push(`${label}.${w.column} (${w.sourceType} → ${w.targetType}): ${w.message}`);
        }
        if (described.exists === false && !t.createMissingTable) {
          warnings.push(`${label} does not exist and auto-create is off, so every delivery would fail.`);
        }
        targets.push({
          label,
          writeMode: t.writeMode,
          keyColumns: t.keyColumns,
          createMissingTable: t.createMissingTable,
          exists: described.exists,
          ...(described.columns ? { plannedColumns: described.columns } : {}),
        });
      }
      return {
        destinationKind: 'database',
        targets,
        bodies: rows.map((row) => mapRow(row, mapping)),
        warnings,
        fromSource,
      };
    }

    const warnings = new Set<string>(shaped.warnings);
    const bodies = rows.map((row, index) => {
      const result = renderRow(row, bridge.transform, { table, now, index });
      result.warnings.forEach((w) => warnings.add(w));
      return result.body;
    });

    return {
      destinationKind: 'http',
      method: dest.method,
      url: dest.url,
      headers: this.delivery.redactedHeaders(dest),
      bodies,
      warnings: [...warnings],
      fromSource,
    };
  }

  private async fetchSample(
    source: Bridge['source'],
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    if (source.kind === 'table') {
      const page = await this.pool.withAdapter(
        source.connectionId,
        source.database,
        (a) =>
          a.browse({
            schema: source.schema,
            table: source.table,
            filters: source.filters,
            sort: source.sort,
            limit,
            offset: 0,
          }),
      );
      return page.rows;
    }
    const result = await this.pool.withAdapter(
      source.connectionId,
      source.database,
      (a) => a.query(source.statement),
    );
    return result.rows.slice(0, limit);
  }

  /* ----- jobs ----- */

  @Post(':id/jobs')
  @Audited('bridge.run', ({ body, result }) => ({
    details: { ...(body as Record<string, unknown>), jobId: (result as { id?: string })?.id },
  }))
  startJob(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(startJobSchema)) dto: StartJobDTO,
  ): Promise<BridgeJob> {
    return this.jobs.start(id, dto);
  }

  /* ----- live listening (polling watch OR event-based CDC) ----- */

  @Post('cdc/readiness')
  cdcReadiness(
    @Body(new ZodValidationPipe(cdcReadinessSchema)) dto: CdcReadinessDTO,
  ): Promise<CdcReadiness> {
    return this.cdc.readiness(dto);
  }

  @Post(':id/watch/start')
  @Audited('bridge.start', ({ body }) => ({ details: body as Record<string, unknown> }))
  async startWatch(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(liveStartSchema)) dto: LiveStartDTO,
  ): Promise<BridgeJob> {
    const bridge = await this.store.get(id);
    return bridge.trigger.kind === 'cdc'
      ? this.cdc.start(id, { fromNow: dto.fromNow === true, recopy: dto.recopy === true })
      : this.watch.start(id);
  }

  /**
   * what a CDC bridge is holding on its source right now — for PostgreSQL, how
   * much WAL its replication slot is pinning. null when it holds nothing.
   */
  @Get(':id/source-hold')
  async sourceHold(@Param('id') id: string): Promise<BridgeSourceHold | null> {
    await this.store.get(id); // 404s if missing
    return this.cdc.hold(id);
  }

  /**
   * apply the delivery-history retention now instead of at the next hourly
   * sweep — after lowering it, say. returns what was removed
   */
  @Post('retention/run')
  @Audited('retention.run', ({ result }) => ({ target: null, details: result as Record<string, unknown> }))
  runRetention(): Promise<RetentionResult> {
    return this.retention.sweep();
  }

  /** replication slots of removed bridges that could not be dropped yet */
  @Get('cdc/cleanups')
  async pendingCleanups(): Promise<PendingSourceCleanup[]> {
    return this.cdc.listCleanups();
  }

  /** try them all again now, rather than at the next sweep */
  @Post('cdc/cleanups/retry')
  @Audited('bridge.cleanups_retry', ({ result }) => ({ target: null, details: result as Record<string, unknown> }))
  async retryCleanups(): Promise<{ left: number }> {
    return { left: await this.cdc.retryCleanups() };
  }

  /** stop tracking one — after it was removed on the server by hand */
  @Delete('cdc/cleanups/:cleanupId')
  @Audited('bridge.cleanup_dismissed', ({ params }) => ({ target: { type: 'cleanup', id: params.cleanupId, name: null } }))
  async dismissCleanup(@Param('cleanupId') cleanupId: string): Promise<{ id: string }> {
    await this.cdc.dismissCleanup(cleanupId);
    return { id: cleanupId };
  }

  @Post(':id/watch/stop')
  @Audited('bridge.stop')
  async stopWatch(@Param('id') id: string): Promise<BridgeJob | null> {
    await this.store.get(id); // 404s if missing
    // stop BOTH mechanisms, not just the current trigger kind: a bridge edited
    // across kinds may still have the other's listener running. cdc.stop goes
    // first so the job it finalizes is the one reported back
    const cdcJob = await this.cdc.stop(id);
    const watchJob = await this.watch.stop(id);
    return cdcJob ?? watchJob;
  }

  @Get(':id/jobs')
  listJobs(@Param('id') id: string): Promise<BridgeJob[]> {
    return this.jobs.listJobs(id);
  }

  @Get(':id/jobs/:jobId')
  getJob(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<BridgeJob> {
    return this.jobs.getJob(id, jobId);
  }

  @Post(':id/jobs/:jobId/retry-failed')
  @Audited('bridge.retry', ({ params }) => ({ details: { jobId: params.jobId, what: 'failed rows' } }))
  async retryFailed(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<BridgeJob> {
    await this.jobs.getJob(id, jobId); // 404 unless the job belongs to this bridge
    // a live bridge's failed rows sit in its dead-letter queue, and that is
    // where they are retried: by re-reading the source, which is safe even
    // while the bridge streams. only failures the queue doesn't own (recorded
    // before it existed) fall through to the captured-payload resend
    const { pendingEntries } = await this.deadLetters.page(id, { limit: 1 });
    if (pendingEntries > 0) {
      await this.deadLetters.retry(id, { force: false });
      const job = await this.jobs.getJob(id, jobId);
      if (job.failedCount === 0 || ['queued', 'running', 'canceling'].includes(job.status)) {
        return job;
      }
      const rest = await this.jobs.resendableFailures(jobId);
      if (rest === 0) return job;
    }
    return this.jobs.resendFailed(id, jobId);
  }

  /* ----- dead letters: rows a live bridge set aside instead of losing ----- */

  @Get(':id/dead-letters')
  listDeadLetters(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<DeadLetterPage> {
    const valid = status === 'pending' || status === 'resolved' || status === 'discarded';
    return this.deadLetters.page(id, {
      status: valid ? status : undefined,
      offset: parseBound('offset', offset),
      limit: parseBound('limit', limit),
    });
  }

  @Post(':id/dead-letters/retry')
  @Audited('bridge.dead_letters_retry', ({ body, result }) => ({ details: { ...(body as Record<string, unknown>), ...summary(result) } }))
  retryDeadLetters(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deadLetterRetrySchema)) dto: DeadLetterRetryDTO,
  ): Promise<DeadLetterRetryResult> {
    return this.deadLetters.retry(id, dto);
  }

  @Post(':id/dead-letters/discard')
  @Audited('bridge.dead_letters_discard', ({ body, result }) => ({ details: { ...(body as Record<string, unknown>), ...summary(result) } }))
  discardDeadLetters(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deadLetterDiscardSchema)) dto: DeadLetterDiscardDTO,
  ): Promise<{ discarded: number }> {
    return this.deadLetters.discard(id, dto);
  }

  @Post(':id/jobs/:jobId/cancel')
  @Audited('bridge.cancel', ({ params }) => ({ details: { jobId: params.jobId } }))
  async cancelJob(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<BridgeJob> {
    // listening jobs aren't queue jobs: plain cancel would strand them in
    // 'canceling' while the stream keeps delivering. canceling one means
    // stopping the listener (the job pauses, keeping its cursor)
    const bridge = await this.store.get(id).catch(() => null);
    if (bridge && (bridge.trigger.kind === 'watch' || bridge.trigger.kind === 'cdc')) {
      const job = await this.jobs.getJob(id, jobId);
      if (['queued', 'running', 'canceling'].includes(job.status)) {
        const stopped = (await this.cdc.stop(id)) ?? (await this.watch.stop(id));
        if (stopped && stopped.id === jobId) return stopped;
      }
      return this.jobs.getJob(id, jobId);
    }
    return this.jobs.cancel(id, jobId);
  }

  @Get(':id/jobs/:jobId/deliveries')
  async listDeliveries(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<BridgeDelivery[]> {
    await this.jobs.getJob(id, jobId); // 404 unless the job belongs to this bridge
    const valid = status === 'success' || status === 'failed' || status === 'skipped';
    return this.jobs.listDeliveries(jobId, {
      status: valid ? (status as 'success' | 'failed' | 'skipped') : undefined,
      from: parseBound('from', from),
      to: parseBound('to', to),
      offset: parseBound('offset', offset),
      limit: parseBound('limit', limit),
    });
  }

  /**
   * retry ONE failed delivery, now. rows a live bridge set aside are retried
   * from its dead-letter queue (by re-reading the source); anything else is
   * re-sent from what was captured of it
   */
  @Post(':id/jobs/:jobId/deliveries/:sequence/retry')
  @Audited('bridge.retry', ({ params }) => ({ details: { jobId: params.jobId, sequence: Number(params.sequence) } }))
  @HttpCode(200)
  async retryDelivery(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Param('sequence') sequence: string,
  ): Promise<BridgeDelivery> {
    await this.jobs.getJob(id, jobId); // 404 unless the job belongs to this bridge
    const seq = parseBound('sequence', sequence)!;
    const parked = await this.deadLetters.pendingIds(id, jobId, seq);
    if (parked.length > 0) {
      await this.deadLetters.retry(id, { ids: parked, force: false });
      return this.jobs.getDelivery(jobId, seq);
    }
    return this.jobs.retryDelivery(id, jobId, seq);
  }

  /**
   * a job's failed deliveries as a file: which rows, why, and what was sent —
   * to hand to whoever owns the destination, or to fix and load by hand.
   * `format=csv` (default) or `ndjson`
   */
  @Get(':id/jobs/:jobId/failures')
  async downloadFailures(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.jobs.getJob(id, jobId); // 404 unless the job belongs to this bridge
    const ndjson = format === 'ndjson';
    if (format !== undefined && !ndjson && format !== 'csv') {
      throw new BadRequestError('format must be "csv" or "ndjson".');
    }
    // (node's own response API throughout: it is all a stream of lines needs)
    res.statusCode = 200;
    res.setHeader('Content-Type', ndjson ? 'application/x-ndjson; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="syncle-failures-${jobId}.${ndjson ? 'ndjson' : 'csv'}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (!ndjson) res.write(`${FAILURE_COLUMNS.join(',')}\r\n`);
    // a page at a time: a job can have more failures than fit in memory at once
    for await (const d of this.jobs.failedDeliveries(jobId)) {
      res.write(ndjson ? `${JSON.stringify(failureRecord(d))}\n` : `${failureCsvLine(d)}\r\n`);
    }
    res.end();
  }

  @Post(':id/jobs/:jobId/skip')
  @Audited('bridge.skip', ({ params, body }) => ({ details: { jobId: params.jobId, ...(body as Record<string, unknown>) } }))
  async skip(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(skipSchema)) dto: SkipDTO,
  ): Promise<{ skipped: number }> {
    await this.jobs.getJob(id, jobId); // 404 unless the job belongs to this bridge
    const skipped = await this.jobs.skipDeliveries(jobId, dto.sequences);
    return { skipped };
  }
}

const FAILURE_COLUMNS = ['sequence', 'operation', 'rows', 'row_keys', 'attempts', 'http_status', 'error', 'at', 'payload'] as const;

/** one failed delivery, flat */
export function failureRecord(
  d: BridgeDelivery & { rowKeys?: unknown[] | null },
): Record<(typeof FAILURE_COLUMNS)[number], unknown> {
  return {
    sequence: d.sequence,
    operation: d.op ?? null,
    rows: d.rowCount,
    row_keys: d.rowKeys ?? null,
    attempts: d.attempts,
    http_status: d.httpStatus ?? null,
    error: d.error ?? null,
    at: d.createdAt,
    payload: d.requestBody ?? null,
  };
}

/**
 * RFC 4180, and safe to open in a spreadsheet: a cell that starts with `=`,
 * `+`, `-`, `@` (or a tab / CR) is a FORMULA to Excel and friends, and an error
 * text or a row's value is somebody else's data. such a cell gets a leading
 * apostrophe, which a spreadsheet shows as text and everything else can strip
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function failureCsvLine(d: BridgeDelivery & { rowKeys?: unknown[] | null }): string {
  const record = failureRecord(d);
  return FAILURE_COLUMNS.map((c) => csvCell(record[c])).join(',');
}

/** parse a numeric query param, rejecting NaN/negatives instead of 500ing */
function parseBound(name: string, value?: string): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Math.trunc(Number(value));
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError(`Query parameter "${name}" must be a non-negative integer.`);
  }
  return n;
}
