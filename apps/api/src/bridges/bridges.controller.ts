import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type Bridge,
  type BridgeDelivery,
  type BridgeInputDTO,
  type BridgePreview,
  type BridgePreviewDTO,
  type BridgeJob,
  type StartJobDTO,
  type SkipDTO,
  type CdcReadiness,
  type CdcReadinessDTO,
  BadRequestError,
  cdcReadinessSchema,
  bridgeInputSchema,
  bridgePreviewSchema,
  mapRow,
  renderRow,
  skipSchema,
  startJobSchema,
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
  async create(
    @Body(new ZodValidationPipe(bridgeInputSchema)) dto: BridgeInputDTO,
  ): Promise<Bridge> {
    const bridge = await this.store.create(dto);
    // queue a draft job so the timeline shows the planned deliveries right away
    await this.jobs.prepare(bridge.id).catch(() => undefined);
    return bridge;
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Bridge> {
    return this.store.get(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(bridgeInputSchema)) dto: BridgeInputDTO,
  ): Promise<Bridge> {
    // stop a live listener BEFORE the config changes, routed by the OLD trigger
    // kind — routing by the new one after an edit (say cdc → watch) would leave
    // the old stream running as a zombie, delivering into a finalized job
    const before = await this.store.get(id);
    const wasListening =
      before.trigger.kind === 'cdc' || before.trigger.kind === 'watch'
        ? await this.lifecycle.stopListener(id, before.trigger.kind)
        : false;

    const bridge = await this.store.update(id, dto);
    // the destination may have changed; drop the sink's ensured-table cache
    this.databaseSink.forget(id);
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
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    await this.store.get(id); // 404s if missing
    await this.lifecycle.teardown(id);
    await this.store.remove(id);
    return { id };
  }

  /* ----- payload preview (no delivery) ----- */

  @Post(':id/preview')
  async preview(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(bridgePreviewSchema)) dto: BridgePreviewDTO,
  ): Promise<BridgePreview> {
    const bridge = await this.store.resolve(id);
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

    const dest = bridge.destination;

    // database destination: preview the mapped row(s) and where they land
    if (dest.kind === 'database') {
      const mapping = dest.targets[0]?.mapping ?? [];
      const warnings: string[] = [];
      if (dest.targets.some((t) => t.writeMode === 'upsert' && t.keyColumns.length === 0)) {
        warnings.push('A target is set to upsert but has no key columns selected.');
      }
      return {
        destinationKind: 'database',
        targets: dest.targets.map((t) => ({
          label: t.schema ? `${t.schema}.${t.table}` : t.table,
          writeMode: t.writeMode,
          keyColumns: t.keyColumns,
          createMissingTable: t.createMissingTable,
        })),
        bodies: rows.map((row) => mapRow(row, mapping)),
        warnings,
        fromSource,
      };
    }

    const warnings = new Set<string>();
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
  async startWatch(@Param('id') id: string): Promise<BridgeJob> {
    const bridge = await this.store.get(id);
    return bridge.trigger.kind === 'cdc' ? this.cdc.start(id) : this.watch.start(id);
  }

  @Post(':id/watch/stop')
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
  retryFailed(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<BridgeJob> {
    return this.jobs.resendFailed(id, jobId);
  }

  @Post(':id/jobs/:jobId/cancel')
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

  @Post(':id/jobs/:jobId/skip')
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

/** parse a numeric query param, rejecting NaN/negatives instead of 500ing */
function parseBound(name: string, value?: string): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Math.trunc(Number(value));
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError(`Query parameter "${name}" must be a non-negative integer.`);
  }
  return n;
}
