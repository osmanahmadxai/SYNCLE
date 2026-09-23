/**
 * The dead-letter queue: rows a LIVE bridge (CDC / watch) could not deliver
 * while set to `onError: continue`.
 *
 * Why it exists. A change stream is read once. When the bridge acknowledges a
 * position, the source is free to discard everything before it — a Postgres
 * slot advances, a binlog is purged — so a row that failed and was then stepped
 * over cannot be read again. `continue` therefore has to put the row somewhere
 * durable BEFORE the cursor moves. That is `park`. If parking fails, the caller
 * must not advance.
 *
 * How a retry stays correct. Replaying a recorded change hours later is unsafe:
 * the stream may since have delivered a NEWER version of the same row, and the
 * old payload would overwrite it. So for a database destination fed from a
 * keyed table, a retry does not replay the recording — it re-reads the row from
 * the source by primary key and writes what is there NOW:
 *
 *   - the row exists            → upsert its current state
 *   - the row is gone           → delete it at the destination (when the bridge
 *                                  propagates deletes)
 *   - the row no longer matches
 *     the bridge's filters      → nothing to write; the stream would have
 *                                  ignored it too
 *
 * That converges on the source's state whatever order things arrived in, which
 * is what makes retrying safe while the bridge is still streaming. The one case
 * it cannot settle is a row that is gone from a bridge that does NOT propagate
 * deletes: the recording might be the newest version or an outdated one, and
 * nothing can tell which. Those are left alone unless the caller passes `force`.
 *
 * Recordings are replayed as-is only where that is the right thing: HTTP
 * destinations (the receiver wants the event), append-only `insert` targets (the
 * row was never appended), and sources with no primary key to re-read by.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  type BridgeDeadLetter,
  type CdcOperation,
  type DatabaseTarget,
  type DeadLetterDiscardDTO,
  type DeadLetterPage,
  type DeadLetterRetryDTO,
  type DeadLetterRetryResult,
  type DeadLetterStatus,
  type FilterSpec,
} from '@syncle/core';
import type { BridgeDeadLetter as DeadLetterRow } from '@prisma/client';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { PrismaService } from '../common/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeSinkService } from './bridge-sink.service';
import { BridgeStoreService } from './bridge-store.service';
import { DatabaseSinkService, targetKey } from './database-sink.service';
import type { DeliveryOutcome, ResolvedBridge } from './bridges.types';
import { rowMatchesFilters } from './cdc/filter-match';
import { shapeRows } from './row-shaping';
import { SchemaDriftService } from './schema-drift.service';
import { failedBeforeSending } from './bridge-sink.service';
import { decodeRows, encodeRows, rowsForDisplay } from './row-codec';

type Row = Record<string, unknown>;

/** one failed unit to set aside */
export interface NewDeadLetter {
  bridgeId: string;
  jobId: string;
  sequence: number;
  op: CdcOperation | null;
  rows: Row[];
  cursor: string | null;
  error: string | null;
  /** fan-out targets that already hold these rows */
  succeededTargets: string[];
}

/** how many entries one retry call works through */
const RETRY_BATCH = 500;
/** source rows re-read per query when refreshing by a single-column key */
const REFRESH_CHUNK = 500;

type Verdict = 'resolved' | 'stillFailing' | 'needsForce';

/** stored on an entry a plain retry had to leave alone; also how the API flags it */
const NEEDS_FORCE_ERROR =
  'The source row no longer exists, and this bridge does not propagate deletes, ' +
  'so Syncle cannot tell whether the recorded row is still the newest version. ' +
  'Retry with "force" to write the recorded row anyway, or discard it.';

