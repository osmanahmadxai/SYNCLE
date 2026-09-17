/**
 * Durable spool between the change reader and the destination writer.
 *
 * Without a broker in the path, a slow or unreachable destination holds the
 * SOURCE's log open: a Postgres slot stops advancing and WAL accumulates on the
 * production database until its disk fills. That is the sharpest operational
 * edge of running CDC with no Kafka, and this is the thing that blunts it.
 *
 * Changes are appended to a Redis Stream, one per bridge, and a consumer drains
 * it into the destination. The source can then be acknowledged as soon as a
 * change is durably spooled, so the slot advances at the speed of Redis rather
 * than the speed of the destination.
 *
 * That trade is explicit and opt-in (`SYNCLE_CDC_SPOOL=on`). While a change sits
 * in the spool and not yet in the destination, REDIS is the only copy of it —
 * so this mode is only safe with Redis persistence (appendonly) enabled. It is
 * off by default; nobody trades durability for throughput without asking.
 *
 * Entries are removed only once delivered, so anything left after a crash is
 * redelivered on restart: at-least-once, which the watermark dedupe and
 * idempotent upserts already absorb.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { CdcOperation } from '@syncle/core';
import { redisConnectionOptions } from '../../common/runtime-config';
import { decodeRows, encodeRows } from '../row-codec';

/** one change as it is held in the spool */
export interface SpoolEntry {
  op: CdcOperation;
  row: Record<string, unknown>;
  cursor: string;
}

/**
 * an entry as the stream holds it. the row goes through the lossless row codec:
 * plain `JSON.stringify` turned a Buffer into `{type:'Buffer',data:[…]}` and a
 * Date into a string, so with the spool ON a bytea column arrived as a JSON
 * blob and a bridge behaved differently than the same bridge with it OFF.
 */
export function encodeEntry(entry: SpoolEntry): string {
  return JSON.stringify({ op: entry.op, cursor: entry.cursor, r: encodeRows([entry.row]) });
}

/** inverse of {@link encodeEntry}; also reads entries spooled before the codec */
export function decodeEntry(text: string): SpoolEntry {
  const raw = JSON.parse(text) as {
    op: CdcOperation;
    cursor: string;
    r?: string;
    row?: Record<string, unknown>;
  };
  if (typeof raw.r === 'string') {
    const [row] = decodeRows(raw.r);
    if (!row) throw new Error('spool entry holds no row');
    return { op: raw.op, cursor: raw.cursor, row };
  }
  if (raw.row && typeof raw.row === 'object') {
    return { op: raw.op, cursor: raw.cursor, row: raw.row };
  }
  throw new Error('spool entry holds no row');
}

/** a spooled entry plus the stream id it must be trimmed by */
export interface SpooledItem {
  id: string;
  entry: SpoolEntry;
}

/**
 * The id immediately after `id`. Stream ids are "<ms>-<seq>", and MINID trims
 * entries strictly BELOW the given id, so trimming *through* an entry means
 * trimming below its successor.
 */
export function nextStreamId(id: string): string {
  const dash = id.lastIndexOf('-');
  if (dash < 0) return id;
  const ms = id.slice(0, dash);
  const seq = Number(id.slice(dash + 1));
  if (!Number.isFinite(seq)) return id;
  // sequence is a 64-bit counter; Number is exact far past any realistic run,
  // and rolling to the next millisecond would also be correct
  return `${ms}-${seq + 1}`;
}

@Injectable()
export class CdcSpoolService implements OnModuleDestroy {
  private readonly logger = new Logger('CdcSpool');
  private client: Redis | null = null;

  /** one stream per bridge, so ordering is per-bridge and trimming is isolated */
  private key(bridgeId: string): string {
    return `syncle:cdc:spool:${bridgeId}`;
  }

  private conn(): Redis {
    if (!this.client) {
      this.client = new Redis({
        ...redisConnectionOptions(),
        lazyConnect: false,
      });
      this.client.on('error', (err) => {
        // ioredis reconnects on its own; log once rather than crash the process
        this.logger.warn(`spool redis error: ${err.message}`);
      });
    }
    return this.client;
  }

  /**
   * Append changes in order and return the id of the last one. The caller may
   * treat a resolved append as durable enough to acknowledge the source, which
   * is the whole point of the spool.
   */
  async append(bridgeId: string, entries: SpoolEntry[]): Promise<string | null> {
    if (entries.length === 0) return null;
    const key = this.key(bridgeId);
    const pipeline = this.conn().pipeline();
    for (const entry of entries) {
      pipeline.xadd(key, '*', 'e', encodeEntry(entry));
    }
    const results = await pipeline.exec();
    if (!results?.length) return null;
    // EVERY write has to have landed, not just the last. the caller acks the
    // source on the strength of this returning, and a pipeline reports errors
    // per command: an early XADD refused (Redis out of memory, say) followed by
    // a later one accepted used to read as success, and that change was gone
    for (const [err] of results as Array<[Error | null, unknown]>) {
      if (err) throw err;
    }
    const [, id] = results[results.length - 1] as [Error | null, string];
    return id;
  }

  /** oldest-first read of at most `count` undelivered entries */
  async read(bridgeId: string, count: number): Promise<SpooledItem[]> {
    const raw = (await this.conn().xrange(
      this.key(bridgeId),
      '-',
      '+',
      'COUNT',
      count,
    )) as Array<[string, string[]]>;

    const items: SpooledItem[] = [];
    for (const [id, fields] of raw) {
      // fields are flat [name, value, ...]; the payload lives under "e"
      const idx = fields.indexOf('e');
      if (idx < 0 || idx + 1 >= fields.length) continue;
      try {
        items.push({ id, entry: decodeEntry(fields[idx + 1]!) });
      } catch {
        // an unparseable entry would block the queue forever; drop it loudly
        this.logger.error(`discarding malformed spool entry ${id} for ${bridgeId}`);
        await this.conn().xdel(this.key(bridgeId), id).catch(() => undefined);
      }
    }
    return items;
  }

  /**
   * Advance the head past everything delivered up to and including `lastId`.
   *
   * XTRIM MINID rather than XDEL on purpose. The spool is consumed strictly in
   * order, and XDEL only tombstones entries — the macro-node stays until every
   * entry in it is deleted, so a long-running stream accumulates dead entries
   * that each XRANGE from the head must skip, and memory is not returned.
   * MINID moves the head itself, which keeps reads O(batch) and releases memory
   * no matter how many millions have passed through.
   */
  async trimThrough(bridgeId: string, lastId: string): Promise<void> {
    await this.conn().xtrim(this.key(bridgeId), 'MINID', nextStreamId(lastId));
  }

  /** how many changes are waiting; drives backpressure on the reader */
  async depth(bridgeId: string): Promise<number> {
    return this.conn().xlen(this.key(bridgeId));
  }

  /** drop a bridge's spool entirely (bridge deleted or reset) */
  async clear(bridgeId: string): Promise<void> {
    await this.conn().del(this.key(bridgeId));
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.quit().catch(() => undefined);
  }
}
