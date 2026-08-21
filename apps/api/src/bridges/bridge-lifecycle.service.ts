/**
 * one owner for "make this bridge stop touching the world": stopping live
 * listeners and tearing a bridge down before deletion. the same sequence used
 * to be hand-rolled in both the bridges and workspaces controllers and had
 * already drifted (workspace deletes left in-flight replay jobs to die on
 * NotFoundError and never dropped cross-kind listener remnants).
 */
import { Injectable } from '@nestjs/common';
import type { BridgeJob } from '@syncle/core';
import { DatabaseSinkService } from './database-sink.service';
import { BridgeCdcService } from './bridge-cdc.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeWatchService } from './bridge-watch.service';

@Injectable()
export class BridgeLifecycleService {
  constructor(
    private readonly cdc: BridgeCdcService,
    private readonly watch: BridgeWatchService,
    private readonly jobs: BridgeJobService,
    private readonly databaseSink: DatabaseSinkService,
  ) {}

  /**
   * stop the live listener of a specific trigger kind (used before an edit,
   * routed by the OLD kind so a cdc→watch change can't leave a zombie stream).
   * returns whether a listener was actually running.
   */
  async stopListener(bridgeId: string, kind: 'cdc' | 'watch'): Promise<boolean> {
    if (kind === 'cdc') {
      return (await this.cdc.stop(bridgeId).catch(() => null)) !== null;
    }
    return (await this.watch.stop(bridgeId).catch(() => null)) !== null;
  }

  /**
   * full pre-delete teardown. tears down BOTH listener kinds (a bridge edited
   * across trigger kinds may have remnants of either; each is a no-op when
   * idle), drops the CDC slot/publication on the source, cancels queued and
   * running replay jobs so no worker keeps delivering for a bridge that is
   * about to vanish, and clears the sink's ensured-table cache.
   */
  async teardown(bridgeId: string): Promise<void> {
    await this.cdc.cleanup(bridgeId).catch(() => undefined);
    await this.watch.stop(bridgeId).catch(() => undefined);
    const jobs = await this.jobs.listJobs(bridgeId).catch(() => [] as BridgeJob[]);
    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'running') {
        await this.jobs.cancel(bridgeId, job.id).catch(() => undefined);
      }
    }
    this.databaseSink.forget(bridgeId);
  }
}
