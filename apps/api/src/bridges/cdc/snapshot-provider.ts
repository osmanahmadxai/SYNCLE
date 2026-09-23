/**
 * "copy the table, then follow its changes" — in one bridge, for every engine,
 * by wrapping the engine's own provider.
 *
 * The hard part of doing both is the seam. Copy first and start listening
 * afterwards, and whatever changed while the copy ran is lost. Listen first and
 * copy alongside, and a row's OLD value, read by the copy a moment before it
 * changed, can be written after the new one. So:
 *
 *   1. a place in the change log is taken ({@link CdcProvider.capturePosition})
 *      — nothing is read from it yet
 *   2. the table is read from one end to the other and every row is handed to
 *      the orchestrator as an `insert`
 *   3. the stream is opened AT THAT PLACE. everything that changed during the
 *      copy arrives now, after the copied rows, in order
 *
 * A row that changed during the copy is therefore delivered twice — once as the
 * copy read it, once as the change — and ends up right, because a keyed target
 * is written with an idempotent upsert. (An append-only target gets it twice.)
 *
 * An engine with no log to hold a place in (Redis) cannot do step 1. There the
 * stream is opened first and its changes are HELD, in memory, until the copy is
 * done — only the newest change per key is kept, so what is held is bounded by
 * the number of keys touched, and by `holdMax` beyond that.
 *
 * The copied rows travel through exactly the pipeline changes do: batching,
 * transforms, the dead-letter queue, the spool, checkpoints. What makes that
 * work is the cursor a copied row carries, which says how far the copy has got
 * and where the stream is to start afterwards; the orchestrator persists it
 * like any other cursor, and a bridge stopped mid-copy resumes mid-copy.
 */