@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger('DeadLetters');
  /** bridges with a retry in progress in this process */
  private readonly retrying = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly databaseSink: DatabaseSinkService,
    private readonly jobs: BridgeJobService,
    private readonly alerts: AlertsService,
    private readonly drift: SchemaDriftService,
  ) {}

  /* ----- writing ----- */

  /**
   * set rows aside. one transaction, so either every entry is stored or none
   * is — the caller advances its cursor only when this resolves.
   *
   * `replaceFrom` makes a repeat harmless. if the process dies after parking
   * but before the cursor is saved, the same batch is read, fails and is parked
   * again on restart. a job's sequences at or above the one it is about to use
   * can only be left over from such an attempt (the saved sequence is always
   * past everything already settled), so those pending entries are replaced
   * rather than duplicated.
   */
  async park(
    entries: NewDeadLetter[],
    opts: { replaceFrom?: number } = {},
  ): Promise<void> {
    if (entries.length === 0) return;
    const jobId = entries[0]!.jobId;
    const create = this.prisma.bridgeDeadLetter.createMany({
      data: entries.map((e) => ({
        id: randomUUID(),
        bridgeId: e.bridgeId,
        jobId: e.jobId,
        sequence: e.sequence,
        op: e.op,
        rowsJson: encodeRows(e.rows),
        rowCount: e.rows.length,
        cursor: e.cursor,
        error: e.error,
        succeededTargetsJson: e.succeededTargets.length
          ? JSON.stringify(e.succeededTargets)
          : null,
      })),
    });
    if (opts.replaceFrom === undefined) {
      await create;
    } else {
      await this.prisma.$transaction([
        this.prisma.bridgeDeadLetter.deleteMany({
          where: {
            jobId,
            status: 'pending',
            sequence: { gte: opts.replaceFrom },
          },
        }),
        create,
      ]);
    }
    // the bridge carries on (that is what `continue` means), so nothing else
    // will say that rows are now waiting for someone. throttled per bridge: a
    // run of bad rows is one alert, with a count of the ones not sent
    const rows = entries.reduce((n, e) => n + e.rows.length, 0);
    this.alerts.emitForJob(jobId, {
      type: 'bridge.dead_letters',
      severity: 'warning',
      title: (name) =>
        `${rows} row${rows === 1 ? ' was' : 's were'} set aside on bridge "${name}"`,
      message:
        `The bridge is still running; ${rows === 1 ? 'this row is' : 'these rows are'} in its dead-letter queue until someone retries or discards ${rows === 1 ? 'it' : 'them'}. ` +
        `First error: ${entries[0]!.error ?? 'unknown'}`,
    });
  }

  /* ----- reading ----- */

  /** the pending entries that hold the rows of ONE delivery */
  async pendingIds(bridgeId: string, jobId: string, sequence: number): Promise<string[]> {
    const rows = await this.prisma.bridgeDeadLetter.findMany({
      where: { bridgeId, jobId, sequence, status: 'pending' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** undelivered rows a bridge is holding, for the queue-size bound */
  async pendingRows(bridgeId: string): Promise<number> {
    const agg = await this.prisma.bridgeDeadLetter.aggregate({
      where: { bridgeId, status: 'pending' },
      _sum: { rowCount: true },
    });
    return agg._sum.rowCount ?? 0;
  }

  async page(
    bridgeId: string,
    opts: { status?: DeadLetterStatus; limit?: number; offset?: number } = {},
  ): Promise<DeadLetterPage> {
    await this.store.get(bridgeId); // 404s if the bridge is gone
    const [rows, pending] = await Promise.all([
      this.prisma.bridgeDeadLetter.findMany({
        where: { bridgeId, ...(opts.status ? { status: opts.status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: opts.offset ?? 0,
        take: Math.min(opts.limit ?? 100, 500),
      }),
      this.prisma.bridgeDeadLetter.aggregate({
        where: { bridgeId, status: 'pending' },
        _sum: { rowCount: true },
        _count: true,
      }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r)),
      pendingEntries: pending._count,
      pendingRows: pending._sum.rowCount ?? 0,
    };
  }

  /* ----- discard ----- */

  /** give up on entries: they stay on record, but are never retried */
  async discard(
    bridgeId: string,
    dto: DeadLetterDiscardDTO,
  ): Promise<{ discarded: number }> {
    await this.store.get(bridgeId);
    const res = await this.prisma.bridgeDeadLetter.updateMany({
      where: {
        bridgeId,
        status: 'pending',
        ...(dto.ids ? { id: { in: dto.ids } } : {}),
      },
      data: { status: 'discarded', resolvedAt: new Date() },
    });
    return { discarded: res.count };
  }

  /* ----- retry ----- */

  async retry(
    bridgeId: string,
    dto: DeadLetterRetryDTO,
  ): Promise<DeadLetterRetryResult> {
    // two retries over the same entries would both write them and both flip the
    // same delivery; the second caller is told rather than queued
    if (this.retrying.has(bridgeId)) {
      throw new ConflictError('A retry is already running for this bridge.');
    }
    this.retrying.add(bridgeId);
    try {
      const bridge = await this.store.resolve(bridgeId);
      // a retry re-reads each row from the source. from a table that has lost a
      // column the bridge maps, that row comes back without it — and would be
      // written with NULL in its place, by the very button meant to repair things
      const verdict = await this.drift.check(bridge);
      if (verdict.stop) {
        throw new BadRequestError(verdict.stop, {
          reason: 'schema-drift',
          missingUsed: verdict.missingUsed,
        });
      }
      const entries = await this.prisma.bridgeDeadLetter.findMany({
        where: {
          bridgeId,
          status: 'pending',
          ...(dto.ids ? { id: { in: dto.ids } } : {}),
        },
        // oldest first: for as-recorded replays that is the order they happened
        orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
        take: RETRY_BATCH,
      });

      const result: DeadLetterRetryResult = {
        resolved: 0,
        stillFailing: 0,
        needsForce: 0,
      };
      const sourceKey = await this.sourcePrimaryKey(bridge);
      const touched = new Set<string>(); // `${jobId}:${sequence}` of resolved entries

      for (const entry of entries) {
        const verdict = await this.retryOne(
          bridge,
          entry,
          sourceKey,
          dto.force,
        );
        result[verdict]++;
        if (verdict === 'resolved')
          touched.add(`${entry.jobId}:${entry.sequence}`);
      }

      for (const key of touched) {
        const [jobId, sequence] = key.split(':');
        await this.markDeliveryRecovered(jobId!, Number(sequence)).catch(
          (err) =>
            this.logger.warn(
              `Could not update delivery ${key}: ${(err as Error).message}`,
            ),
        );
      }
      return result;
    } finally {
      this.retrying.delete(bridgeId);
    }
  }

  private async retryOne(
    bridge: ResolvedBridge,
    entry: DeadLetterRow,
    sourceKey: string[] | null,
    force: boolean,
  ): Promise<Verdict> {
    let rows: Row[];
    try {
      rows = decodeRows(entry.rowsJson);
    } catch (err) {
      await this.fail(
        entry,
        `The stored rows cannot be read: ${(err as Error).message}`,
        null,
      );
      return 'stillFailing';
    }
    const op = (entry.op ?? undefined) as CdcOperation | undefined;
    const done = readTargets(entry.succeededTargetsJson);

    try {
      if (bridge.destination.kind === 'http') {
        const outcome = await this.replay(bridge, rows, op, entry, done);
        return await this.settle(entry, outcome, done);
      }

      const keyed =
        bridge.source.kind === 'table' &&
        sourceKey !== null &&
        rows.every((r) =>
          sourceKey.every((c) => r[c] !== undefined && r[c] !== null),
        );
      if (!keyed) {
        // nothing to re-read the row by: the recording is all there is
        const outcome = await this.replay(bridge, rows, op, entry, done);
        return await this.settle(entry, outcome, done);
      }
      return await this.refresh(
        bridge,
        entry,
        rows,
        op,
        sourceKey!,
        done,
        force,
      );
    } catch (err) {
      await this.fail(entry, (err as Error).message, null);
      return 'stillFailing';
    }
  }

  /** send the recorded rows exactly as they were read */
  private replay(
    bridge: ResolvedBridge,
    rows: Row[],
    op: CdcOperation | undefined,
    entry: DeadLetterRow,
    done: string[],
  ): Promise<DeliveryOutcome> {
    const dest = bridge.destination;
    const idem =
      dest.kind === 'http' && dest.idempotency
        ? `${entry.jobId}:dl:${entry.id}`
        : undefined;
    return this.sink
      .deliver(
        bridge,
        rows,
        {
          table:
            bridge.source.kind === 'table' ? bridge.source.table : '(query)',
          now: new Date().toISOString(),
          startIndex: entry.sequence,
          op,
          skipTargets: done,
        },
        new AbortController().signal,
        idem,
      )
      .then((r) => r.outcome);
  }

  /**
   * database destination, keyed source: converge each target on the source's
   * CURRENT state for these keys (see the file header for why).
   */
  private async refresh(
    bridge: ResolvedBridge,
    entry: DeadLetterRow,
    recorded: Row[],
    op: CdcOperation | undefined,
    sourceKey: string[],
    done: string[],
    force: boolean,
  ): Promise<Verdict> {
    if (
      bridge.destination.kind !== 'database' ||
      bridge.source.kind !== 'table'
    ) {
      throw new Error(
        'refresh needs a table source and a database destination',
      );
    }
    const src = bridge.source;
    const pending = bridge.destination.targets.filter(
      (t) => !done.includes(targetKey(t)),
    );
    // append-only targets record events; what they are owed is the event itself
    const appendOnly = pending.filter((t) => t.writeMode === 'insert');
    const keyed = pending.filter((t) => t.writeMode !== 'insert');

    const current = await this.readSourceRows(src, sourceKey, recorded);
    const sig = (r: Row): string =>
      JSON.stringify(sourceKey.map((c) => String(r[c])));
    const bySig = new Map(current.map((r) => [sig(r), r]));

    const present: Row[] = [];
    const absent: Row[] = [];
    for (const r of recorded) {
      const now = bySig.get(sig(r));
      if (!now) absent.push(r);
      // out of the bridge's filter scope: the stream ignores such rows, and so
      // does a retry — writing it would put a row the bridge never syncs
      else if (
        rowMatchesFilters(now, src.filters, { passMissingColumns: false })
      )
        present.push(now);
    }

    const propagatesDeletes =
      bridge.trigger.kind === 'cdc' &&
      bridge.trigger.operations.includes('delete');
    if (keyed.length > 0 && absent.length > 0 && !propagatesDeletes && !force) {
      await this.prisma.bridgeDeadLetter.update({
        where: { id: entry.id },
        data: { error: NEEDS_FORCE_ERROR },
      });
      return 'needsForce';
    }

    const succeeded = new Set(done);
    let firstError: string | null = null;
    const run = async (
      targets: DatabaseTarget[],
      rows: Row[],
      asOp: CdcOperation | undefined,
    ): Promise<string[]> => {
      if (targets.length === 0 || rows.length === 0)
        return targets.map(targetKey);
      // these rows come straight from the source (or from the parked copy of
      // it): masked, cast and computed like any other delivery of this bridge
      const shaped = shapeRows(bridge, rows, {
        table: src.table,
        now: new Date().toISOString(),
        op: asOp,
      });
      if (shaped.errors.length > 0) {
        firstError ??= failedBeforeSending(shaped.errors, asOp).error;
        return [];
      }
      const outcome = await this.databaseSink.deliver(
        bridge,
        targets,
        shaped.rows,
        asOp,
      );
      if (outcome.status === 'success') return targets.map(targetKey);
      firstError ??= outcome.error;
      return outcome.succeededTargets ?? [];
    };

    // keyed targets: every step is an idempotent upsert/delete, so a target
    // counts as done only when ALL of its steps went through; a partial pass is
    // simply repeated next time
    const upserted = await run(keyed, present, undefined);
    const removed = propagatesDeletes
      ? await run(keyed, absent, 'delete')
      : await run(keyed, absent, undefined); // forced: write the recording
    for (const t of keyed) {
      const k = targetKey(t);
      if (upserted.includes(k) && removed.includes(k)) succeeded.add(k);
    }
    // append-only targets take the event as recorded, exactly once per target
    for (const k of await run(appendOnly, recorded, op)) succeeded.add(k);

    if (firstError === null) {
      await this.resolve(entry);
      return 'resolved';
    }
    await this.fail(entry, firstError, [...succeeded]);
    return 'stillFailing';
  }

  /** the rows' CURRENT versions at the source, looked up by primary key */
  private async readSourceRows(
    src: Extract<ResolvedBridge['source'], { kind: 'table' }>,
    key: string[],
    rows: Row[],
  ): Promise<Row[]> {
    const browse = (filters: FilterSpec[], limit: number): Promise<Row[]> =>
      this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a
          .browse({
            schema: src.schema,
            table: src.table,
            filters,
            limit,
            offset: 0,
          })
          .then((p) => p.rows),
      );

    const found: Row[] = [];
    if (key.length === 1) {
      const column = key[0]!;
      for (let i = 0; i < rows.length; i += REFRESH_CHUNK) {
        const values = rows.slice(i, i + REFRESH_CHUNK).map((r) => r[column]);
        found.push(
          ...(await browse(
            [{ column, operator: 'in', value: values }],
            values.length,
          )),
        );
      }
      return found;
    }
    // composite key: an IN over tuples is not portable across engines
    for (const r of rows) {
      const filters = key.map((column) => ({
        column,
        operator: 'eq' as const,
        value: r[column],
      }));
      found.push(...(await browse(filters, 1)));
    }
    return found;
  }

  /** the source table's primary key, or null when it has none / is unreadable */
  private async sourcePrimaryKey(
    bridge: ResolvedBridge,
  ): Promise<string[] | null> {
    if (bridge.source.kind !== 'table') return null;
    const src = bridge.source;
    try {
      const page = await this.pool.withAdapter(
        src.connectionId,
        src.database,
        (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            limit: 1,
            offset: 0,
          }),
      );
      return page.primaryKey.length ? page.primaryKey : null;
    } catch {
      return null;
    }
  }

  /* ----- bookkeeping ----- */

  private async settle(
    entry: DeadLetterRow,
    outcome: DeliveryOutcome,
    done: string[],
  ): Promise<Verdict> {
    if (outcome.status === 'success') {
      await this.resolve(entry);
      return 'resolved';
    }
    const succeeded = [
      ...new Set([...done, ...(outcome.succeededTargets ?? [])]),
    ];
    await this.fail(entry, outcome.error ?? 'delivery failed', succeeded);
    return 'stillFailing';
  }

  private async resolve(entry: DeadLetterRow): Promise<void> {
    await this.prisma.bridgeDeadLetter.update({
      where: { id: entry.id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        attempts: { increment: 1 },
        error: null,
      },
    });
  }

  /** `succeeded: null` leaves the stored fan-out checkpoint as it is */
  private async fail(
    entry: DeadLetterRow,
    error: string,
    succeeded: string[] | null,
  ): Promise<void> {
    await this.prisma.bridgeDeadLetter.update({
      where: { id: entry.id },
      data: {
        attempts: { increment: 1 },
        error,
        ...(succeeded !== null
          ? {
              succeededTargetsJson: succeeded.length
                ? JSON.stringify(succeeded)
                : null,
            }
          : {}),
      },
    });
  }

  /**
   * once nothing from a failed delivery is still waiting, show it as delivered:
   * the timeline cell flips from red to green and the job's counters follow.
   * a delivery with discarded rows stays failed — those rows never arrived.
   */
  private async markDeliveryRecovered(
    jobId: string,
    sequence: number,
  ): Promise<void> {
    const open = await this.prisma.bridgeDeadLetter.count({
      where: { jobId, sequence, status: { not: 'resolved' } },
    });
    if (open > 0) return;
    const d = await this.prisma.bridgeDelivery.findUnique({
      where: { jobId_sequence: { jobId, sequence } },
    });
    if (!d || d.status !== 'failed') return;
    await this.jobs.recordDelivery(
      jobId,
      {
        sequence,
        rowIndex: d.rowIndex,
        rowCount: d.rowCount,
        rowKeys: d.rowKeysJson
          ? (JSON.parse(d.rowKeysJson) as unknown[])
          : null,
      },
      {
        status: 'success',
        httpStatus: d.httpStatus,
        attempts: d.attempts + 1,
        error: null,
        requestBody: d.requestBody,
        responseBody: 'Delivered from the dead-letter queue.',
        durationMs: d.durationMs ?? 0,
      },
    );
  }

  private toDto(row: DeadLetterRow): BridgeDeadLetter {
    let rows: Row[] = [];
    try {
      rows = rowsForDisplay(row.rowsJson);
    } catch {
      /* unreadable payload: the entry is still listed, with its error */
    }
    return {
      id: row.id,
      bridgeId: row.bridgeId,
      jobId: row.jobId,
      sequence: row.sequence,
      op: (row.op as CdcOperation | null) ?? null,
      rowCount: row.rowCount,
      rows,
      error: row.error,
      attempts: row.attempts,
      needsForce: row.status === 'pending' && row.error === NEEDS_FORCE_ERROR,
      status: row.status as DeadLetterStatus,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    };
  }
}

function readTargets(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return []; // unreadable checkpoint: write every target (safe for upserts)
  }
}
