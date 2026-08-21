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
  type Hook,
  type HookDelivery,
  type HookInputDTO,
  type HookPreview,
  type HookPreviewDTO,
  type HookRun,
  type StartRunDTO,
  type SkipDTO,
  type CdcReadiness,
  type CdcReadinessDTO,
  BadRequestError,
  cdcReadinessSchema,
  hookInputSchema,
  hookPreviewSchema,
  mapRow,
  renderRow,
  skipSchema,
  startRunSchema,
} from '@syncle/core';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DatabaseSinkService } from './database-sink.service';
import { DeliveryService } from './delivery.service';
import { HookCdcService } from './hook-cdc.service';
import { HookLifecycleService } from './hook-lifecycle.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { HookWatchService } from './hook-watch.service';

@Controller('hooks')
export class HooksController {
  private readonly logger = new Logger('Hooks');

  constructor(
    private readonly store: HookStoreService,
    private readonly runs: HookRunService,
    private readonly watch: HookWatchService,
    private readonly cdc: HookCdcService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
    private readonly databaseSink: DatabaseSinkService,
    private readonly lifecycle: HookLifecycleService,
  ) {}

  /* ----- CRUD ----- */

  @Get()
  list(@Query('workspaceId') workspaceId?: string): Promise<Hook[]> {
    return this.store.list(workspaceId);
  }

  // latest run status per bridge in a workspace (drives the map edge colors).
  // declared before ':id' so "statuses" isn't captured as a hook id.
  @Get('statuses')
  statuses(@Query('workspaceId') workspaceId: string) {
    return this.runs.workspaceStatuses(workspaceId);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(hookInputSchema)) dto: HookInputDTO,
  ): Promise<Hook> {
    const hook = await this.store.create(dto);
    // queue a draft run so the timeline shows the planned deliveries right away
    await this.runs.prepare(hook.id).catch(() => undefined);
    return hook;
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Hook> {
    return this.store.get(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(hookInputSchema)) dto: HookInputDTO,
  ): Promise<Hook> {
    // stop a live listener BEFORE the config changes, routed by the OLD trigger
    // kind — routing by the new one after an edit (say cdc → watch) would leave
    // the old stream running as a zombie, delivering into a finalized run
    const before = await this.store.get(id);
    const wasListening =
      before.trigger.kind === 'cdc' || before.trigger.kind === 'watch'
        ? await this.lifecycle.stopListener(id, before.trigger.kind)
        : false;

    const hook = await this.store.update(id, dto);
    // the destination may have changed; drop the sink's ensured-table cache
    this.databaseSink.forget(id);
    // refresh an existing draft so its queued timeline reflects the new config
    await this.runs.prepare(id, { onlyExisting: true }).catch(() => undefined);

    // it was live when the user hit save, so bring it back up on the new config
    if (wasListening && hook.enabled) {
      try {
        if (hook.trigger.kind === 'cdc') await this.cdc.start(id);
        else if (hook.trigger.kind === 'watch') await this.watch.start(id);
      } catch (err) {
        this.logger.warn(
          `Bridge ${id} was live but could not restart on the new config (left paused): ${(err as Error).message}`,
        );
      }
    }
    return hook;
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
    @Body(new ZodValidationPipe(hookPreviewSchema)) dto: HookPreviewDTO,
  ): Promise<HookPreview> {
    const hook = await this.store.resolve(id);
    const table = hook.source.kind === 'table' ? hook.source.table : '(query)';
    const now = new Date().toISOString();

    let rows: Record<string, unknown>[];
    let fromSource: boolean;
    if (dto.sampleRow) {
      rows = [dto.sampleRow];
      fromSource = false;
    } else {
      rows = await this.fetchSample(hook.source, dto.limit);
      fromSource = true;
    }

    const dest = hook.destination;

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
      const result = renderRow(row, hook.transform, { table, now, index });
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
    source: Hook['source'],
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

  /* ----- runs ----- */

  @Post(':id/runs')
  startRun(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(startRunSchema)) dto: StartRunDTO,
  ): Promise<HookRun> {
    return this.runs.start(id, dto);
  }

  /* ----- live listening (polling watch OR event-based CDC) ----- */

  @Post('cdc/readiness')
  cdcReadiness(
    @Body(new ZodValidationPipe(cdcReadinessSchema)) dto: CdcReadinessDTO,
  ): Promise<CdcReadiness> {
    return this.cdc.readiness(dto);
  }

  @Post(':id/watch/start')
  async startWatch(@Param('id') id: string): Promise<HookRun> {
    const hook = await this.store.get(id);
    return hook.trigger.kind === 'cdc' ? this.cdc.start(id) : this.watch.start(id);
  }

  @Post(':id/watch/stop')
  async stopWatch(@Param('id') id: string): Promise<HookRun | null> {
    await this.store.get(id); // 404s if missing
    // stop BOTH mechanisms, not just the current trigger kind: a hook edited
    // across kinds may still have the other's listener running. cdc.stop goes
    // first so the run it finalizes is the one reported back
    const cdcRun = await this.cdc.stop(id);
    const watchRun = await this.watch.stop(id);
    return cdcRun ?? watchRun;
  }

  @Get(':id/runs')
  listRuns(@Param('id') id: string): Promise<HookRun[]> {
    return this.runs.listRuns(id);
  }

  @Get(':id/runs/:runId')
  getRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<HookRun> {
    return this.runs.getRun(id, runId);
  }

  @Post(':id/runs/:runId/retry-failed')
  retryFailed(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<HookRun> {
    return this.runs.resendFailed(id, runId);
  }

  @Post(':id/runs/:runId/cancel')
  async cancelRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<HookRun> {
    // listening runs aren't queue jobs: plain cancel would strand them in
    // 'canceling' while the stream keeps delivering. canceling one means
    // stopping the listener (the run pauses, keeping its cursor)
    const hook = await this.store.get(id).catch(() => null);
    if (hook && (hook.trigger.kind === 'watch' || hook.trigger.kind === 'cdc')) {
      const run = await this.runs.getRun(id, runId);
      if (['queued', 'running', 'canceling'].includes(run.status)) {
        const stopped = (await this.cdc.stop(id)) ?? (await this.watch.stop(id));
        if (stopped && stopped.id === runId) return stopped;
      }
      return this.runs.getRun(id, runId);
    }
    return this.runs.cancel(id, runId);
  }

  @Get(':id/runs/:runId/deliveries')
  async listDeliveries(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<HookDelivery[]> {
    await this.runs.getRun(id, runId); // 404 unless the run belongs to this hook
    const valid = status === 'success' || status === 'failed' || status === 'skipped';
    return this.runs.listDeliveries(runId, {
      status: valid ? (status as 'success' | 'failed' | 'skipped') : undefined,
      from: parseBound('from', from),
      to: parseBound('to', to),
      offset: parseBound('offset', offset),
      limit: parseBound('limit', limit),
    });
  }

  @Post(':id/runs/:runId/skip')
  async skip(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(skipSchema)) dto: SkipDTO,
  ): Promise<{ skipped: number }> {
    await this.runs.getRun(id, runId); // 404 unless the run belongs to this hook
    const skipped = await this.runs.skipDeliveries(runId, dto.sequences);
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
