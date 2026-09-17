/**
 * verify: is a bridge's destination the copy of its source it is meant to be?
 * reconcile: make it so, touching only the rows that are not.
 *
 * How it looks, for every database target of the bridge:
 *
 *  1. the source is read once, a page at a time, the way a replay reads it. each
 *     page is turned into the rows the bridge WOULD write (same transforms, same
 *     value conversion, same mapping — by the sink's own code), the destination
 *     is asked for the rows with those keys, and the two are compared by what
 *     kind of value each column holds. → missing, different
 *  2. the destination is read once, and the source asked for ITS keys. → extra
 *
 * A live bridge is a moving target: a row read from the source a moment before
 * its change is delivered looks different, and is not. So nothing is reported
 * on first sight — what looks wrong is looked at AGAIN a little later, from
 * both ends, and only what is still wrong counts.
 *
 * A reconcile repairs from the source as it is at that second look, through the
 * bridge's own sink: never from what the first look saw. Rows the destination
 * has and the source does not are removed only when asked for, and then the way
 * the target's delete policy says (deleted, or marked).
 */
import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  VERIFICATION_SAMPLES,
  diffRow,
  keyText,
  remainingDifferences,
  volatileColumns,
  type BridgeVerification,
  type CompareKind,
  type DatabaseEngine,
  type DatabaseTarget,
  type FilterSpec,
  type VerificationStatus,
  type VerificationTargetResult,
  type VerifyStartDTO,
} from '@syncle/core';
import type { BridgeVerification as VerificationRow } from '@prisma/client';
import { lookupValues } from './lookup-values';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { BridgeStoreService } from './bridge-store.service';
import { DatabaseSinkService } from './database-sink.service';
import { shapeRows } from './row-shaping';
import { TableReaderService, type TableOrder } from './table-reader.service';
import {
  BRIDGE_VERIFY_QUEUE,
  type BridgeVerifyPayload,
  type ResolvedBridge,
} from './bridges.types';

type Row = Record<string, unknown>;

const ACTIVE: VerificationStatus[] = ['queued', 'running', 'canceling'];
/** verifications kept per bridge; older ones go when a new one starts */
const KEEP = 10;
/** suspects looked at again together */
const RECHECK_BATCH = 500;
/** a verification that says it is running and has not been touched for this long was cut off */
const STALE_MS = 3 * 60_000;
/** engines a target can be compared on: ones that can be asked for rows BY KEY */
const COMPARABLE: ReadonlySet<DatabaseEngine> = new Set([
  'postgres',
  'mysql',
  'sqlite',
  'mongodb',
]);

class Canceled extends Error {}

/** one target, while it is being verified */
interface TargetRun {
  target: DatabaseTarget;
  result: VerificationTargetResult;
  kinds: Record<string, CompareKind>;
  keyKinds: CompareKind[];
  /** the source column behind each key column of the target, in key order */
  sourceKeyColumns: string[];
  /** a key column's value is changed on the way (masked, cast, computed): the source cannot be asked for a destination key */
  keyIsTransformed: boolean;
  /** columns never compared: their value depends on when the row was delivered */
  skip: Set<string>;
  /** rows that looked wrong at first sight, waiting for a second look. keyed by key text */
  suspects: Map<string, { sourceRow: Row }>;
  /** destination keys with no source row at first sight */
  extraSuspects: Map<string, { key: unknown[] }>;
}

export { lookupValues };

