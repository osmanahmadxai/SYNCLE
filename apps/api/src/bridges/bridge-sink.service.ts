/**
 * the single delivery entry point shared by every runner (replay processor,
 * watch poller, CDC stream). it renders + dispatches a batch of rows to the
 * bridge's destination, HTTP endpoint or one/more databases, and returns a
 * uniform {@link DeliveryOutcome} so the job/monitor machinery is identical
 * regardless of where the rows land.
 *
 * centralizing this also removes the render duplication the three call sites
 * used to carry.
 */
import { Injectable } from '@nestjs/common';
import {
  renderBatch,
  renderRow,
  type CdcOperation,
} from '@syncle/core';
import { DeliveryService } from './delivery.service';
import { DatabaseSinkService } from './database-sink.service';
import type { DeliveryOutcome, ResolvedBridge } from './bridges.types';

type Row = Record<string, unknown>;

export interface DeliverContext {
  /** resolves `{{$table}}` in HTTP templates */
  table: string;
  /** ISO timestamp for `{{$now}}`, captured once per delivery */
  now: string;
  /** 0-based index of the first row in this batch (for `{{$index}}`) */
  startIndex: number;
  /** CDC operation, when rows came from a change stream */
  op?: CdcOperation;
  /**
   * database targets that already committed on a previous attempt of this same
   * delivery (persisted target keys); the sink skips them on a retry so a
   * partial fan-out failure can't double-write the targets that succeeded
   */
  skipTargets?: string[];
}

@Injectable()
export class BridgeSinkService {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly databaseSink: DatabaseSinkService,
  ) {}

  /** render + deliver one batch; warnings are only meaningful for HTTP preview */
  async deliver(
    bridge: ResolvedBridge,
    rows: Row[],
    ctx: DeliverContext,
    signal: AbortSignal,
    idempotencyKey?: string,
  ): Promise<{ outcome: DeliveryOutcome; warnings: string[] }> {
    const dest = bridge.destination;

    if (dest.kind === 'database') {
      const outcome = await this.databaseSink.deliver(
        bridge,
        dest.targets,
        rows,
        ctx.op,
        ctx.skipTargets ? new Set(ctx.skipTargets) : undefined,
      );
      return { outcome, warnings: [] };
    }

    // HTTP: CDC exposes `{{$op}}` to the template by merging it into each row
    const scoped = ctx.op ? rows.map((r) => ({ ...r, $op: ctx.op })) : rows;
    const { body, warnings } =
      scoped.length === 1
        ? renderRow(scoped[0]!, bridge.transform, {
            table: ctx.table,
            now: ctx.now,
            index: ctx.startIndex,
          })
        : renderBatch(scoped, bridge.transform, ctx.startIndex, {
            table: ctx.table,
            now: ctx.now,
          });
    const outcome = await this.delivery.send(
      body,
      dest,
      bridge.delivery,
      signal,
      idempotencyKey,
    );
    // stamp the operation so it persists with the delivery row: a later resend
    // must know e.g. that this batch was a CDC delete
    return { outcome: { ...outcome, op: ctx.op ?? null }, warnings };
  }
}
