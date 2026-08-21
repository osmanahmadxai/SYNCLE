/**
 * one owner for "make this hook stop touching the world": stopping live
 * listeners and tearing a hook down before deletion. the same sequence used
 * to be hand-rolled in both the hooks and workspaces controllers and had
 * already drifted (workspace deletes left in-flight replay runs to die on
 * NotFoundError and never dropped cross-kind listener remnants).
 */
import { Injectable } from '@nestjs/common';
import type { HookRun } from '@syncle/core';
import { DatabaseSinkService } from './database-sink.service';
import { HookCdcService } from './hook-cdc.service';
import { HookRunService } from './hook-run.service';
import { HookWatchService } from './hook-watch.service';

@Injectable()
export class HookLifecycleService {
  constructor(
    private readonly cdc: HookCdcService,
    private readonly watch: HookWatchService,
    private readonly runs: HookRunService,
    private readonly databaseSink: DatabaseSinkService,
  ) {}

  /**
   * stop the live listener of a specific trigger kind (used before an edit,
   * routed by the OLD kind so a cdc→watch change can't leave a zombie stream).
   * returns whether a listener was actually running.
   */
  async stopListener(hookId: string, kind: 'cdc' | 'watch'): Promise<boolean> {
    if (kind === 'cdc') {
      return (await this.cdc.stop(hookId).catch(() => null)) !== null;
    }
    return (await this.watch.stop(hookId).catch(() => null)) !== null;
  }

  /**
   * full pre-delete teardown. tears down BOTH listener kinds (a hook edited
   * across trigger kinds may have remnants of either; each is a no-op when
   * idle), drops the CDC slot/publication on the source, cancels queued and
   * running replay runs so no worker keeps delivering for a hook that is
   * about to vanish, and clears the sink's ensured-table cache.
   */
  async teardown(hookId: string): Promise<void> {
    await this.cdc.cleanup(hookId).catch(() => undefined);
    await this.watch.stop(hookId).catch(() => undefined);
    const runs = await this.runs.listRuns(hookId).catch(() => [] as HookRun[]);
    for (const run of runs) {
      if (run.status === 'queued' || run.status === 'running') {
        await this.runs.cancel(hookId, run.id).catch(() => undefined);
      }
    }
    this.databaseSink.forget(hookId);
  }
}