import type {
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@syncle/core';
import { BadRequestError } from '@syncle/core';
import type { KeysetCheckpoint, ResolvedBridge } from '../bridges.types';
import type { TableOrder, TableRow } from '../table-reader.service';
import {
  backoffMs,
  delay,
  type CdcChange,
  type CdcProvider,
  type CdcSourceHold,
  type CdcStreamContext,
  type CdcStreamHandle,
  type CdcStreamHandlers,
} from './cdc-provider';

/* -------------------------------------------------------------------------- */
/* the cursor of a copied row                                                 */
/* -------------------------------------------------------------------------- */

const PREFIX = 'B:';

export interface SnapshotCursor {
  /**
   * a row: its position in the read (0-based) — everything up to and including
   * it has been handed over. the end marker: the number of rows copied
   */
  index: number;
  /** the row's key, when the read is keyset-paginated: a resume lands on the exact next row */
  key: KeysetCheckpoint | null;
  /** where the stream starts once the copy is done (null: the server holds the place itself) */
  from: string | null;
  /** the copy is complete; only the stream is left */
  done: boolean;
}

export function isSnapshotCursor(
  cursor: string | null | undefined,
): cursor is string {
  return typeof cursor === 'string' && cursor.startsWith(PREFIX);
}

export function formatSnapshotCursor(c: SnapshotCursor): string {
  const body = JSON.stringify(
    {
      ...(c.key ? { k: c.key } : {}),
      f: c.from,
      ...(c.done ? { d: true } : {}),
    },
    // a key is whatever the adapter read; a bigint has no JSON form of its own
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return `${PREFIX}${c.index}:${Buffer.from(body, 'utf8').toString('base64url')}`;
}

export function parseSnapshotCursor(
  cursor: string | null | undefined,
): SnapshotCursor | null {
  if (!isSnapshotCursor(cursor)) return null;
  const sep = cursor.indexOf(':', PREFIX.length);
  if (sep < 0) return null;
  const index = Number(cursor.slice(PREFIX.length, sep));
  if (!Number.isInteger(index) || index < 0) return null;
  try {
    const o = JSON.parse(
      Buffer.from(cursor.slice(sep + 1), 'base64url').toString('utf8'),
    ) as {
      k?: KeysetCheckpoint;
      f?: string | null;
      d?: boolean;
    };
    const key =
      o.k && typeof o.k.column === 'string'
        ? { column: o.k.column, value: o.k.value }
        : null;
    return {
      index,
      key,
      from: typeof o.f === 'string' ? o.f : null,
      done: o.d === true,
    };
  } catch {
    return null;
  }
}

/** the engine's own cursor inside a saved position: a copy in progress has its stream's start in it */
export function streamCursorOf(cursor: string | null): string | null {
  const snapshot = parseSnapshotCursor(cursor);
  return snapshot ? snapshot.from : isSnapshotCursor(cursor) ? null : cursor;
}

/* -------------------------------------------------------------------------- */
/* changes held back while the copy runs (engines with no log position)       */
/* -------------------------------------------------------------------------- */

export class HeldChanges {
  private readonly byKey = new Map<string, CdcChange>();
  private anonymous = 0;

  constructor(private readonly keyColumn: string | null) {}

  get size(): number {
    return this.byKey.size;
  }

  add(change: CdcChange): void {
    const value = this.keyColumn ? change.row[this.keyColumn] : undefined;
    let key: string;
    if (value === undefined || value === null)
      key = `\u0000${this.anonymous++}`;
    else {
      try {
        key = JSON.stringify(value);
      } catch {
        key = `\u0000${this.anonymous++}`;
      }
    }
    // the newest change to a key is the only one that matters once the copy is
    // done, and it takes its place at the END: what is held stays in the order
    // things last happened
    this.byKey.delete(key);
    this.byKey.set(key, change);
  }

  shift(): CdcChange | undefined {
    const first = this.byKey.entries().next();
    if (first.done) return undefined;
    this.byKey.delete(first.value[0]);
    return first.value[1];
  }
}

/* -------------------------------------------------------------------------- */
/* the wrapper                                                                */
/* -------------------------------------------------------------------------- */

/** what the wrapper needs of {@link TableReaderService} */
export interface SnapshotReader {
  resolveOrder(bridge: ResolvedBridge): Promise<TableOrder>;
  rows(
    bridge: ResolvedBridge,
    opts: {
      startOffset: number;
      resumeKey: KeysetCheckpoint | null;
      order?: TableOrder;
    },
  ): AsyncGenerator<TableRow>;
}

export interface SnapshotOptions {
  /** changes held at once, on an engine that has to hold them, before the bridge gives up */
  holdMax: number;
  /** consecutive failed reads of the table before the bridge is stopped */
  readAttempts?: number;
  /** wait before retry number `attempt` (0-based). replaced in tests */
  retryDelayMs?: (attempt: number) => number;
  log?: (message: string) => void;
}

export class SnapshotCdcProvider implements CdcProvider {
  constructor(
    private readonly inner: CdcProvider,
    private readonly reader: SnapshotReader,
    private readonly options: SnapshotOptions,
  ) {}

  get engine(): DatabaseEngine {
    return this.inner.engine;
  }
  get handlesSourceFilters(): boolean | undefined {
    return this.inner.handlesSourceFilters;
  }
  get capturesTruncate(): boolean | undefined {
    return this.inner.capturesTruncate;
  }

  readiness(
    dto: CdcReadinessDTO,
    conn: ConnectionConfig,
  ): Promise<CdcReadiness> {
    return this.inner.readiness(dto, conn);
  }

  provision(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
    resolveTarget?: (connectionId: string) => Promise<ConnectionConfig>,
  ): Promise<void> {
    return this.inner.provision(bridgeId, bridge, conn, resolveTarget);
  }

  deprovision(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
  ): Promise<void> {
    return this.inner.deprovision(bridgeId, bridge, conn);
  }

  /** a copy in progress holds the place its stream will start from: that is what can be lost */
  async inspect(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
    cursor: string | null,
  ): Promise<CdcSourceHold | null> {
    if (!this.inner.inspect) return null;
    return this.inner.inspect(bridgeId, bridge, conn, streamCursorOf(cursor));
  }

  capturePosition(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
  ): Promise<string | null> {
    return this.inner.capturePosition
      ? this.inner.capturePosition(bridgeId, bridge, conn)
      : Promise.resolve(null);
  }

  /**
   * the copy comes before the stream, and within the copy rows are in the order
   * they were read. a copied row arriving when the stream's own position has
   * already been stored is a replay of something long done
   */
  cursorAfter(a: string, b: string | null): boolean {
    if (b === null) return true;
    const copyA = parseSnapshotCursor(a);
    const copyB = parseSnapshotCursor(b);
    if (copyA && copyB) return copyA.index > copyB.index;
    if (copyA) return false;
    if (copyB || isSnapshotCursor(b)) return true;
    return this.inner.cursorAfter(a, b);
  }

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const resume = parseSnapshotCursor(ctx.fromCursor);
    const copying =
      resume !== null || (ctx.snapshot === true && ctx.fromCursor === null);
    if (!copying)
      return this.following(
        await this.inner.startStream({ ...ctx, snapshot: undefined }),
      );
    if (resume?.done) {
      return this.following(
        await this.inner.startStream({
          ...ctx,
          fromCursor: resume.from,
          snapshot: undefined,
        }),
      );
    }
    return this.copyThenFollow(ctx, resume);
  }

  /** the engine's stream, with the one thing it must not be given kept from it */
  private following(handle: CdcStreamHandle): CdcStreamHandle {
    return {
      stop: () => handle.stop(),
      // the orchestrator confirms every cursor it stores, and the copy's cursors
      // mean nothing to the source
      ack: async (cursor) => {
        if (!isSnapshotCursor(cursor)) await handle.ack?.(cursor);
      },
    };
  }

  private async copyThenFollow(
    ctx: CdcStreamContext,
    resume: SnapshotCursor | null,
  ): Promise<CdcStreamHandle> {
    const { bridge, bridgeId, handlers } = ctx;
    const log = this.options.log ?? (() => undefined);
    const attempts = Math.max(1, this.options.readAttempts ?? 5);
    const wait =
      this.options.retryDelayMs ?? ((attempt: number) => backoffMs(attempt));

    // refuses here, while the caller is still waiting for the start: a table
    // with no key to page by cannot be copied, and that is not news for a log.
    // (a replay may read such a table by OFFSET and say so; a copy that changes
    // arrive under has to be exact, or the changes land on the wrong rows)
    const order = await this.reader.resolveOrder(bridge);
    if (order.warning && bridge.source.kind === 'table') {
      throw new BadRequestError(
        `Table "${bridge.source.table}" has no primary key and no unique index, so its existing rows cannot be copied in a stable order while changes arrive under them. ` +
          'Add a primary key (or a unique index whose columns cannot be NULL) and start the bridge again, or start it from "now" to follow changes only.',
      );
    }

    const holds = !this.inner.capturePosition;
    let from = resume ? resume.from : null;
    if (!resume && !holds)
      from = await this.capturePosition(bridgeId, bridge, ctx.conn);

    let stopped = false;
    let inner: CdcStreamHandle | null = null;
    let held: HeldChanges | null = null;
    let overflowed = false;

    const fatal = async (message: string): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (handlers.onFatal) await handlers.onFatal(message);
      else handlers.onError(new Error(message));
    };

    if (holds) {
      // no place to take in a log: listen from now, and keep what is heard
      // until the copy is done
      const holding = new HeldChanges(order.keysetColumn);
      held = holding;
      const gated: CdcStreamHandlers = {
        ...handlers,
        onChange: async (change) => {
          if (held === null) return handlers.onChange(change);
          held.add(change);
          if (held.size > this.options.holdMax && !overflowed) {
            overflowed = true;
            await fatal(
              `More than ${this.options.holdMax} different rows changed while the existing ones were being copied, and this engine has no change log to read them back from. ` +
                'Start the bridge again when the source is quieter, or raise SYNCLE_SNAPSHOT_HOLD_MAX.',
            );
          }
        },
        // positions and notices of a stream nothing has been delivered from yet
        onSkip: async () => undefined,
      };
      inner = await this.inner.startStream({
        ...ctx,
        fromCursor: null,
        snapshot: undefined,
        handlers: gated,
      });
    }

    const copy = async (): Promise<number> => {
      let next = resume ? resume.index + 1 : 0;
      let key = resume?.key ?? null;
      let failures = 0;
      for (;;) {
        try {
          for await (const item of this.reader.rows(bridge, {
            startOffset: next,
            resumeKey: key,
            order,
          })) {
            if (stopped) return next;
            await handlers.onChange({
              op: 'insert',
              row: item.row,
              cursor: formatSnapshotCursor({
                index: item.index,
                key: item.keyset ?? null,
                from,
                done: false,
              }),
            });
            next = item.index + 1;
            key = item.keyset ?? null;
            failures = 0;
          }
          return next;
        } catch (err) {
          if (stopped) return next;
          failures++;
          const message = err instanceof Error ? err.message : String(err);
          if (failures >= attempts) {
            await fatal(
              `Stopped while copying the table (${next} rows copied so far): ${message}. Start the bridge again to carry on from there.`,
            );
            return next;
          }
          handlers.onError(
            new Error(
              `reading the table failed (attempt ${failures}/${attempts}): ${message}`,
            ),
          );
          await delay(wait(failures - 1));
        }
      }
    };

    const run = async (): Promise<void> => {
      const copied = await copy();
      if (stopped) return;
      log(`CDC ${bridgeId}: copied ${copied} existing rows; following changes`);
      await handlers.onNotice?.(
        `Copied the ${copied} row${copied === 1 ? '' : 's'} the table already had. Following its changes from the position taken before the copy began.`,
        formatSnapshotCursor({ index: copied, key: null, from, done: true }),
      );
      if (stopped) return;

      if (held) {
        // hand over what was held, oldest first. changes keep arriving while
        // this runs, and join the end of the queue; the gate opens only once
        // the queue is empty, so nothing overtakes anything
        for (let change = held.shift(); change; change = held.shift()) {
          if (stopped) return;
          await handlers.onChange(change);
        }
        held = null;
        return;
      }

      for (let failures = 0; !stopped; ) {
        try {
          const opened = await this.inner.startStream({
            ...ctx,
            fromCursor: from,
            snapshot: undefined,
          });
          if (stopped) await opened.stop().catch(() => undefined);
          else inner = opened;
          return;
        } catch (err) {
          failures++;
          const message = err instanceof Error ? err.message : String(err);
          if (failures >= attempts) {
            await fatal(
              `The table was copied, but its change stream could not be opened: ${message}`,
            );
            return;
          }
          handlers.onError(
            new Error(
              `opening the change stream failed (attempt ${failures}/${attempts}): ${message}`,
            ),
          );
          await delay(wait(failures - 1));
        }
      }
    };

    const running = run().catch((err) =>
      handlers.onError(err instanceof Error ? err : new Error(String(err))),
    );

    return {
      stop: async () => {
        stopped = true;
        await inner?.stop().catch(() => undefined);
        // so that nothing is handed over after stop() has returned. bounded: a
        // page read that hangs must not hang the stop with it
        await Promise.race([running, delay(5_000)]);
        await inner?.stop().catch(() => undefined);
      },
      ack: async (cursor) => {
        if (!isSnapshotCursor(cursor)) await inner?.ack?.(cursor);
      },
    };
  }
}
