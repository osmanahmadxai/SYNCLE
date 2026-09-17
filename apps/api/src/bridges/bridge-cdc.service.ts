/**
 * event-based ("CDC") bridges, engine-agnostic orchestrator.
 *
 * each engine captures changes differently (Postgres logical replication, MySQL
 * binlog, MongoDB change streams, Redis keyspace notifications); that variation
 * lives behind the {@link CdcProvider} interface. this service is the shared
 * machinery around them: pick the provider for a connection's engine, manage the
 * job lifecycle (one resumable job per bridge), and runs the per-change pipeline
 * (dedupe replays, render, deliver, record, persist the cursor).
 *
 * a held streaming connection per active bridge lives in `streams`. durable
 * engines (pg/mysql/mongo) persist a cursor so a restart resumes exactly; Redis
 * is real-time only (see {@link RedisCdcProvider}).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  type CdcOperation,
  type CdcReadiness,
  type CdcReadinessDTO,
  type ConnectionConfig,
  type DatabaseEngine,
  type BridgeJob,
  type BridgeSourceHold,
  type PendingSourceCleanup,
  NotFoundError,
  columnsRead,
  UNCHANGED,
} from '@syncle/core';
import { randomUUID } from 'node:crypto';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { SshTunnelService, type SshTunnel } from '../connections/ssh-tunnel.service';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { BridgeSinkService } from './bridge-sink.service';
import type { DeliveryOutcome, ResolvedBridge } from './bridges.types';
import { previewBody } from './database-sink.service';
import { DeadLetterService, type NewDeadLetter } from './dead-letter.service';
import { isolateFailures } from './cdc/isolate-failures';
import {
  CDC_PROVIDERS,
  backoffMs,
  delay,
  type CdcChange,
  type CdcProvider,
  type CdcStreamHandle,
} from './cdc/cdc-provider';
import { rowMatchesFilters } from './cdc/filter-match';
import { AlertsService } from '../alerts/alerts.service';
import { SnapshotCdcProvider } from './cdc/snapshot-provider';
import { TableReaderService } from './table-reader.service';
import { SchemaDriftService, tracksSchema } from './schema-drift.service';
import { CdcSpoolService, type SpoolEntry, type SpooledItem } from './cdc/cdc-spool.service';

/** live runtime state for one active CDC stream */
interface Stream {
  handle: CdcStreamHandle;
  provider: CdcProvider;
  jobId: string;
  seq: number;
  /** highest cursor already processed, guards against replay dupes on reconnect */
  watermark: string | null;
  /**
   * per-bridge serialization chain: providers may emit concurrently (Redis fires
   * events fire-and-forget), but changes for one bridge must process strictly in
   * order or concurrent handlers would reuse the same sequence number
   */
  pending: Promise<void>;
  /** the source's primary-key columns, so rowKeys stores keys, not every value */
  primaryKey: string[] | null;
  /** changes accepted but not yet delivered; flushed as ONE delivery */
  buffer: Buffered[];
  /** the operation every buffered change shares; a different op forces a flush */
  bufferOp: CdcOperation | null;
  /** key signatures already in the buffer, so one batch never repeats a key */
  bufferKeys: Set<string>;
  /**
   * the furthest position the pending batch covers. normally its last row's,
   * but it runs ahead of that whenever the stream passes something that is not
   * delivered — a transaction marker, a filtered-out row. such a position may
   * only be confirmed to the source IN ORDER, once every row ahead of it has
   * landed, so it is not checkpointed on sight: it rides the batch, and the
   * batch's single checkpoint (taken after a successful delivery) covers it.
   */
  tailCursor: string | null;
  /** linger timer, so a partial batch still leaves promptly */
  timer: ReturnType<typeof setTimeout> | null;
  /** what the running timer is waiting to flush (see `scheduleFlush`) */
  timerFor: 'rows' | 'position' | null;
  /** rows per delivery for this bridge */
  maxBatch: number;
  /** rows the byte budget allows, from the first row of the current batch */
  byteCappedBatch: number | null;
  /** the delivery currently being written, if any (at most one) */
  inflight: Promise<void> | null;
  /** the resolved bridge, so a flush needs no extra arguments */
  bridge: ResolvedBridge;
  /** changes go through the durable spool instead of straight to the sink */
  spooled: boolean;
  /** set to stop the spool consumer loop */
  consumerStop: boolean;
  /** the running consumer, awaited on teardown so it exits cleanly */
  consumer: Promise<void> | null;
  /**
   * set the instant a failure stops the bridge. the actual teardown runs a tick
   * later (it has to happen outside the change chain), and in that gap a flush
   * already waiting on `inflight` would wake up first, deliver the NEXT batch
   * and checkpoint past the one that just failed. everything that delivers or
   * advances checks this flag, so nothing moves once it is set.
   */
  halted: boolean;
  /** batches in a row that delivered nothing, to spot a dead destination */
  consecutiveFailures: number;
  /** how this stream reaches its source; closed with it */
  route: Route;
  /**
   * does a destination store the row as ONE value (a key-value store)? such a
   * write cannot "leave a column alone". resolved on first need; see
   * `completeRow`
   */
  wholeValueTarget: boolean | null;
  /** the column names of the last row that was not a delete: when they change, the table has */
  columnSignature: string | null;
}

/** one change held in the pending batch */
interface Buffered {
  change: CdcChange;
  row: Record<string, unknown>;
  /** identity of the row within this batch, or null when there is no key */
  keySig: string | null;
}

type Row = Record<string, unknown>;

/** what is needed of a job row to bring its stream back up */
interface ResumableJob {
  bridgeId: string;
  id: string;
  cursorOffset: number;
  cursorJson: string | null;
}

/**
 * how a change stream reaches its source: directly, or through an SSH tunnel.
 *
 * providers open their OWN connections (a replication connection, a binlog
 * client, a change stream, a subscriber), and they used to dial the
 * connection's host as written — ignoring its SSH tunnel altogether. behind a
 * bastion that host is unreachable, so CDC simply could not be used with a
 * tunnelled connection, while the workbench and replays (which go through the
 * adapter pool, which does tunnel) worked fine on the very same connection.
 *
 * the tunnel here belongs to the stream: opened before anything talks to the
 * source, closed when the stream is torn down.
 */
interface Route {
  /** the connection to hand to a provider: rerouted through the tunnel, if any */
  conn: ConnectionConfig;
  tunnel: SshTunnel | undefined;
  close(): Promise<void>;
}

/** dead-letter entries are chunked so no single stored row is enormous */
const DEAD_LETTER_CHUNK = 500;
/** poison-row isolation limits (see isolate-failures.ts) */
const ISOLATION = { maxAttempts: 128, maxPoisoned: 100, failuresBeforeSystemic: 14 } as const;
/** attempts at the metadata-store writes that follow a delivery */
const SETTLE_ATTEMPTS = 3;
/**
 * how long a batch holding only a position (nothing to deliver) may wait. a
 * busy database emits a BEGIN/COMMIT pair per transaction even when none touch
 * the bridge's table; checkpointing each one would be a metadata-store write
 * per transaction on the source. once a second keeps the slot moving at a
 * negligible cost.
 */
const POSITION_LINGER_MS = 1_000;

/** read the persisted resume cursor from a job's cursorJson (legacy `lsn` ok) */
function readCursor(cursorJson: string | null): string | null {
  return readCursorState(cursorJson).cursor;
}

/**
 * a job's saved position, and whether it still means anything. `lost` is set
 * (to the explanation) once the source has said it can no longer serve that
 * position; from then on the bridge only starts when told to continue from now
 */
function readCursorState(cursorJson: string | null): {
  cursor: string | null;
  lost: string | null;
  /**
   * this bridge has no position, and is NOT to copy its table to get one: it
   * was told to continue "from now" after losing its place. without the mark, a
   * bridge that starts from the `beginning` would answer "continue from now" by
   * re-reading a table of any size
   */
  noCopy: boolean;
} {
  if (!cursorJson) return { cursor: null, lost: null, noCopy: false };
  try {
    const o = JSON.parse(cursorJson) as { cursor?: string; lsn?: string; lost?: string; copy?: string };
    return {
      cursor: o.cursor ?? o.lsn ?? null,
      lost: typeof o.lost === 'string' && o.lost ? o.lost : null,
      noCopy: o.copy === 'skip',
    };
  } catch {
    return { cursor: null, lost: null, noCopy: false };
  }
}

/** does this start copy the table first? only a bridge with no position at all does */
function copiesFirst(bridge: ResolvedBridge, cursorJson: string | null): boolean {
  if (bridge.trigger.kind !== 'cdc' || bridge.trigger.startFrom !== 'beginning') return false;
  const state = readCursorState(cursorJson);
  return state.cursor === null && !state.noCopy;
}

/** 1536 -> "1.5 KB"; whole numbers stay whole */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

const GAP_ADVICE =
  'Changes made at the source between that position and now can no longer be read. ' +
  'Start the bridge again and choose to continue from now, then run a replay to bring the destination up to date.';

