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
import { shapeRows } from './row-shaping';

type Row = Record<string, unknown>;

/** a delivery that was never attempted, because the rows could not be shaped */
export function failedBeforeSending(errors: string[], op?: CdcOperation): DeliveryOutcome {
  const shown = errors.slice(0, 5).join('; ') + (errors.length > 5 ? `; and ${errors.length - 5} more` : '');
  return {
    status: 'failed',
    httpStatus: null,
    attempts: 0,
    error: `Column transform failed — ${shown}. Fix the source value, or set the cast's "on error" to null or keep.`,
    requestBody: null,
    responseBody: null,
    durationMs: 0,
    op: op ?? null,
  };
}

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
    // masking, casts and computed columns first: both kinds of destination get
    // the same row, and what is recorded of the delivery is what was delivered
    const shaped = shapeRows(bridge, rows, ctx);
    if (shaped.errors.length > 0) {
      // a value the bridge was told to cast and could not. nothing is sent: a
      // failed delivery, which says what is wrong with WHICH column in the
      // bridge's own words — instead of whatever the destination would have made
      // of it. under `continue` the usual bisection then sets that row aside
      return { outcome: failedBeforeSending(shaped.errors, ctx.op), warnings: shaped.warnings };
    }
    rows = shaped.rows;

    if (dest.kind === 'database') {
      const outcome = await this.databaseSink.deliver(
        bridge,
        dest.targets,
        rows,
        ctx.op,
        ctx.skipTargets ? new Set(ctx.skipTargets) : undefined,
      );
      return { outcome, warnings: shaped.warnings };
    }

    // HTTP: CDC exposes `{{$op}}` to the template by merging it into each row
    const scoped = ctx.op ? rows.map((r) => ({ ...r, $op: ctx.op })) : rows;
    const { body, warnings: renderWarnings } =
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
    return { outcome: { ...outcome, op: ctx.op ?? null }, warnings: [...shaped.warnings, ...renderWarnings] };
  }
}