@Injectable()
export class BridgeVerifyService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BridgeVerify');

  constructor(
    @InjectQueue(BRIDGE_VERIFY_QUEUE)
    private readonly queue: Queue<BridgeVerifyPayload>,
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly pool: AdapterPoolService,
    private readonly connections: ConnectionStoreService,
    private readonly reader: TableReaderService,
    private readonly databaseSink: DatabaseSinkService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.retireStale().catch(() => undefined);
  }

  /* ----- the API's side ----- */

  async start(
    bridgeId: string,
    dto: VerifyStartDTO,
  ): Promise<BridgeVerification> {
    const bridge = await this.store.get(bridgeId);
    if (bridge.source.kind !== 'table') {
      throw new BadRequestError(
        'Only a bridge that reads a table can be verified: a saved query has no rows to look up by key.',
        {
          reason: 'not-verifiable',
        },
      );
    }
    if (bridge.destination.kind !== 'database') {
      throw new BadRequestError(
        'Only a bridge that writes to a database can be verified: what an HTTP endpoint did with a row cannot be read back.',
        {
          reason: 'not-verifiable',
        },
      );
    }
    await this.retireStale();
    if (
      await this.prisma.bridgeVerification.findFirst({
        where: { bridgeId, status: { in: ACTIVE } },
        select: { id: true },
      })
    ) {
      throw new ConflictError(
        'A verification of this bridge is already running.',
      );
    }
    // a replay that is half-way is a destination that is half there: every row it
    // has not reached yet would be "missing", and a reconcile would race it
    if (bridge.trigger.kind === 'replay') {
      const replaying = await this.prisma.bridgeJob.findFirst({
        where: { bridgeId, status: { in: ['queued', 'running', 'canceling'] } },
        select: { id: true },
      });
      if (replaying)
        throw new ConflictError(
          'A replay of this bridge is running. Verify it when the replay has finished.',
        );
    }

    const row = await this.prisma.bridgeVerification.create({
      data: {
        id: randomUUID(),
        bridgeId,
        mode: dto.mode,
        deleteExtra: dto.mode === 'reconcile' && dto.deleteExtra,
        status: 'queued',
      },
    });
    try {
      await this.queue.add(
        'verify',
        { verificationId: row.id },
        {
          jobId: row.id,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } catch (err) {
      await this.prisma.bridgeVerification
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      throw err;
    }
    await this.prune(bridgeId);
    return this.toDto(row);
  }

  async list(bridgeId: string): Promise<BridgeVerification[]> {
    await this.store.get(bridgeId);
    await this.retireStale();
    const rows = await this.prisma.bridgeVerification.findMany({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
      take: KEEP,
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(bridgeId: string, id: string): Promise<BridgeVerification> {
    const row = await this.prisma.bridgeVerification.findUnique({
      where: { id },
    });
    if (!row || row.bridgeId !== bridgeId)
      throw new NotFoundError(`Verification "${id}" not found`);
    return this.toDto(row);
  }

  async cancel(bridgeId: string, id: string): Promise<BridgeVerification> {
    const row = await this.prisma.bridgeVerification.findUnique({
      where: { id },
    });
    if (!row || row.bridgeId !== bridgeId)
      throw new NotFoundError(`Verification "${id}" not found`);
    if (!ACTIVE.includes(row.status as VerificationStatus))
      return this.toDto(row);
    if (row.status === 'queued') {
      // not picked up yet: there is nothing to wind down
      await this.queue.remove(id).catch(() => undefined);
      return this.toDto(await this.finish(id, 'canceled', null));
    }
    return this.toDto(
      await this.prisma.bridgeVerification.update({
        where: { id },
        data: { status: 'canceling' },
      }),
    );
  }

  /** everything of a bridge that is about to go: nothing may keep writing to its targets */
  async cancelAll(bridgeId: string): Promise<void> {
    await this.prisma.bridgeVerification.updateMany({
      where: { bridgeId, status: { in: ['queued', 'running'] } },
      data: { status: 'canceling' },
    });
  }

  private async prune(bridgeId: string): Promise<void> {
    const old = await this.prisma.bridgeVerification.findMany({
      where: { bridgeId, status: { notIn: ACTIVE } },
      orderBy: { startedAt: 'desc' },
      skip: KEEP,
      select: { id: true },
    });
    if (old.length)
      await this.prisma.bridgeVerification.deleteMany({
        where: { id: { in: old.map((o) => o.id) } },
      });
  }

  /** a verification that was running when the API went away: said to have been cut off, not left "running" for ever */
  private async retireStale(): Promise<void> {
    await this.prisma.bridgeVerification.updateMany({
      where: {
        status: { in: ['running', 'canceling'] },
        heartbeatAt: { lt: new Date(Date.now() - STALE_MS) },
      },
      data: {
        status: 'failed',
        error:
          'Cut off: the API restarted while this was running. Start it again.',
        finishedAt: new Date(),
      },
    });
  }

  private async finish(
    id: string,
    status: VerificationStatus,
    error: string | null,
  ): Promise<VerificationRow> {
    return this.prisma.bridgeVerification.update({
      where: { id },
      data: { status, error, finishedAt: new Date(), heartbeatAt: new Date() },
    });
  }

  private toDto(row: VerificationRow): BridgeVerification {
    let targets: VerificationTargetResult[] = [];
    try {
      targets = row.resultJson
        ? (JSON.parse(row.resultJson) as VerificationTargetResult[])
        : [];
    } catch {
      targets = [];
    }
    const compared = targets.filter((t) => !t.unsupported);
    return {
      id: row.id,
      bridgeId: row.bridgeId,
      mode: row.mode === 'reconcile' ? 'reconcile' : 'verify',
      deleteExtra: row.deleteExtra,
      status: row.status as VerificationStatus,
      sourceRows: row.sourceRows,
      sourceTotal: row.sourceTotal,
      targets,
      inSync:
        row.status === 'completed' && compared.length > 0
          ? compared.every((t) => remainingDifferences(t) === 0)
          : null,
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }

  /* ----- the worker's side ----- */

  async run(id: string): Promise<void> {
    const row = await this.prisma.bridgeVerification.findUnique({
      where: { id },
    });
    if (!row || !['queued', 'running'].includes(row.status)) return; // canceled before it began, or gone with its bridge
    await this.prisma.bridgeVerification.update({
      where: { id },
      data: { status: 'running', heartbeatAt: new Date() },
    });

    let runs: TargetRun[] = [];
    let sourceRows = 0;
    try {
      const bridge = await this.store.resolve(row.bridgeId);
      if (
        bridge.source.kind !== 'table' ||
        bridge.destination.kind !== 'database'
      )
        throw new BadRequestError('This bridge cannot be verified.');
      const fix = row.mode === 'reconcile';
      const sourceEngine = (
        await this.connections.get(bridge.source.connectionId)
      ).engine;
      // only a bridge that is delivering right now moves under the comparison
      const moving =
        bridge.trigger.kind !== 'replay' &&
        !!(await this.prisma.bridgeJob.findFirst({
          where: { bridgeId: bridge.id, status: { in: ['queued', 'running'] } },
          select: { id: true },
        }));
      runs = await Promise.all(
        bridge.destination.targets.map((target) =>
          this.prepare(bridge, target),
        ),
      );
      const live = runs.filter((r) => !r.result.unsupported);

      // keeps the row current for whoever is watching, and notices a cancel
      let lastBeat = 0;
      const beat = async (force = false): Promise<void> => {
        if (!force && Date.now() - lastBeat < 1500) return;
        lastBeat = Date.now();
        const updated = await this.prisma.bridgeVerification.updateMany({
          where: { id, status: 'running' },
          data: {
            sourceRows,
            resultJson: JSON.stringify(runs.map((r) => r.result)),
            heartbeatAt: new Date(),
          },
        });
        if (updated.count === 0) throw new Canceled();
      };

      if (live.length > 0) {
        const order = await this.reader.resolveOrder(bridge);
        await this.prisma.bridgeVerification.updateMany({
          where: { id },
          data: { sourceTotal: order.total },
        });
        const table = bridge.source.table;

        /* pass 1: every row of the source, against every target */
        let page: Row[] = [];
        const flushPage = async (): Promise<void> => {
          if (page.length === 0) return;
          const rows = page;
          page = [];
          const shaped = shapeRows(bridge, rows, {
            table,
            now: new Date().toISOString(),
          }).rows;
          for (const run of live) {
            await this.compare(bridge, run, rows, shaped);
            if (run.suspects.size >= RECHECK_BATCH)
              await this.secondLook(bridge, run, sourceEngine, { moving, fix });
          }
          sourceRows += rows.length;
          await beat();
        };
        for await (const item of this.reader.rows(bridge, {
          startOffset: 0,
          resumeKey: null,
          order,
        })) {
          page.push(item.row);
          if (page.length >= bridge.delivery.pageSize) await flushPage();
        }
        await flushPage();
        for (const run of live)
          await this.secondLook(bridge, run, sourceEngine, { moving, fix });
        await beat(true);

        /* pass 2: every row of each target, against the source */
        for (const run of live) {
          await this.findExtras(
            bridge,
            run,
            sourceEngine,
            { moving, remove: fix && row.deleteExtra },
            beat,
          );
          await beat(true);
        }
      }

      const done = await this.prisma.bridgeVerification.updateMany({
        where: { id, status: 'running' },
        data: {
          status: 'completed',
          sourceRows,
          resultJson: JSON.stringify(runs.map((r) => r.result)),
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      if (done.count === 0) throw new Canceled();
    } catch (err) {
      const resultJson = JSON.stringify(runs.map((r) => r.result));
      if (err instanceof Canceled) {
        // (the row may be gone altogether: its bridge was deleted)
        await this.prisma.bridgeVerification
          .updateMany({
            where: { id },
            data: {
              status: 'canceled',
              sourceRows,
              resultJson,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Verification ${id} failed: ${message}`);
      await this.prisma.bridgeVerification
        .updateMany({
          where: { id },
          data: {
            status: 'failed',
            error: message,
            sourceRows,
            resultJson,
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
  }

  /** what is needed to compare one target — or why it cannot be */
  private async prepare(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
  ): Promise<TargetRun> {
    const result: VerificationTargetResult = {
      target: target.schema ? `${target.schema}.${target.table}` : target.table,
      connectionId: target.connectionId,
      unsupported: null,
      notes: [],
      checked: 0,
      missing: 0,
      different: 0,
      extra: null,
      fixed: 0,
      removed: 0,
      samples: { missing: [], extra: [], different: [] },
    };
    const run: TargetRun = {
      target,
      result,
      kinds: {},
      keyKinds: [],
      sourceKeyColumns: [],
      keyIsTransformed: false,
      skip: new Set(),
      suspects: new Map(),
      extraSuspects: new Map(),
    };
    if (target.keyColumns.length === 0) {
      result.unsupported =
        'This target has no key columns (it only inserts): there is nothing to find a row by.';
      return run;
    }
    const engine = (await this.connections.get(target.connectionId)).engine;
    if (!COMPARABLE.has(engine)) {
      result.unsupported = `A ${engine} destination cannot be asked for rows by key, so it cannot be compared.`;
      return run;
    }

    run.kinds = await this.databaseSink.columnKinds(bridge, target);
    run.keyKinds = target.keyColumns.map((k) => run.kinds[k] ?? 'unknown');
    const sourceOf = new Map(target.mapping.map((m) => [m.target, m.source]));
    run.sourceKeyColumns = target.keyColumns.map((k) =>
      target.mapping.length > 0 ? (sourceOf.get(k) ?? k) : k,
    );

    const steps = bridge.transform.columns ?? [];
    const written = new Set(steps.map((s) => s.column));
    run.keyIsTransformed = run.sourceKeyColumns.some((c) => written.has(c));
    // a column whose value is the time of delivery can never be the same twice
    const volatile = volatileColumns(steps);
    const targetOf = (sourceColumn: string): string[] =>
      target.mapping.length > 0
        ? target.mapping
            .filter((m) => m.source === sourceColumn)
            .map((m) => m.target)
        : [sourceColumn];
    for (const column of volatile)
      for (const name of targetOf(column)) run.skip.add(name);
    if (run.skip.size > 0)
      result.notes.push(
        `Not compared, because the value is the time of delivery: ${[...run.skip].join(', ')}.`,
      );
    return run;
  }

  /** the target's key of a row that is spelled the target's way */
  private keyOf(run: TargetRun, row: Row): unknown[] {
    return run.target.keyColumns.map((k) => row[k]);
  }

  /** first sight: a page of the source against one target. what looks wrong becomes a suspect, nothing more */
  private async compare(
    bridge: ResolvedBridge,
    run: TargetRun,
    sourceRows: Row[],
    shaped: Row[],
  ): Promise<void> {
    const expected = await this.databaseSink.expectedRows(
      bridge,
      run.target,
      shaped,
    );
    const keys = expected.map((row) => this.keyOf(run, row));
    const actual = await this.fetchByKeys(
      {
        connectionId: run.target.connectionId,
        database: run.target.database,
        schema: run.target.schema,
        table: run.target.table,
      },
      run.target.keyColumns,
      keys,
      run.keyKinds,
      (row) => this.keyOf(run, row),
    );
    expected.forEach((row, i) => {
      const key = keyText(keys[i]!, run.keyKinds);
      const found = actual.get(key);
      if (!found || this.differences(run, row, found).length > 0)
        run.suspects.set(key, { sourceRow: sourceRows[i]! });
    });
    run.result.checked += expected.length;
  }

  private differences(run: TargetRun, expected: Row, actual: Row) {
    return diffRow(expected, actual, run.kinds).filter(
      (d) => !run.skip.has(d.column),
    );
  }

  /**
   * the second look at what looked wrong: both ends read again, a moment later
   * when the bridge is delivering. only what is STILL wrong is counted — and, in
   * a reconcile, written from the source as it is now.
   *
   * a repair on a bridge that is delivering can be overtaken: the row is read,
   * the stream delivers a newer version, the repair lands on top of it. so what
   * was repaired is looked at once more, and written again if the two ends still
   * disagree. (for the stale version to survive THAT, the row would have to
   * change again inside the same few milliseconds, twice)
   */
  private async secondLook(
    bridge: ResolvedBridge,
    run: TargetRun,
    sourceEngine: DatabaseEngine,
    opts: { moving: boolean; fix: boolean },
  ): Promise<void> {
    if (run.suspects.size === 0 || bridge.source.kind !== 'table') return;
    const src = bridge.source;
    let pending = [...run.suspects.values()].map((s) => s.sourceRow);
    run.suspects.clear();
    const at = {
      connectionId: run.target.connectionId,
      database: run.target.database,
      schema: run.target.schema,
      table: run.target.table,
    };
    const rounds = opts.fix && opts.moving ? 3 : 1;

    for (let round = 0; round < rounds && pending.length > 0; round++) {
      if (opts.moving) {
        await sleep(runtimeConfig.verifyRecheckMs);
        // the rows as the source has them NOW. (a key that is transformed on the
        // way cannot be looked up there; the reading there is stands)
        if (!run.keyIsTransformed) {
          const again = await this.fetchByKeys(
            {
              connectionId: src.connectionId,
              database: src.database,
              schema: src.schema,
              table: src.table,
            },
            run.sourceKeyColumns,
            pending.map((row) => run.sourceKeyColumns.map((c) => row[c])),
            run.keyKinds,
            (row) => run.sourceKeyColumns.map((c) => row[c]),
            { filters: src.filters, engine: sourceEngine },
          );
          // a row that has gone from the source since is not missing from anywhere
          pending = [...again.values()];
          if (pending.length === 0) return;
        }
      }
      const shaped = shapeRows(bridge, pending, {
        table: src.table,
        now: new Date().toISOString(),
      }).rows;
      const expected = await this.databaseSink.expectedRows(
        bridge,
        run.target,
        shaped,
      );
      const keys = expected.map((row) => this.keyOf(run, row));
      const actual = await this.fetchByKeys(
        at,
        run.target.keyColumns,
        keys,
        run.keyKinds,
        (row) => this.keyOf(run, row),
      );

      const wrong: number[] = [];
      expected.forEach((row, i) => {
        const found = actual.get(keyText(keys[i]!, run.keyKinds));
        const columns = found ? this.differences(run, row, found) : [];
        if (found && columns.length === 0) return; // it was only in flight
        wrong.push(i);
        if (round > 0) return; // counted when it was found; this is the repair being checked
        if (!found) {
          run.result.missing++;
          if (run.result.samples.missing.length < VERIFICATION_SAMPLES)
            run.result.samples.missing.push(keys[i]!.map(show));
          return;
        }
        run.result.different++;
        if (run.result.samples.different.length < VERIFICATION_SAMPLES) {
          run.result.samples.different.push({
            key: keys[i]!.map(show),
            columns: columns.map((c) => ({
              column: c.column,
              expected: show(c.expected),
              actual: show(c.actual),
            })),
          });
        }
      });
      if (!opts.fix || wrong.length === 0) return;
      if (round === rounds - 1 && round > 0) {
        this.note(
          run,
          `${wrong.length} row(s) kept changing while they were being repaired. Verify again to see where they stand.`,
        );
        return;
      }

      const outcome = await this.databaseSink.deliver(
        bridge,
        [run.target],
        wrong.map((i) => shaped[i]!),
        undefined,
      );
      if (outcome.status !== 'success') {
        this.note(
          run,
          `Some rows could not be written: ${outcome.error ?? 'unknown error'}`,
        );
        return;
      }
      if (round === 0) run.result.fixed += wrong.length;
      pending = wrong.map((i) => pending[i]!);
    }
  }

  /** pass 2: rows the destination has and the source does not */
  private async findExtras(
    bridge: ResolvedBridge,
    run: TargetRun,
    sourceEngine: DatabaseEngine,
    opts: { moving: boolean; remove: boolean },
    beat: () => Promise<void>,
  ): Promise<void> {
    if (bridge.source.kind !== 'table') return;
    const src = bridge.source;
    const { target, result } = run;
    if (target.onDelete === 'ignore') {
      result.notes.push(
        'This target keeps rows that were deleted at the source, so rows that are only there were not looked for.',
      );
      return;
    }
    if (run.keyIsTransformed) {
      result.notes.push(
        'A key column is changed on the way (masked, cast or computed), so the source cannot be asked for a destination key: rows that are only in the destination were not looked for.',
      );
      return;
    }
    result.extra = 0;
    const soft = target.onDelete === 'soft' ? target.softDelete : undefined;
    const where = {
      connectionId: src.connectionId,
      database: src.database,
      schema: src.schema,
      table: src.table,
    };

    const settle = async (): Promise<void> => {
      if (run.extraSuspects.size === 0) return;
      let suspects = [...run.extraSuspects.values()];
      run.extraSuspects.clear();
      if (opts.moving) {
        await sleep(runtimeConfig.verifyRecheckMs);
        const [inSource, inTarget] = await Promise.all([
          this.sourceKeys(bridge, run, where, suspects, sourceEngine),
          this.fetchByKeys(
            {
              connectionId: target.connectionId,
              database: target.database,
              schema: target.schema,
              table: target.table,
            },
            target.keyColumns,
            suspects.map((s) => s.key),
            run.keyKinds,
            (row) => this.keyOf(run, row),
          ),
        ]);
        suspects = suspects.filter((s) => {
          const key = keyText(s.key, run.keyKinds);
          const still = inTarget.get(key);
          // arrived at the source meanwhile, left the destination meanwhile, or marked deleted meanwhile
          return (
            !inSource.has(key) &&
            !!still &&
            !(soft && isMarked(still[soft.column]))
          );
        });
      }
      if (suspects.length === 0) return;
      result.extra = (result.extra ?? 0) + suspects.length;
      for (const s of suspects)
        if (result.samples.extra.length < VERIFICATION_SAMPLES)
          result.samples.extra.push(s.key.map(show));
      if (opts.remove) {
        // spelled the SOURCE's way, as a delete from the change stream would be
        const rows = suspects.map((s) =>
          Object.fromEntries(run.sourceKeyColumns.map((c, i) => [c, s.key[i]])),
        );
        const outcome = await this.databaseSink.deliver(
          bridge,
          [target],
          rows,
          'delete',
        );
        if (outcome.status === 'success') result.removed += suspects.length;
        else
          this.note(
            run,
            `Some rows could not be removed: ${outcome.error ?? 'unknown error'}`,
          );
      }
    };

    // the destination table read the way a source table is: keyset or cursor where it can be
    let asSource: ResolvedBridge = { ...bridge, source: tableOf(target) };
    let order: TableOrder;
    try {
      order = await this.reader.resolveOrder(asSource);
    } catch {
      // no primary key there: ordered by the bridge's key columns instead
      asSource = {
        ...asSource,
        source: {
          ...tableOf(target),
          sort: target.keyColumns.map((column) => ({
            column,
            direction: 'asc' as const,
          })),
        },
      };
      order = await this.reader.resolveOrder(asSource);
    }

    let page: Row[] = [];
    const flush = async (): Promise<void> => {
      if (page.length === 0) return;
      const rows = page.filter((row) => !(soft && isMarked(row[soft.column])));
      page = [];
      if (rows.length > 0) {
        const candidates = rows.map((row) => ({ key: this.keyOf(run, row) }));
        const inSource = await this.sourceKeys(
          bridge,
          run,
          where,
          candidates,
          sourceEngine,
        );
        for (const c of candidates) {
          const key = keyText(c.key, run.keyKinds);
          if (!inSource.has(key)) run.extraSuspects.set(key, c);
        }
        if (run.extraSuspects.size >= RECHECK_BATCH) await settle();
      }
      await beat();
    };
    for await (const item of this.reader.rows(asSource, {
      startOffset: 0,
      resumeKey: null,
      order,
    })) {
      page.push(item.row);
      if (page.length >= bridge.delivery.pageSize) await flush();
    }
    await flush();
    await settle();
  }

  /**
   * which of these destination keys the source has, as the set of their key
   * texts. the source rows are put through the bridge (transforms, conversion,
   * mapping) so that the key compared is the key that would be WRITTEN
   */
  private async sourceKeys(
    bridge: ResolvedBridge,
    run: TargetRun,
    where: {
      connectionId: string;
      database?: string;
      schema?: string;
      table: string;
    },
    candidates: Array<{ key: unknown[] }>,
    sourceEngine: DatabaseEngine,
  ): Promise<Set<string>> {
    const filters =
      bridge.source.kind === 'table' ? bridge.source.filters : undefined;
    const found = await this.fetchByKeys(
      where,
      run.sourceKeyColumns,
      candidates.map((c) => c.key),
      run.keyKinds,
      (row) => run.sourceKeyColumns.map((c) => row[c]),
      { filters, engine: sourceEngine },
    );
    const rows = [...found.values()];
    if (rows.length === 0) return new Set();
    const shaped = shapeRows(bridge, rows, {
      table: where.table,
      now: new Date().toISOString(),
    }).rows;
    const expected = await this.databaseSink.expectedRows(
      bridge,
      run.target,
      shaped,
    );
    return new Set(
      expected.map((row) => keyText(this.keyOf(run, row), run.keyKinds)),
    );
  }

  /**
   * the rows of a table that have one of these keys, by key text. one `IN` per
   * key column narrows it down on the server (for a composite key that is a
   * superset), and the exact match is made here
   */
  private async fetchByKeys(
    where: {
      connectionId: string;
      database?: string;
      schema?: string;
      table: string;
    },
    keyColumns: string[],
    keys: unknown[][],
    kinds: CompareKind[],
    keyOf: (row: Row) => unknown[],
    opts: { filters?: FilterSpec[]; engine?: DatabaseEngine } = {},
  ): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const usable = keys.filter((key) =>
      key.every((v) => v !== null && v !== undefined),
    );
    if (usable.length === 0) return out;
    const wanted = new Set(usable.map((key) => keyText(key, kinds)));
    const filters: FilterSpec[] = [
      ...(opts.filters ?? []),
      ...keyColumns.map((column, i) => ({
        column,
        operator: 'in' as const,
        value: lookupValues(
          usable.map((key) => key[i]),
          opts.engine,
        ),
      })),
    ];
    const sort = keyColumns.map((column) => ({
      column,
      direction: 'asc' as const,
    }));
    for (let offset = 0; ; ) {
      const page = await this.pool.withAdapter(
        where.connectionId,
        where.database,
        (adapter) =>
          adapter.browse({
            schema: where.schema,
            table: where.table,
            filters,
            sort,
            limit: 1000,
            offset,
          }),
      );
      for (const row of page.rows) {
        const key = keyText(keyOf(row), kinds);
        if (wanted.has(key)) out.set(key, row);
      }
      if (!page.hasMore || page.rows.length === 0) break;
      offset += page.rows.length;
    }
    return out;
  }

  private note(run: TargetRun, text: string): void {
    if (run.result.notes.length < 10 && !run.result.notes.includes(text))
      run.result.notes.push(text);
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** a target's table, as something that can be READ like a source */
function tableOf(
  target: DatabaseTarget,
): Extract<ResolvedBridge['source'], { kind: 'table' }> {
  return {
    kind: 'table',
    connectionId: target.connectionId,
    database: target.database,
    schema: target.schema,
    table: target.table,
  };
}

/** has a soft delete marked this row? (a timestamp, or true) */
export function isMarked(value: unknown): boolean {
  return !(
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === '0' ||
    value === ''
  );
}

/** a value as it can be kept in a report and shown on a page: short, and plain JSON */
export function show(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === 'number' && !Number.isFinite(value))
    return String(value);
  if (typeof value === 'string')
    return value.length > 200
      ? `${value.slice(0, 200)}… (${value.length} characters)`
      : value;
  if (typeof value === 'object') {
    const text =
      JSON.stringify(value, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ) ?? '';
    return text.length > 200
      ? `${text.slice(0, 200)}… (${text.length} characters)`
      : (JSON.parse(text) as unknown);
  }
  return value;
}