@Injectable()
export class BridgeCdcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BridgeCdc');
  private readonly streams = new Map<string, Stream>();
  private readonly providers = new Map<DatabaseEngine, CdcProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly connStore: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly jobs: BridgeJobService,
    private readonly spool: CdcSpoolService,
    private readonly deadLetters: DeadLetterService,
    private readonly tunnels: SshTunnelService,
    private readonly reader: TableReaderService,
    private readonly alerts: AlertsService,
    private readonly drift: SchemaDriftService,
    @Inject(CDC_PROVIDERS) providers: CdcProvider[],
  ) {
    // every engine's provider is handed out inside the wrapper that can copy a
    // table before following it. it is transparent until a bridge asks for that
    for (const p of providers) {
      this.providers.set(
        p.engine,
        new SnapshotCdcProvider(p, this.reader, {
          holdMax: runtimeConfig.snapshotHoldMax,
          log: (message) => this.logger.log(message),
        }),
      );
    }
  }

  private providerFor(engine: DatabaseEngine): CdcProvider | null {
    return this.providers.get(engine) ?? null;
  }

  /** open the way to a source. the caller owns the result and must close it */
  private async openRoute(conn: ConnectionConfig): Promise<Route> {
    const tunnel = await this.tunnels.openFor(conn);
    // first tunnel for this connection: pin the jump host's key, exactly as the
    // adapter pool does, so a different key is refused from now on
    if (tunnel?.hostKey && !conn.ssh?.hostKey?.trim()) {
      await this.connStore.pinSshHostKey(conn.id, tunnel.hostKey).catch(() => undefined);
    }
    return {
      conn: this.tunnels.reroute(conn, tunnel),
      tunnel,
      close: async () => {
        await tunnel?.close().catch(() => undefined);
      },
    };
  }

  /** reach a source for the length of one call */
  private async viaRoute<T>(conn: ConnectionConfig, fn: (routed: ConnectionConfig) => Promise<T>): Promise<T> {
    const route = await this.openRoute(conn);
    try {
      return await fn(route.conn);
    } catch (err) {
      // a refused forward reaches the provider as a bare socket reset; the
      // tunnel knows the real story
      throw route.tunnel?.takeError() ?? err;
    } finally {
      await route.close();
    }
  }

  /* ----- readiness, drives the builder's setup panel ----- */

  async readiness(dto: CdcReadinessDTO): Promise<CdcReadiness> {
    const conn = await this.connStore.resolve(dto.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      return {
        engine: conn.engine,
        supported: false,
        ready: false,
        checks: [],
        instructions: [
          `Event-based (CDC) delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
        ],
      };
    }
    // some providers probe with a connection of their own (Redis, MongoDB), and
    // that one needs the tunnel as much as the stream will
    return this.viaRoute(conn, (routed) => provider.readiness(dto, routed)).catch(
      (err): CdcReadiness => ({
        engine: conn.engine,
        supported: true,
        ready: false,
        checks: [{ label: 'reach the database', ok: false, detail: (err as Error).message }],
        instructions: ['Could not reach the database to check readiness.'],
      }),
    );
  }

  /* ----- start / stop ----- */

  async start(bridgeId: string, opts: { fromNow?: boolean; recopy?: boolean } = {}): Promise<BridgeJob> {
    const bridge = await this.store.resolve(bridgeId);
    if (bridge.trigger.kind !== 'cdc') {
      throw new BadRequestError('This bridge is not configured for event-based delivery.');
    }
    if (bridge.source.kind !== 'table') {
      throw new BadRequestError('Event-based bridges must read from a table.');
    }
    const conn = await this.connStore.resolve(bridge.source.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      throw new BadRequestError(
        `Event-based delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
      );
    }

    if (bridge.trigger.operations.includes('truncate') && !provider.capturesTruncate) {
      throw new BadRequestError(
        `${conn.engine} does not report a TRUNCATE as a change, so this bridge would never see one. ` +
          'Remove "truncate" from its operations (it is available for PostgreSQL sources).',
      );
    }

    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) throw new ConflictError('This bridge is already running. Stop it first.');

    // from here on the source is being talked to: through the connection's SSH
    // tunnel if it has one, opened once and kept for the stream
    const route = await this.openRoute(conn);
    try {
      return await this.startVia(route, bridgeId, bridge, provider, opts);
    } catch (err) {
      // a stream that got as far as registering itself owns the route; one that
      // did not leaves it to us
      if (this.streams.get(bridgeId)?.route !== route) await route.close();
      throw route.tunnel?.takeError() ?? err;
    }
  }

  private async startVia(
    route: Route,
    bridgeId: string,
    bridge: ResolvedBridge,
    provider: CdcProvider,
    opts: { fromNow?: boolean; recopy?: boolean },
  ): Promise<BridgeJob> {
    if (bridge.source.kind !== 'table') throw new BadRequestError('Event-based bridges must read from a table.');
    const conn = route.conn;

    const ready = await provider.readiness(
      {
        connectionId: bridge.source.connectionId,
        database: bridge.source.database,
        schema: bridge.source.schema,
        table: bridge.source.table,
        bridgeId,
        slot: bridge.trigger.kind === 'cdc' ? bridge.trigger.slot : undefined,
      },
      conn,
    );
    if (!ready.ready) {
      throw new BadRequestError(
        `${conn.engine} isn't ready for event-based delivery. ${ready.instructions.join(' ')}`,
      );
    }

    // one job per bridge: resume the existing (paused) job in place rather than
    // spawning a new one. durable engines keep their cursor so it continues cleanly
    let latest = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
    });

    // is the place this bridge stopped at still there? a slot that was dropped
    // (or that the server invalidated) used to be re-created on the spot, and
    // the bridge carried on from "now" as if nothing had happened
    const gap = await this.positionLost(bridgeId, bridge, conn, provider, latest?.cursorJson ?? null);
    if (gap) {
      if (!opts.fromNow) {
        throw new BadRequestError(`This bridge cannot resume where it stopped: ${gap} ${GAP_ADVICE}`, {
          reason: 'position-lost',
        });
      }
      // whatever is left of the old position has to go before a new one can
      // take its name. this one is allowed to fail the start: carrying on with
      // an invalidated slot in place cannot work
      await provider.deprovision(bridgeId, bridge, conn);
      // "from now" means from now. a bridge that copies its table before it
      // follows it does that again only when asked to in so many words
      const recopy = opts.recopy === true && bridge.trigger.kind === 'cdc' && bridge.trigger.startFrom === 'beginning';
      if (latest) {
        const seq = latest.cursorOffset;
        await this.jobs.recordNotice(
          latest.id,
          seq,
          `Continued from the current position on ${new Date().toISOString()}: ${gap} ` +
            (recopy
              ? 'The table is being copied again, which brings every row that still exists up to date. Rows DELETED at the source in the meantime are still at the destination.'
              : 'Changes made at the source before this point and after the previous delivery were NOT captured. Run a replay to bring the destination up to date.'),
        );
        latest = await this.prisma.bridgeJob.update({
          where: { id: latest.id },
          data: { cursorJson: recopy ? null : JSON.stringify({ copy: 'skip' }), cursorOffset: seq + 1 },
        });
      }
      this.logger.warn(
        `CDC ${bridgeId}: continuing from now${recopy ? ', copying the table again' : ', accepting a gap'} (${gap})`,
      );
    }

    // is the table still the one this bridge was built for?
    const verdict = await this.drift.check(bridge);
    if (verdict.stop) throw new BadRequestError(verdict.stop, { reason: 'schema-drift' });

    await provider.provision(bridgeId, bridge, conn, (id) => this.connStore.resolve(id));

    const job = latest
      ? await this.prisma.bridgeJob.update({
          where: { id: latest.id },
          data: { status: 'running', error: null, finishedAt: null },
        })
      : await this.prisma.bridgeJob.create({
          data: {
            id: randomUUID(),
            bridgeId,
            status: 'running',
            configSnapshotJson: await this.store.snapshotJson(bridgeId),
            cursorOffset: 0,
            totalCount: null,
          },
        });

    const copies = copiesFirst(bridge, job.cursorJson);
    await this.beginStream(bridgeId, bridge, route, provider, job.id, job.cursorOffset, job.cursorJson);
    this.logger.log(
      `${copies ? 'Copying the table, then streaming' : 'Streaming'} changes for bridge ${bridgeId} (job ${job.id}, ${conn.engine}${route.tunnel ? ', through its SSH tunnel' : ''})`,
    );
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** pause: stop the live stream but keep durable state so a resume continues */
  async stop(bridgeId: string): Promise<BridgeJob | null> {
    await this.teardown(bridgeId);
    const job = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!job) return null;
    await this.jobs.finalize(job.id, 'paused');
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** full teardown when a bridge is deleted: stop stream and drop provider state */
  async cleanup(bridgeId: string): Promise<void> {
    await this.teardown(bridgeId);
    let bridge: ResolvedBridge;
    try {
      bridge = await this.store.resolve(bridgeId);
    } catch {
      await this.dropSpool(bridgeId);
      return; // bridge already gone, nothing to deprovision
    }
    await this.releaseSource(bridgeId, bridge);
    await this.dropSpool(bridgeId);
  }

  /**
   * the bridge's spool stream in Redis. `CdcSpoolService.clear` existed and was
   * never called, so every deleted spooled bridge left its stream — and whatever
   * undelivered rows were in it — behind for good
   */
  private async dropSpool(bridgeId: string): Promise<void> {
    await this.spool.clear(bridgeId).catch((err) => {
      this.logger.warn(`CDC ${bridgeId}: could not clear its spool: ${(err as Error).message}`);
    });
  }

  /**
   * a bridge stops being a CDC bridge on this source: its trigger changed, or
   * it now reads from another connection or database. `before` is the bridge AS
   * IT WAS — what it created is on the OLD source, and nothing else will ever
   * look there again. this used to be skipped entirely: every such edit left a
   * replication slot behind, pinning WAL with no bridge pointing at it.
   */
  async abandon(bridgeId: string, before: ResolvedBridge, opts: { gapNotice?: string } = {}): Promise<void> {
    await this.teardown(bridgeId);
    await this.releaseSource(bridgeId, before);
    // rows spooled from the OLD source but not yet delivered belong to a
    // configuration that no longer exists; the new one must not inherit them
    await this.dropSpool(bridgeId);
    // the saved position belonged to what was just released
    const latest = await this.prisma.bridgeJob.findFirst({ where: { bridgeId }, orderBy: { startedAt: 'desc' } }).catch(() => null);
    // the SAME table goes on being read, from a new place: what changed at the
    // source between the last delivery and that place is not captured, and the
    // timeline is where that is said (a moved source has no such gap to speak of)
    if (latest && opts.gapNotice && readCursor(latest.cursorJson)) {
      await this.jobs.recordNotice(latest.id, latest.cursorOffset, opts.gapNotice).catch(() => undefined);
      await this.prisma.bridgeJob.update({ where: { id: latest.id }, data: { cursorOffset: latest.cursorOffset + 1 } }).catch(() => undefined);
    }
    await this.prisma.bridgeJob
      .updateMany({ where: { bridgeId }, data: { cursorJson: null } })
      .catch(() => undefined);
  }

  /**
   * remove what `provision` created on the source. when that fails — the server
   * is unreachable, a dying connection still holds the slot — it is written
   * down and retried (see `retryCleanups`), because after a delete that record
   * is the only thing left that knows the slot's name. true = nothing is left.
   */
  async releaseSource(bridgeId: string, bridge: ResolvedBridge): Promise<boolean> {
    if (bridge.source.kind !== 'table') return true;
    const src = bridge.source;
    let engine: DatabaseEngine | null = null;
    try {
      const conn = await this.connStore.resolve(src.connectionId);
      engine = conn.engine;
      const provider = this.providerFor(conn.engine);
      if (!provider) return true;
      await provider.deprovision(bridgeId, bridge, conn);
      await this.prisma.sourceCleanup
        .deleteMany({ where: { bridgeId, connectionId: src.connectionId } })
        .catch(() => undefined);
      return true;
    } catch (err) {
      const message = (err as Error).message;
      if (engine === null) {
        // the connection itself is gone: there is no way left to reach the source
        this.logger.error(`CDC ${bridgeId}: could not release the source, its connection cannot be resolved: ${message}`);
        return false;
      }
      // only PostgreSQL leaves anything behind on the source
      if (engine !== 'postgres') return true;
      const slot = `syncle_slot_${bridgeId.replace(/-/g, '')}`;
      this.logger.error(
        `CDC ${bridgeId}: could not release the source, will retry: ${message}. ` +
          `Until it succeeds the slot pins WAL there; to remove it by hand: SELECT pg_drop_replication_slot('${slot}');`,
      );
      await this.prisma.sourceCleanup
        .upsert({
          where: { bridgeId_connectionId: { bridgeId, connectionId: src.connectionId } },
          create: {
            id: randomUUID(),
            bridgeId,
            bridgeName: bridge.name,
            connectionId: src.connectionId,
            database: src.database ?? null,
            engine,
            resource: `replication slot ${slot}`,
            attempts: 1,
            lastError: message,
          },
          update: { attempts: { increment: 1 }, lastError: message },
        })
        .catch(() => undefined);
      return false;
    }
  }

  async listCleanups(): Promise<PendingSourceCleanup[]> {
    const rows = await this.prisma.sourceCleanup.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      bridgeId: r.bridgeId,
      bridgeName: r.bridgeName,
      connectionId: r.connectionId,
      database: r.database,
      engine: r.engine,
      resource: r.resource,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async dismissCleanup(id: string): Promise<void> {
    const found = await this.prisma.sourceCleanup.deleteMany({ where: { id } });
    if (found.count === 0) throw new NotFoundError('No such pending cleanup.');
  }

  /** try again to remove what could not be removed before. returns how many are left */
  async retryCleanups(): Promise<number> {
    const tasks = await this.prisma.sourceCleanup.findMany({ orderBy: { createdAt: 'asc' } });
    let left = 0;
    for (const task of tasks) {
      // the bridge may be live again on this very source (deleted-then-recreated
      // ids do not happen, but an `abandon` followed by an edit back does): its
      // slot is in use, not left over
      if (this.streams.has(task.bridgeId)) {
        const current = await this.store.resolve(task.bridgeId).catch(() => null);
        if (current?.source.kind === 'table' && current.source.connectionId === task.connectionId) {
          await this.prisma.sourceCleanup.delete({ where: { id: task.id } }).catch(() => undefined);
          continue;
        }
      }
      const stub = {
        id: task.bridgeId,
        name: task.bridgeName ?? task.bridgeId,
        source: { kind: 'table', connectionId: task.connectionId, database: task.database ?? undefined, table: '' },
        trigger: { kind: 'cdc', operations: [] },
      } as unknown as ResolvedBridge;
      if (!(await this.releaseSource(task.bridgeId, stub))) left++;
    }
    return left;
  }

  /**
   * what this bridge is holding on its source, judged: is it fine, worth a
   * warning, or about to hurt someone. null = nothing is held (the bridge was
   * never started, or the engine keeps nothing per reader).
   */
  async hold(bridgeId: string): Promise<BridgeSourceHold | null> {
    const bridge = await this.store.resolve(bridgeId);
    if (bridge.trigger.kind !== 'cdc' || bridge.source.kind !== 'table') return null;
    const conn = await this.connStore.resolve(bridge.source.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider?.inspect) return null;

    const job = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
      select: { cursorJson: true },
    });
    const state = readCursorState(job?.cursorJson ?? null);
    const running = this.streams.has(bridgeId);
    const found = await provider.inspect(bridgeId, bridge, conn, state.cursor);
    if (!found) return null;
    // never started: a slot that does not exist yet is not a slot that was lost
    if (!found.exists && !state.cursor && !state.lost && !running) return null;

    const held = found.retainedBytes ?? 0;
    const size = formatBytes(held);
    let level: BridgeSourceHold['level'] = 'ok';
    let message: string | null = null;
    if (!found.exists || found.status === 'lost' || state.lost) {
      level = 'critical';
      message = `${state.lost ?? found.detail ?? 'The bridge’s place in the source’s change log is gone.'} ${state.lost ? '' : GAP_ADVICE}`.trim();
    } else if (found.status === 'at-risk') {
      level = 'critical';
      message = `${found.detail ?? 'The source is about to discard changes this bridge has not read.'} Start the bridge now to let it catch up.`;
    } else if (found.limitBytes !== null && found.limitBytes > 0 && held >= found.limitBytes * 0.8) {
      level = 'critical';
      message =
        `The source is keeping ${size} of WAL for this bridge, and gives the slot up at ${formatBytes(found.limitBytes)} (max_slot_wal_keep_size). ` +
        (running ? 'The bridge is running but behind.' : 'The bridge is not running, so this only grows: start it.');
    } else if (runtimeConfig.slotWarnBytes > 0 && held >= runtimeConfig.slotWarnBytes) {
      level = 'warn';
      message =
        `The source is keeping ${size} of WAL for this bridge. ` +
        (running
          ? 'The bridge is running but behind; the amount falls as it catches up.'
          : 'The bridge is not running, so this only grows — and nothing on the source limits it' +
            (found.limitBytes === null ? '' : ` below ${formatBytes(found.limitBytes)}`) +
            '. Start the bridge, or delete it to release the slot.');
    }
    return { ...found, level, message, running, checkedAt: new Date().toISOString() };
  }

  /**
   * give up a STOPPED bridge's replication slot because of what it is costing
   * the source. the job is marked so that the next start has to accept the gap
   * in so many words. false = the bridge turned out to be running, or the slot
   * could not be dropped.
   */
  async surrenderSlot(bridgeId: string, reason: string): Promise<boolean> {
    if (this.streams.has(bridgeId)) return false;
    const bridge = await this.store.resolve(bridgeId);
    const job = await this.prisma.bridgeJob.findFirst({ where: { bridgeId }, orderBy: { startedAt: 'desc' } });
    if (job && ['running', 'queued', 'canceling'].includes(job.status)) return false;
    if (!(await this.releaseSource(bridgeId, bridge))) return false;
    const lost = `${reason} ${GAP_ADVICE}`;
    if (job) {
      await this.prisma.bridgeJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          error: lost,
          finishedAt: job.finishedAt ?? new Date(),
          cursorJson: JSON.stringify({ cursor: readCursor(job.cursorJson), lost }),
        },
      });
      this.alertPositionLost(job.id, lost);
    }
    this.logger.warn(`CDC ${bridgeId}: ${lost}`);
    return true;
  }

  /** for the two places that mark a job as having lost its position without going through `finalize` */
  private alertPositionLost(jobId: string, message: string): void {
    this.alerts.emitForJob(jobId, {
      type: 'bridge.position_lost',
      severity: 'critical',
      title: (name) => `Bridge "${name}" lost its place in the source's change log`,
      message,
    });
  }

  /** the saved position is gone: why, or null when the bridge can resume */
  private async positionLost(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
    provider: CdcProvider,
    cursorJson: string | null,
  ): Promise<string | null> {
    const state = readCursorState(cursorJson);
    if (state.lost) return state.lost;
    if (!state.cursor || !provider.inspect) return null;
    try {
      const found = await provider.inspect(bridgeId, bridge, conn, state.cursor);
      if (found && (!found.exists || found.status === 'lost')) {
        return `${found.detail ?? 'its place in the source’s change log is gone'}.`;
      }
    } catch {
      /* could not look: the stream itself will say if something is wrong */
    }
    return null;
  }

  /** set on shutdown, so a reconnect loop does not outlive the process's services */
  private destroyed = false;

  /** close every streaming connection on shutdown, no zombie streamers */
  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const bridgeId of [...this.streams.keys()]) {
      await this.teardown(bridgeId);
    }
  }

  private async teardown(bridgeId: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return;
    // let the in-flight chain settle so a half-built batch is not abandoned
    // mid-flush, then drop the entry so nothing new is accepted
    await stream.pending.catch(() => undefined);
    this.streams.delete(bridgeId);
    if (stream.timer) clearTimeout(stream.timer);
    stream.consumerStop = true;
    await stream.consumer?.catch(() => undefined);
    // a delivery may still be writing; let it finish so its checkpoint lands
    await stream.inflight?.catch(() => undefined);
    // whatever is still buffered is simply dropped. it was never checkpointed
    // or acked, so the source hands it over again on the next start — and a
    // stream that is no longer registered must not deliver anything
    await stream.handle.stop().catch(() => undefined);
    await stream.route.close();
  }

  /* ----- the shared change pipeline ----- */

  private async beginStream(
    bridgeId: string,
    bridge: ResolvedBridge,
    route: Route,
    provider: CdcProvider,
    jobId: string,
    startSeq: number,
    cursorJson: string | null,
  ): Promise<void> {
    const startCursor = readCursor(cursorJson);
    // two live streams for one bridge would double-deliver every change
    if (this.streams.has(bridgeId)) {
      throw new ConflictError('This bridge already has a live stream. Stop it first.');
    }
    const stream: Stream = {
      handle: { stop: async () => undefined },
      provider,
      jobId,
      seq: startSeq,
      watermark: startCursor,
      pending: Promise.resolve(),
      primaryKey: await this.resolvePrimaryKey(bridge),
      buffer: [],
      bufferOp: null,
      bufferKeys: new Set(),
      tailCursor: null,
      timer: null,
      timerFor: null,
      // a database destination may batch freely: writes are idempotent upserts
      // keyed by column, so N-at-once is indistinguishable from N one-at-a-time.
      // an HTTP destination must keep delivery.batchSize, because there the
      // batch size IS the payload the receiver sees.
      maxBatch:
        bridge.destination.kind === 'database'
          ? Math.max(1, runtimeConfig.cdcBatchSize)
          : Math.max(1, bridge.delivery.batchSize),
      bridge,
      byteCappedBatch: null,
      inflight: null,
      spooled: runtimeConfig.cdcSpool,
      consumerStop: false,
      consumer: null,
      halted: false,
      consecutiveFailures: 0,
      wholeValueTarget: null,
      columnSignature: null,
      route,
    };
    this.streams.set(bridgeId, stream);
    // the SSH connection can drop on its own (a bastion restart, an idle
    // timeout). the provider would then retry a local port nobody listens on,
    // for ever: the stream has to be given a new tunnel
    route.tunnel?.onClose(() => void this.rerouteStream(bridgeId, stream));

    let handle: CdcStreamHandle;
    try {
      handle = await provider.startStream({
        bridgeId,
        bridge,
        conn: route.conn,
        fromCursor: startCursor,
        snapshot: copiesFirst(bridge, cursorJson),
        handlers: {
          onChange: (change) => this.handleChange(bridgeId, bridge, change),
          onSkip: (cursor) => this.handleSkip(bridgeId, cursor),
          onNotice: (message, cursor) => this.handleNotice(bridgeId, message, cursor),
          onPositionLost: (message) => this.handlePositionLost(bridgeId, message),
          onFatal: (message) => this.handleFatal(bridgeId, message),
          onError: (err) => this.logger.warn(`CDC stream error for ${bridgeId}: ${err.message}`),
        },
      });
    } catch (err) {
      // a failed start must not strand the job as 'running' behind a dead
      // placeholder (that would be a permanent ConflictError on retry)
      if (this.streams.get(bridgeId) === stream) this.streams.delete(bridgeId);
      await route.close();
      // a refused forward reaches the provider as a bare socket reset
      const cause = route.tunnel?.takeError() ?? (err as Error);
      await this.jobs.finalize(jobId, 'failed', cause.message).catch(() => undefined);
      throw cause;
    }
    // stop() may have raced us during startStream: it removed the entry and
    // "stopped" the placeholder, so close the real handle instead of leaking it
    if (this.streams.get(bridgeId) !== stream) {
      await handle.stop().catch(() => undefined);
      return;
    }
    // the provider may have already begun emitting, only replace the placeholder
    stream.handle = handle;
    // the spool consumer runs alongside the reader, draining to the destination
    if (stream.spooled) this.startConsumer(bridgeId, stream);
  }

  /** the source's primary-key columns (best-effort), cached on the stream */
  private async resolvePrimaryKey(bridge: ResolvedBridge): Promise<string[] | null> {
    if (bridge.source.kind !== 'table') return null;
    const src = bridge.source;
    try {
      const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a.browse({ schema: src.schema, table: src.table, limit: 1, offset: 0 }),
      );
      return page.primaryKey.length ? page.primaryKey : null;
    } catch {
      return null; // unknown, deliveries fall back to null rowKeys
    }
  }

  /**
   * providers may emit concurrently (Redis resolves values out-of-band), so
   * changes for one bridge are queued onto the stream's promise chain and
   * processed strictly in order. returning the chain tail keeps backpressure
   * intact for providers that await onChange.
   */
  private handleChange(bridgeId: string, bridge: ResolvedBridge, change: CdcChange): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(() => this.accept(bridgeId, bridge, stream, change))
      .catch((err) => {
        // accept() handles its own failures; this only guards the chain
        this.logger.error(`CDC change chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /** a position passed without delivering anything; ordered like any change */
  private handleSkip(bridgeId: string, cursor: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(() => this.notePosition(bridgeId, stream, cursor))
      .catch((err) => {
        this.logger.error(`CDC skip chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /**
   * something happened at the source that was deliberately not applied (a
   * TRUNCATE on a bridge that does not mirror them). it goes on the timeline IN
   * ORDER — after everything read before it has been delivered — as a skipped
   * cell carrying the explanation, and the stream then moves past it.
   */
  private handleNotice(bridgeId: string, message: string, cursor: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(async () => {
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        // an event, so it is deduplicated the way a change is: against what has
        // been durably processed, not against what is merely buffered
        if (!stream.provider.cursorAfter(cursor, stream.watermark)) return;
        await this.flush(bridgeId, stream);
        if (stream.inflight) await stream.inflight.catch(() => undefined);
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        this.logger.warn(`CDC ${bridgeId}: ${message}`);
        if (stream.spooled) {
          // the consumer owns the sequence numbers here, so the notice queues up
          // behind the changes already spooled and is recorded when reached
          await this.spoolBatch(bridgeId, stream, [{ op: 'notice', row: { message }, cursor }], cursor);
          return;
        }
        await this.settle(bridgeId, stream, async () => {
          const seq = stream.seq;
          await this.jobs.recordNotice(stream.jobId, seq, message);
          await this.checkpoint(stream, seq + 1, cursor);
        });
      })
      .catch((err) => {
        this.logger.error(`CDC notice chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /**
   * Postgres leaves a large (TOASTed) column out of an UPDATE that did not
   * touch it, and the row arrives with UNCHANGED in its place.
   *
   * For a table-shaped destination that is all that is needed: the column is
   * left out of the upsert, and the destination keeps the copy it has. But some
   * things need the VALUE, and leaving it out is wrong for them:
   *
   *  - a source filter on that column cannot be evaluated without it
   *  - an HTTP payload would go out with the column missing
   *  - a key-value destination stores the row as one value: a write without the
   *    column REPLACES a value that had it
   *  - a row that moved to a new key has no earlier copy at the destination to
   *    keep anything from
   *
   * For those, the row is read back from the source by its key and the missing
   * columns are filled in from it. That is the row as it is NOW, which may be a
   * moment newer than this change — the changes in between are still on their
   * way and will write the same values again, so the destination converges.
   *
   * Returns the row to carry on with, or null when the read kept failing and
   * the bridge was stopped (the cursor has not moved, so nothing is lost).
   */
  private async completeRow(
    bridgeId: string,
    bridge: ResolvedBridge,
    stream: Stream,
    change: CdcChange,
  ): Promise<Row | null> {
    const row = change.row;
    if (bridge.source.kind !== 'table') return row;
    const src = bridge.source;
    const missing = Object.keys(row).filter((c) => row[c] === UNCHANGED);

    const needed =
      change.keyChanged === true ||
      bridge.destination.kind === 'http' ||
      (src.filters ?? []).some((f) => missing.includes(f.column)) ||
      // a mask, a cast or a computed column cannot work from "not sent"
      [...columnsRead(bridge.transform.columns)].some((c) => missing.includes(c)) ||
      (await this.hasWholeValueTarget(bridge, stream));
    if (!needed) return row;

    // without the missing columns, an HTTP payload simply does not have them —
    // better than the text of a marker. tables ignore them either way
    const without = (): Row =>
      bridge.destination.kind === 'http'
        ? Object.fromEntries(Object.entries(row).filter(([, v]) => v !== UNCHANGED))
        : row;

    const key = stream.primaryKey;
    if (!key?.length || key.some((c) => row[c] === undefined || row[c] === null || row[c] === UNCHANGED)) {
      return without();
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            filters: key.map((column) => ({ column, operator: 'eq' as const, value: row[column] })),
            limit: 1,
            offset: 0,
          }),
        );
        const current = page.rows[0];
        // gone since: its delete is further along the stream
        if (!current) return without();
        const filled: Row = { ...row };
        for (const column of missing) {
          if (column in current) filled[column] = current[column];
        }
        return bridge.destination.kind === 'http'
          ? Object.fromEntries(Object.entries(filled).filter(([, v]) => v !== UNCHANGED))
          : filled;
      } catch (err) {
        if (this.streams.get(bridgeId) !== stream || stream.halted) return null;
        if (attempt >= 2) {
          await this.halt(
            bridgeId,
            stream,
            'failed',
            `Could not read a row back from the source to complete a change, stopped without advancing the cursor so nothing is lost: ${(err as Error).message}`,
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }
  }

  /** is any database target a store that holds a row as one value? */
  private async hasWholeValueTarget(bridge: ResolvedBridge, stream: Stream): Promise<boolean> {
    if (stream.wholeValueTarget !== null) return stream.wholeValueTarget;
    let found = false;
    if (bridge.destination.kind === 'database') {
      for (const target of bridge.destination.targets) {
        try {
          const conn = await this.connStore.resolve(target.connectionId);
          if (conn.engine === 'redis') found = true;
        } catch {
          found = true; // unknown: the complete row is the safe assumption
        }
      }
    }
    stream.wholeValueTarget = found;
    return found;
  }

  /**
   * the source can no longer serve the position this stream was reading from.
   * what was read before that is real and is delivered; then the bridge stops,
   * marked so that it only starts again when told to continue from now.
   */
  /**
   * the stream cannot go on (the table could not be read, however often it was
   * tried). ordered behind everything already read, so that what was read is
   * delivered and checkpointed first; then the bridge stops, where it is
   */
  private handleFatal(bridgeId: string, message: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(async () => {
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        await this.flush(bridgeId, stream);
        if (stream.inflight) await stream.inflight.catch(() => undefined);
        await this.halt(bridgeId, stream, 'failed', message);
      })
      .catch((err) => {
        this.logger.error(`CDC fatal chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  private handlePositionLost(bridgeId: string, message: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(async () => {
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        await this.flush(bridgeId, stream);
        if (stream.inflight) await stream.inflight.catch(() => undefined);
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        const lost = `${message} ${GAP_ADVICE}`;
        await this.prisma.bridgeJob
          .update({
            where: { id: stream.jobId },
            data: { cursorJson: JSON.stringify({ cursor: stream.watermark, lost }) },
          })
          .catch(() => undefined);
        await this.halt(bridgeId, stream, 'failed', lost, 'bridge.position_lost');
      })
      .catch((err) => {
        this.logger.error(`CDC position-lost chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /** extend the pending batch's reach to `cursor` without adding a row */
  private notePosition(bridgeId: string, stream: Stream, cursor: string): void {
    if (this.streams.get(bridgeId) !== stream || stream.halted) return;
    // replays after a reconnect re-send positions we are already past
    if (!stream.provider.cursorAfter(cursor, stream.tailCursor ?? stream.watermark)) return;
    stream.tailCursor = cursor;
    this.scheduleFlush(bridgeId, stream);
  }

  /** identity of a row within a batch, or null when the source has no key */
  private keySignature(stream: Stream, row: Record<string, unknown>): string | null {
    if (!stream.primaryKey?.length) return null;
    try {
      return JSON.stringify(stream.primaryKey.map((c) => row[c]));
    } catch {
      return null;
    }
  }

  /**
   * take one change: drop replays, handle filtered rows, otherwise add it to
   * the pending batch and flush when the batch is complete.
   */
  private async accept(
    bridgeId: string,
    bridge: ResolvedBridge,
    stream: Stream,
    change: CdcChange,
  ): Promise<void> {
    // the stream may have been stopped/replaced while queued behind the chain
    if (this.streams.get(bridgeId) !== stream || bridge.source.kind !== 'table') return;
    // a failure has stopped this bridge: take nothing more. whatever arrives
    // now is un-acked, so the source replays it on the next start
    if (stream.halted) return;
    // strict exactly-once: never re-process a position we've already done
    // (durable engines replay from the last acked cursor after a reconnect)
    if (!stream.provider.cursorAfter(change.cursor, stream.watermark)) return;

    const op = change.op as CdcOperation;

    // a truncate carries no row: nothing to filter, nothing to key, and nothing
    // may share its batch. everything read before it is delivered first, then
    // it goes alone, then the stream carries on — so a row inserted after the
    // TRUNCATE at the source still exists at the destination afterwards
    if (op === 'truncate') {
      await this.flush(bridgeId, stream);
      if (this.streams.get(bridgeId) !== stream || stream.halted) return;
      stream.buffer.push({ change, row: {}, keySig: null });
      stream.tailCursor = change.cursor;
      stream.bufferOp = op;
      await this.flush(bridgeId, stream);
      return;
    }

    // columns the source left out because they did not change (see UNCHANGED)
    if (Object.values(change.row).includes(UNCHANGED)) {
      const row = await this.completeRow(bridgeId, bridge, stream, change);
      if (row === null) return; // the bridge was stopped; nothing moved
      change = { ...change, row };
    }

    // a row whose columns are not the ones the last row had: the table has
    // changed under the stream. looked into BEFORE the row is written — if a
    // column the bridge maps is gone, this row would carry NULL for it
    if (op !== 'delete' && tracksSchema(stream.provider.engine)) {
      const signature = Object.keys(change.row).sort().join('\u0000');
      if (stream.columnSignature !== null && stream.columnSignature !== signature) {
        const verdict = await this.drift.check(bridge);
        if (this.streams.get(bridgeId) !== stream || stream.halted) return;
        if (verdict.stop) {
          // what was read before it is fine, and goes out first; this row does
          // not, and its position is not passed: it is read again after the fix
          await this.flush(bridgeId, stream);
          if (stream.inflight) await stream.inflight.catch(() => undefined);
          await this.halt(bridgeId, stream, 'failed', verdict.stop, 'none');
          return;
        }
      }
      stream.columnSignature = signature;
    }

    // source filters: replay pushes them into SQL, but a CDC stream sees every
    // row of the table, so evaluate them in-process here. skipped rows still
    // advance the durable cursor (and the provider's server-side ack point) so
    // a filtered-out backlog never replays on resume or pins WAL on the source.
    // delete images may carry only the key columns, hence passMissingColumns
    if (
      !stream.provider.handlesSourceFilters &&
      !rowMatchesFilters(change.row, bridge.source.filters, {
        passMissingColumns: op === 'delete',
      })
    ) {
      // its cursor may only be passed once everything ORDERED BEFORE it has
      // landed. checkpointing it right here would race the batch still being
      // written: if that batch then failed (or the process died), the cursor
      // would already sit beyond it and those rows would never be read again
      this.notePosition(bridgeId, stream, change.cursor);
      return;
    }

    const keySig = this.keySignature(stream, change.row);

    // two reasons a change cannot join the current batch: a different operation
    // has no single route through the sink, and a repeated key would make one
    // multi-row upsert touch the same row twice, which Postgres rejects outright
    const conflicts =
      stream.buffer.length > 0 &&
      (stream.bufferOp !== op || (keySig !== null && stream.bufferKeys.has(keySig)));
    if (conflicts) {
      await this.flush(bridgeId, stream);
      if (this.streams.get(bridgeId) !== stream) return;
    }

    if (stream.buffer.length === 0) {
      // one measurement per batch: the stream carries a single table's shape,
      // so its rows are the same size to within a rounding error
      let bytes = 0;
      try {
        bytes = JSON.stringify(change.row).length;
      } catch {
        bytes = 0;
      }
      stream.byteCappedBatch =
        bytes > 0
          ? Math.max(1, Math.floor(runtimeConfig.cdcBatchBytes / bytes))
          : null;
    }

    stream.buffer.push({ change, row: change.row, keySig });
    stream.tailCursor = change.cursor;
    stream.bufferOp = op;
    if (keySig !== null) stream.bufferKeys.add(keySig);

    const limit = Math.min(stream.maxBatch, stream.byteCappedBatch ?? stream.maxBatch);
    if (stream.buffer.length >= limit) {
      // a full batch is delivered before this returns, so a provider that
      // awaits onChange still feels backpressure and the buffer stays bounded
      await this.flush(bridgeId, stream);
      return;
    }
    this.scheduleFlush(bridgeId, stream);
  }

  /**
   * flush a partial batch after a short linger, so a quiet stream is not stuck.
   * a batch holding rows leaves after the linger; one holding only a position
   * can wait {@link POSITION_LINGER_MS} — and is cut short the moment a row
   * joins it, so a row never inherits the longer wait.
   */
  private scheduleFlush(bridgeId: string, stream: Stream): void {
    const want = stream.buffer.length > 0 ? 'rows' : 'position';
    if (stream.timer) {
      if (stream.timerFor === want || stream.timerFor === 'rows') return;
      clearTimeout(stream.timer); // a row arrived behind a bare position
    }
    const delay =
      want === 'rows'
        ? Math.max(0, runtimeConfig.cdcLingerMs)
        : Math.max(POSITION_LINGER_MS, runtimeConfig.cdcLingerMs);
    stream.timerFor = want;
    const timer = setTimeout(() => {
      stream.timer = null;
      stream.timerFor = null;
      if (this.streams.get(bridgeId) !== stream) return;
      // queued on the same chain, so a timed flush can never interleave with
      // a change being accepted
      stream.pending = stream.pending
        .then(() => this.flush(bridgeId, stream))
        .catch((err) => {
          this.logger.error(`CDC timed flush failed for ${bridgeId}: ${(err as Error).message}`);
        });
    }, delay);
    // a pending linger must not hold the process open
    timer.unref?.();
    stream.timer = timer;
  }

  /**
   * deliver the pending batch as ONE delivery, then checkpoint once and ack
   * once. per-row work here is what set the old throughput ceiling: a delivery,
   * a delivery record, a cursor write and a source ack for every single row.
   *
   * the cursor advances only after a successful delivery, so a crash mid-batch
   * replays that batch — absorbed by the watermark dedupe and by writes being
   * idempotent upserts.
   */
  private async flush(bridgeId: string, stream: Stream): Promise<void> {
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = null;
      stream.timerFor = null;
    }
    if (stream.tailCursor === null || stream.halted) return;

    // At most ONE delivery in flight. Waiting for the previous one here does
    // two things: batches reach the destination in the order they were read,
    // and the reader is throttled to one batch ahead rather than running away.
    // What it no longer does is make the reader wait for the WRITE — reading
    // the next batch now overlaps with writing this one.
    if (stream.inflight) await stream.inflight.catch(() => undefined);
    if (this.streams.get(bridgeId) !== stream) return;
    // the delivery we just waited for may have failed and stopped the bridge.
    // delivering the next batch now would checkpoint PAST the failed one
    if (stream.halted || stream.tailCursor === null) return;

    const items = stream.buffer;
    const op = stream.bufferOp ?? undefined;
    const reach = stream.tailCursor;
    stream.tailCursor = null;
    stream.buffer = [];
    stream.bufferKeys = new Set();
    stream.bufferOp = null;
    stream.byteCappedBatch = null;

    // deliberately not awaited: the caller returns to reading, and the next
    // flush awaits this through `inflight`
    stream.inflight = this.deliverBatch(bridgeId, stream, items, op, reach);
  }

  /** write one batch, record it, checkpoint the source */
  private async deliverBatch(
    bridgeId: string,
    stream: Stream,
    items: Buffered[],
    op: CdcOperation | undefined,
    /** how far the batch reaches: its last row, or a skipped position beyond it */
    lastCursor: string,
  ): Promise<void> {
    if (stream.halted) return;
    const bridge = stream.bridge;
    if (bridge.source.kind !== 'table') return;

    if (stream.spooled) {
      const entries = items.map((i) => ({ op: i.change.op, row: i.row, cursor: i.change.cursor }));
      await this.spoolBatch(bridgeId, stream, entries, lastCursor);
      return;
    }

    if (items.length === 0) {
      // nothing to deliver, only a position to move past
      await this.settle(bridgeId, stream, () => this.checkpoint(stream, stream.seq, lastCursor));
      return;
    }

    const rows = items.map((i) => i.row);
    const seq = stream.seq;
    // key on the batch's last cursor (stable per batch) so an at-least-once
    // re-delivery after a reconnect carries the SAME Idempotency-Key
    const idem =
      bridge.destination.kind === 'http' && bridge.destination.idempotency
        ? `${stream.jobId}:${lastCursor}`
        : undefined;

    // the operation drives both the {{$op}} token (HTTP) and insert/upsert vs
    // delete routing (database destinations)
    const outcome = await this.attempt(stream, rows, op, seq, undefined, idem);

    await this.settle(bridgeId, stream, async () => {
      if (outcome.status === 'success') {
        await this.record(stream, seq, rows, outcome);
        stream.consecutiveFailures = 0;
        await this.checkpoint(stream, seq + 1, lastCursor);
        return;
      }
      const nextSeq = await this.handleFailedBatch(bridgeId, stream, {
        rows,
        op,
        seq,
        cursor: lastCursor,
        outcome,
      });
      // null = the bridge was stopped. the cursor stays where it is, so the
      // next start reads this batch again
      if (nextSeq !== null) await this.checkpoint(stream, nextSeq, lastCursor);
    });
  }

  /* ----- delivery building blocks (shared by the direct and spooled paths) ----- */

  /** one delivery attempt. the sink reports failures as outcomes; a throw is folded into one */
  private async attempt(
    stream: Stream,
    rows: Row[],
    op: CdcOperation | undefined,
    seq: number,
    skipTargets?: readonly string[],
    idempotencyKey?: string,
  ): Promise<DeliveryOutcome> {
    const bridge = stream.bridge;
    const started = performance.now();
    try {
      const { outcome } = await this.sink.deliver(
        bridge,
        rows,
        {
          table: bridge.source.kind === 'table' ? bridge.source.table : '(query)',
          now: new Date().toISOString(),
          startIndex: seq,
          op,
          ...(skipTargets?.length ? { skipTargets: [...skipTargets] } : {}),
        },
        new AbortController().signal,
        idempotencyKey,
      );
      return outcome;
    } catch (err) {
      return {
        status: 'failed',
        httpStatus: null,
        attempts: 1,
        error: err instanceof Error ? err.message : String(err),
        requestBody: null,
        responseBody: null,
        durationMs: Math.round(performance.now() - started),
        op: op ?? null,
      };
    }
  }

  /** primary-key value(s) per row, matching the shape the replay path records */
  private rowKeys(stream: Stream, rows: Row[]): unknown[] | null {
    const pk = stream.primaryKey;
    if (!pk?.length) return null;
    return rows.map((r) => (pk.length === 1 ? r[pk[0]!] : pk.map((c) => r[c])));
  }

  private record(
    stream: Stream,
    sequence: number,
    rows: Row[],
    outcome: DeliveryOutcome,
  ): Promise<void> {
    return this.jobs.recordDelivery(
      stream.jobId,
      { sequence, rowIndex: sequence, rowCount: rows.length, rowKeys: this.rowKeys(stream, rows) },
      outcome,
    );
  }

  /**
   * make progress durable, then let the source forget it — in that order. the
   * provider's ack point (the Postgres slot's confirmed LSN) may only move once
   * the cursor is stored; a missed ack merely widens the replay window the
   * watermark dedupe absorbs.
   */
  private async checkpoint(stream: Stream, nextSeq: number, cursor: string): Promise<void> {
    if (stream.halted) return;
    await this.prisma.bridgeJob.update({
      where: { id: stream.jobId },
      data: { cursorOffset: nextSeq, cursorJson: JSON.stringify({ cursor }) },
    });
    stream.seq = nextSeq;
    stream.watermark = cursor;
    try {
      await stream.handle.ack?.(cursor);
    } catch {
      /* best-effort by contract */
    }
  }

  /**
   * run the metadata-store writes that follow a delivery (record, park,
   * checkpoint). every one of them is idempotent, so a blip in the store is
   * retried. if the store stays down the bridge stops WITHOUT advancing:
   * moving on from a write that may not have been recorded is how rows vanish,
   * and the source still holds everything after the last ack.
   */
  private async settle(
    bridgeId: string,
    stream: Stream,
    work: () => Promise<void>,
  ): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (stream.halted) return;
      try {
        await work();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CDC ${bridgeId}: could not record progress (attempt ${attempt + 1}/${SETTLE_ATTEMPTS}): ${lastError}`,
        );
        if (attempt < SETTLE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
    }
    await this.halt(
      bridgeId,
      stream,
      'failed',
      `Stopped without advancing, so nothing is skipped: progress could not be saved (${lastError}). Start the bridge again once the metadata store is reachable.`,
    );
  }

  /**
   * stop the bridge because of a failure. `halted` is set synchronously so the
   * change chain cannot deliver or checkpoint anything more; the teardown
   * itself has to happen outside that chain, because the provider's stop() may
   * wait for in-flight handlers — i.e. for this very call.
   */
  private async halt(
    bridgeId: string,
    stream: Stream,
    status: 'paused' | 'failed',
    message: string,
    alertAs: 'bridge.failed' | 'bridge.position_lost' | 'none' = 'bridge.failed',
  ): Promise<void> {
    if (stream.halted) return;
    stream.halted = true;
    this.logger.warn(`CDC ${bridgeId}: ${message}`);
    await this.jobs.finalize(stream.jobId, status, message, alertAs).catch(() => undefined);
    setImmediate(() => void this.teardown(bridgeId).catch(() => undefined));
  }

  /**
   * a batch failed. decide what happens to it, and return the sequence the
   * stream continues from — or null when the bridge was stopped instead.
   *
   * `abort`: stop, without moving. the batch is retried on the next start.
   *
   * `continue`: the bridge moves on, but never past rows that exist nowhere
   * else. the rows actually at fault are isolated from the healthy ones in
   * their batch and parked, in full, in the dead-letter queue FIRST. three
   * things turn a `continue` into a stop, because carrying on would only pour
   * the change stream into the metadata store: the failure is not confined to
   * a few rows, several batches in a row delivered nothing, or the queue is
   * full. in each case the cursor stays put and nothing is lost.
   */
  private async handleFailedBatch(
    bridgeId: string,
    stream: Stream,
    batch: {
      rows: Row[];
      op: CdcOperation | undefined;
      seq: number;
      cursor: string;
      outcome: DeliveryOutcome;
    },
  ): Promise<number | null> {
    const { rows, op, seq, cursor, outcome } = batch;
    const bridge = stream.bridge;
    const dest = bridge.destination;
    const reason = outcome.error ?? 'delivery failed';

    const stop = async (message: string): Promise<null> => {
      // recorded at `seq`, which is not consumed: the retried batch lands in
      // the same cell and turns it green
      await this.record(stream, seq, rows, outcome);
      await this.halt(bridgeId, stream, 'paused', message);
      return null;
    };

    if (bridge.delivery.onError === 'abort') {
      return stop(`Paused after a failed delivery (onError=abort): ${reason}`);
    }

    // ---- which rows are actually at fault?
    let delivered: Row[] = [];
    let attempts = outcome.attempts;
    let failed: { rows: Row[]; error: string; succeededTargets: string[] }[];

    // isolation re-delivers the healthy rows in smaller groups. that is only
    // safe to repeat where writes are idempotent: an append-only (`insert`)
    // target would hold those rows twice if the bridge then stopped and the
    // batch replayed. HTTP is excluded too — there the batch IS the payload
    const canIsolate =
      dest.kind === 'database' &&
      rows.length > 1 &&
      dest.targets.every((t) => t.writeMode !== 'insert');

    if (canIsolate) {
      const found = await isolateFailures(
        rows,
        async (part, skip) => {
          const o = await this.attempt(stream, part, op, seq, [...skip]);
          return {
            ok: o.status === 'success',
            error: o.error,
            succeededTargets: o.succeededTargets ?? [],
          };
        },
        { ...ISOLATION, batchError: reason, alreadySucceeded: outcome.succeededTargets ?? [] },
      );
      attempts += found.attempts;
      if (found.systemic) {
        return stop(
          `Stopped without advancing: this is not a few bad rows — ${found.reason}. Fix the destination and start the bridge again; the batch will be retried.`,
        );
      }
      delivered = found.delivered;
      failed = found.poisoned.map((p) => ({
        rows: [p.row],
        error: p.error,
        succeededTargets: p.succeededTargets,
      }));
    } else {
      failed = [];
      for (let i = 0; i < rows.length; i += DEAD_LETTER_CHUNK) {
        failed.push({
          rows: rows.slice(i, i + DEAD_LETTER_CHUNK),
          error: reason,
          succeededTargets: outcome.succeededTargets ?? [],
        });
      }
    }

    if (failed.length === 0) {
      // the batch failed as a whole but every row then went through on its
      // own: a transient failure, and nothing is left over
      stream.consecutiveFailures = 0;
      await this.record(stream, seq, rows, this.recovered(stream, rows, attempts, op));
      return seq + 1;
    }

    // ---- is carrying on actually safe?
    stream.consecutiveFailures = delivered.length > 0 ? 0 : stream.consecutiveFailures + 1;
    if (stream.consecutiveFailures >= runtimeConfig.maxConsecutiveFailures) {
      return stop(
        `Stopped without advancing: ${stream.consecutiveFailures} batches in a row delivered nothing, which points at the destination rather than the rows. Last error: ${reason}`,
      );
    }
    const failedRows = failed.reduce((n, f) => n + f.rows.length, 0);
    const held = await this.deadLetters.pendingRows(bridgeId);
    if (held + failedRows > runtimeConfig.deadLetterMaxRows) {
      return stop(
        `Stopped without advancing: the dead-letter queue is full (${held} rows waiting, limit ${runtimeConfig.deadLetterMaxRows}). Retry or discard them, then start the bridge again. Last error: ${reason}`,
      );
    }

    // ---- park first, record second, and only then (in the caller) advance.
    // delivered rows take `seq`; the rows set aside take the next cell, so the
    // timeline and the counters say exactly what happened to each
    const failedSeq = delivered.length > 0 ? seq + 1 : seq;
    const entries: NewDeadLetter[] = failed.map((f) => ({
      bridgeId,
      jobId: stream.jobId,
      sequence: failedSeq,
      op: op ?? null,
      rows: f.rows,
      cursor,
      error: f.error,
      succeededTargets: f.succeededTargets,
    }));
    await this.deadLetters.park(entries, { replaceFrom: seq });

    if (delivered.length > 0) {
      await this.record(stream, seq, delivered, this.recovered(stream, delivered, attempts, op));
    }
    const allFailed = failed.flatMap((f) => f.rows);
    await this.record(stream, failedSeq, allFailed, {
      ...outcome,
      attempts,
      error: `${failed[0]!.error} — ${failedRows} row${failedRows === 1 ? '' : 's'} moved to the dead-letter queue`,
      ...(dest.kind === 'database' ? previewBody(allFailed, dest.targets) : {}),
      op: op ?? null,
      // the queue tracks which targets each row still needs
      succeededTargets: null,
    });
    this.logger.warn(
      `CDC ${bridgeId}: ${failedRows} row(s) moved to the dead-letter queue, ${delivered.length} delivered: ${failed[0]!.error}`,
    );
    return failedSeq + 1;
  }

  /** the success record for rows that landed during (or because of) isolation */
  private recovered(
    stream: Stream,
    rows: Row[],
    attempts: number,
    op: CdcOperation | undefined,
  ): DeliveryOutcome {
    const dest = stream.bridge.destination;
    return {
      status: 'success',
      httpStatus: null,
      attempts,
      error: null,
      ...(dest.kind === 'database'
        ? previewBody(rows, dest.targets)
        : { requestBody: null, bodyTruncated: false }),
      responseBody: `wrote ${rows.length} after the batch was split to isolate failing rows`,
      durationMs: 0,
      op: op ?? null,
      succeededTargets: null,
    };
  }

  /**
   * Hand a batch to the durable spool and checkpoint the SOURCE against it.
   *
   * This is the point of the spool: once the changes are durably in Redis the
   * source's log may advance, so a slow or unreachable destination can no
   * longer pin WAL on the production database. The destination is caught up
   * separately by the consumer.
   */
  private async spoolBatch(
    bridgeId: string,
    stream: Stream,
    entries: SpoolEntry[],
    lastCursor: string,
  ): Promise<void> {
    // bounded: an unbounded spool would just move the unbounded growth from
    // the source's WAL into Redis. Blocking here propagates backpressure all
    // the way back to the reader, which is what we want when the destination
    // cannot keep up.
    while (this.streams.get(bridgeId) === stream) {
      let depth: number;
      try {
        depth = await this.spool.depth(bridgeId);
      } catch {
        break; // depth is only advisory; a failed append below is the real guard
      }
      if (depth < runtimeConfig.cdcSpoolMax) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.streams.get(bridgeId) !== stream || stream.halted) return;

    // the cursor may only advance once the spool has the changes, so a failed
    // append must never checkpoint. retry briefly, then stop the stream: the
    // source still holds everything after the last ack, so a restart replays
    // it and nothing is lost
    // a batch of nothing but filtered-out changes has no rows to spool, only a
    // position to move past
    let appended = entries.length === 0;
    for (let attempt = 0; attempt < 3 && !appended; attempt++) {
      try {
        await this.spool.append(bridgeId, entries);
        appended = true;
      } catch (err) {
        if (attempt === 2) {
          const message = (err as Error).message;
          await this.halt(
            bridgeId,
            stream,
            'failed',
            `Spool unavailable, stopped without advancing the cursor so nothing is lost: ${message}`,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }

    stream.watermark = lastCursor;
    try {
      await this.prisma.bridgeJob.update({
        where: { id: stream.jobId },
        data: { cursorJson: JSON.stringify({ cursor: lastCursor }) },
      });
      await stream.handle.ack?.(lastCursor);
    } catch (err) {
      // the changes are safely spooled; a missed checkpoint only means the
      // source replays them, which the watermark dedupe absorbs
      this.logger.warn(
        `CDC ${bridgeId}: spooled but could not checkpoint: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Split spooled items into runs that can each go out as ONE delivery: the
   * same operation throughout, and no repeated key — a multi-row upsert cannot
   * touch the same row twice.
   */
  private deliverableRuns(items: SpooledItem[], pk: string[] | null): SpooledItem[][] {
    const runs: SpooledItem[][] = [];
    let current: SpooledItem[] = [];
    let currentOp: string | null = null;
    let seen = new Set<string>();

    for (const item of items) {
      const sig = pk?.length
        ? JSON.stringify(pk.map((c) => item.entry.row[c]))
        : null;
      // a truncate or a notice is never part of a larger delivery
      const alone = (o: string | null): boolean => o === 'truncate' || o === 'notice';
      const breaks =
        current.length > 0 &&
        (currentOp !== item.entry.op ||
          alone(item.entry.op) ||
          (sig !== null && seen.has(sig)));
      if (breaks) {
        runs.push(current);
        current = [];
        seen = new Set();
      }
      current.push(item);
      currentOp = item.entry.op;
      if (sig !== null) seen.add(sig);
    }
    if (current.length > 0) runs.push(current);
    return runs;
  }

  /**
   * Drain the spool into the destination. Entries are trimmed only after they
   * have been delivered (or recorded as failed), so a crash redelivers them —
   * at-least-once, absorbed by the idempotent writes.
   */
  private startConsumer(bridgeId: string, stream: Stream): void {
    stream.consumer = (async () => {
      while (!stream.consumerStop && !stream.halted) {
        let items: SpooledItem[];
        try {
          items = await this.spool.read(bridgeId, stream.maxBatch);
        } catch (err) {
          this.logger.warn(
            `CDC ${bridgeId}: spool read failed: ${(err as Error).message}`,
          );
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (items.length === 0) {
          await new Promise((r) =>
            setTimeout(r, Math.max(10, runtimeConfig.cdcLingerMs)),
          );
          continue;
        }

        for (const run of this.deliverableRuns(items, stream.primaryKey)) {
          if (stream.consumerStop || stream.halted) return;
          const aborted = await this.deliverSpooled(bridgeId, stream, run);
          if (aborted) return;
        }
      }
    })().catch((err) => {
      this.logger.error(
        `CDC ${bridgeId}: spool consumer stopped: ${(err as Error).message}`,
      );
    });
  }

  /**
   * deliver one run, record it, and trim it from the spool. true = stop.
   *
   * the spool is this path's cursor: a run is trimmed only once it has been
   * delivered — or its failed rows parked in the dead-letter queue — so a stop
   * leaves it in place and the next start delivers it again.
   */
  private async deliverSpooled(
    bridgeId: string,
    stream: Stream,
    run: SpooledItem[],
  ): Promise<boolean> {
    const bridge = stream.bridge;
    if (bridge.source.kind !== 'table') return true;

    const rows = run.map((i) => i.entry.row);
    const entryOp = run[0]!.entry.op;
    const lastId = run[run.length - 1]!.id;
    const lastCursor = run[run.length - 1]!.entry.cursor;
    const seq = stream.seq;

    if (entryOp === 'notice') {
      await this.settle(bridgeId, stream, async () => {
        await this.jobs.recordNotice(stream.jobId, seq, String(rows[0]?.message ?? ''));
        await this.spool.trimThrough(bridgeId, lastId);
        await this.prisma.bridgeJob.update({
          where: { id: stream.jobId },
          data: { cursorOffset: seq + 1 },
        });
        stream.seq = seq + 1;
      });
      return stream.halted;
    }
    const op = entryOp;
    const idem =
      bridge.destination.kind === 'http' && bridge.destination.idempotency
        ? `${stream.jobId}:${lastCursor}`
        : undefined;

    const outcome = await this.attempt(stream, rows, op, seq, undefined, idem);

    const advance = async (nextSeq: number): Promise<void> => {
      // delivered (or safely parked): the spool may forget it. the head
      // advances, so reads stay cheap however many millions have passed through
      await this.spool.trimThrough(bridgeId, lastId);
      await this.prisma.bridgeJob.update({
        where: { id: stream.jobId },
        data: { cursorOffset: nextSeq },
      });
      stream.seq = nextSeq;
    };

    await this.settle(bridgeId, stream, async () => {
      if (outcome.status === 'success') {
        await this.record(stream, seq, rows, outcome);
        stream.consecutiveFailures = 0;
        await advance(seq + 1);
        return;
      }
      const nextSeq = await this.handleFailedBatch(bridgeId, stream, {
        rows,
        op,
        seq,
        cursor: lastCursor,
        outcome,
      });
      if (nextSeq !== null) await advance(nextSeq);
    });
    return stream.halted;
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let jobs: ResumableJob[];
    try {
      jobs = await this.prisma.bridgeJob.findMany({
        where: { status: 'running' },
        select: { bridgeId: true, id: true, cursorOffset: true, cursorJson: true },
      });
    } catch {
      return;
    }
    for (const r of jobs) {
      try {
        await this.resumeJob(r);
      } catch (err) {
        this.logger.warn(`Could not resume CDC ${r.bridgeId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * bring a job that is marked `running` back up: after a restart of this
   * process, or after the tunnel its stream ran through dropped. resolves
   * without starting anything when the job should not run (no longer a CDC
   * bridge, disabled, its position lost, refused); throws when it should but
   * the source could not be reached, so the caller can try again.
   */
  private async resumeJob(r: ResumableJob): Promise<void> {
    const bridge = await this.store.resolve(r.bridgeId);
    if (bridge.trigger.kind !== 'cdc' || !bridge.enabled || bridge.source.kind !== 'table') return;
    const raw = await this.connStore.resolve(bridge.source.connectionId);
    const provider = this.providerFor(raw.engine);
    if (!provider) return;

    const route = await this.openRoute(raw);
    try {
      const conn = route.conn;
      // the slot may have been dropped, or invalidated by the server, while
      // this process was down. provisioning would quietly make a new one
      const gap = await this.positionLost(r.bridgeId, bridge, conn, provider, r.cursorJson);
      if (gap) {
        const lost = `This bridge could not resume where it stopped: ${gap} ${GAP_ADVICE}`;
        await this.prisma.bridgeJob.update({
          where: { id: r.id },
          data: {
            status: 'failed',
            error: lost,
            finishedAt: new Date(),
            cursorJson: JSON.stringify({ cursor: readCursor(r.cursorJson), lost: gap }),
          },
        });
        this.alertPositionLost(r.id, lost);
        this.logger.warn(`CDC ${r.bridgeId}: ${lost}`);
        await route.close();
        return;
      }
      try {
        await provider.provision(r.bridgeId, bridge, conn, (id) => this.connStore.resolve(id));
      } catch (err) {
        // a REFUSAL is not a hiccup: this bridge must not run (a table that
        // cannot be served, a bridge that would feed itself). anything else —
        // the source is briefly unreachable — is left to the stream's retries
        if (err instanceof BadRequestError) {
          await this.jobs.finalize(r.id, 'failed', err.message).catch(() => undefined);
          this.logger.warn(`CDC ${r.bridgeId} not resumed: ${err.message}`);
          await route.close();
          return;
        }
      }
      await this.beginStream(r.bridgeId, bridge, route, provider, r.id, r.cursorOffset, r.cursorJson);
      this.logger.log(`Resumed CDC stream for bridge ${r.bridgeId} (${raw.engine})`);
    } catch (err) {
      if (this.streams.get(r.bridgeId)?.route !== route) await route.close();
      throw route.tunnel?.takeError() ?? err;
    }
  }

  /**
   * the SSH tunnel under a running stream dropped. stop what is left of the
   * stream, then keep trying to bring it back through a new tunnel — for as
   * long as the job is still meant to be running — from the last position that
   * was durably checkpointed. nothing is lost: what was not checkpointed was
   * not acknowledged either, and the source hands it over again.
   */
  private async rerouteStream(bridgeId: string, stream: Stream): Promise<void> {
    if (this.streams.get(bridgeId) !== stream || stream.halted || this.destroyed) return;
    this.logger.warn(`CDC ${bridgeId}: the SSH tunnel to its source dropped; reconnecting`);
    const jobId = stream.jobId;
    await this.teardown(bridgeId);

    for (let attempt = 0; !this.destroyed; attempt++) {
      let job: ResumableJob | null = null;
      try {
        const row = await this.prisma.bridgeJob.findUnique({
          where: { id: jobId },
          select: { bridgeId: true, id: true, cursorOffset: true, cursorJson: true, status: true },
        });
        // stopped, deleted or failed in the meantime: no longer ours to revive
        if (!row || row.status !== 'running') return;
        job = row;
        // beginStream finalizes the job as failed when it cannot connect; this
        // is a retry loop, so put it back before the next attempt reads it
        await this.resumeJob(job);
        if (this.streams.has(bridgeId)) return;
      } catch (err) {
        this.logger.warn(
          `CDC ${bridgeId}: could not re-establish its tunnel (attempt ${attempt + 1}): ${(err as Error).message}`,
        );
        if (job) {
          await this.prisma.bridgeJob
            .updateMany({ where: { id: jobId, status: 'failed' }, data: { status: 'running', finishedAt: null } })
            .catch(() => undefined);
        }
      }
      await delay(backoffMs(attempt, 1_000, 30_000));
    }
  }
}
