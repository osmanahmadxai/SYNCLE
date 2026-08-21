/**
 * Redis CDC via keyspace notifications (pub/sub on `__keyevent@<db>__:*`).
 *
 * IMPORTANT, this is real-time but NON-DURABLE by nature:
 *  - keyspace notifications are fire-and-forget pub/sub with no backlog. any
 *    event published while Syncle is disconnected (restart, network blip)
 *    is gone for good, there's no resume cursor.
 *  - the event carries only the KEY, not the value, so we do a best-effort
 *    follow-up read to fill the row (the key may already be gone for deletes).
 *  - Redis can't tell create from overwrite, so all writes map to `update`.
 *
 * these limits are surfaced in the readiness instructions so the user knows
 * what they're getting. for durable Redis change capture, polling (watch) is
 * actually the more reliable choice.
 */
import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@syncle/core';
import type { ResolvedBridge } from '../../bridges.types';
import type {
  CdcChange,
  CdcProvider,
  CdcStreamContext,
  CdcStreamHandle,
} from '../cdc-provider';

/**
 * events that mean the key is gone. everything else is treated as a write.
 * note `expire` (setting a TTL, key still live) is NOT here — only `expired`
 * (the TTL actually fired and removed the key) is a delete.
 */
const DELETE_EVENTS = new Set(['del', 'unlink', 'expired', 'evicted']);

@Injectable()
export class RedisCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'redis';
  private readonly logger = new Logger('BridgeCdc:redis');

  // the `key` filter is a glob applied at the subscription (see keyPattern),
  // so the orchestrator must not ALSO evaluate it as a literal equality
  readonly handlesSourceFilters = true;

  // no durable position, every delivered event is "new"
  cursorAfter(): boolean {
    return true;
  }

  private dbIndex(conn: ConnectionConfig): number {
    // a connection string may select the db in its path (redis://host:6379/2);
    // ioredis honors it, so the keyevent channel must match it too
    if (conn.connectionString) {
      try {
        const path = new URL(conn.connectionString).pathname.replace(/^\//, '');
        const fromPath = Number(path);
        if (path && Number.isFinite(fromPath)) return fromPath;
      } catch {
        /* unparseable, fall through to the discrete fields */
      }
    }
    const idx = Number(conn.options?.db ?? conn.database ?? 0);
    return Number.isFinite(idx) ? idx : 0;
  }

  private newClient(conn: ConnectionConfig): Redis {
    if (conn.connectionString) {
      return new Redis(conn.connectionString, { lazyConnect: true, maxRetriesPerRequest: null });
    }
    return new Redis({
      host: conn.host ?? 'localhost',
      port: conn.port ?? 6379,
      username: conn.user || undefined,
      password: conn.password || undefined,
      db: this.dbIndex(conn),
      tls: conn.ssl ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      connectTimeout: 8000,
    });
  }

  /* ----- readiness ----- */

  async readiness(_dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness> {
    const checks: CdcReadiness['checks'] = [];
    const instructions: string[] = [];
    const client = this.newClient(conn);
    try {
      await client.connect();
      const res = (await client.config('GET', 'notify-keyspace-events')) as string[];
      const flags = res?.[1] ?? '';
      // we subscribe to keyevent channels, so we need 'E' plus event classes
      // ('A' = all classes, or the specific generic/string/etc flags)
      const hasEvent = flags.includes('E');
      const hasClasses = flags.includes('A') || /[g$lshzxet]/.test(flags);
      const ok = hasEvent && hasClasses;
      checks.push({
        label: 'notify-keyspace-events enabled',
        ok,
        detail: flags ? `currently "${flags}"` : 'currently empty (disabled)',
      });
      if (!ok) {
        instructions.push(
          'Enable keyspace notifications:  CONFIG SET notify-keyspace-events EA  (or set `notify-keyspace-events EA` in redis.conf). Syncle will attempt this automatically on start; managed Redis may require enabling it in the provider console.',
        );
      }
      instructions.push(
        'Note: Redis change capture is real-time only. Events that occur while Syncle is offline cannot be recovered, and the changed value is fetched after the fact (best-effort).',
      );
      return { engine: 'redis', supported: true, ready: ok, checks, instructions };
    } catch (err) {
      return {
        engine: 'redis',
        supported: true,
        ready: false,
        checks: [{ label: 'connect to Redis', ok: false, detail: (err as Error).message }],
        instructions: ['Could not connect to Redis to check readiness.'],
      };
    } finally {
      client.disconnect();
    }
  }

  /* ----- provisioning: best-effort enable of keyspace notifications ----- */

  async provision(_bridgeId: string, _bridge: ResolvedBridge, conn: ConnectionConfig): Promise<void> {
    const client = this.newClient(conn);
    try {
      await client.connect();
      const res = (await client.config('GET', 'notify-keyspace-events')) as string[];
      const flags = res?.[1] ?? '';
      if (!(flags.includes('E') && (flags.includes('A') || /[g$lshzxet]/.test(flags)))) {
        // try to turn it on ourselves, harmless if it's already adequate
        await client.config('SET', 'notify-keyspace-events', 'EA').catch((err: Error) => {
          this.logger.warn(`Could not auto-enable keyspace notifications: ${err.message}`);
        });
      }
    } catch (err) {
      this.logger.warn(`Redis provision skipped: ${(err as Error).message}`);
    } finally {
      client.disconnect();
    }
  }

  async deprovision(): Promise<void> {
    /* no-op: we don't disable notifications, other consumers may rely on them */
  }

  /* ----- the stream ----- */

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const { bridge, conn, handlers } = ctx;
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc') {
      throw new Error('Redis CDC requires a source and cdc trigger.');
    }
    const ops = new Set<CdcOperation>(bridge.trigger.operations);
    const wantsWrite = ops.has('update') || ops.has('insert');
    const wantsDelete = ops.has('delete');
    const db = this.dbIndex(conn);
    // optional key glob filter (e.g. "user:*"), falls back to all keys
    const keyGlob = this.keyPattern(bridge);

    const sub = this.newClient(conn); // subscriber connection (no normal commands)
    const reader = this.newClient(conn); // best-effort value reader
    await sub.connect();
    await reader.connect();

    let seq = 0;
    sub.on('error', (err: Error) => handlers.onError(err));

    // admission chain: events must enter the pipeline in pmessage arrival
    // order. buildRow awaits TYPE+GET for writes but resolves instantly for
    // deletes, so firing them unchained lets a DEL overtake the SET before it
    // and the destination applies delete-then-upsert, resurrecting the key
    let chain: Promise<void> = Promise.resolve();

    sub.on('pmessage', (_pattern: string, channel: string, key: string) => {
      // channel: __keyevent@<db>__:<event>   message: <key>
      const event = channel.slice(channel.indexOf(':') + 1);
      if (keyGlob && !this.globMatch(keyGlob, key)) return;
      const isDelete = DELETE_EVENTS.has(event);
      if (isDelete ? !wantsDelete : !wantsWrite) return;

      const op: CdcOperation = isDelete ? 'delete' : 'update';
      const cursor = `${Date.now()}:${seq++}`; // synthetic, non-durable

      // resolve the value off the subscriber socket, but chained: each event's
      // read AND delivery complete before the next event's read begins
      chain = chain
        .then(async () => {
          const row = await this.buildRow(reader, key, event, isDelete);
          await handlers.onChange({ op, row, cursor });
        })
        .catch((err) => handlers.onError(err as Error));
    });

    await sub.psubscribe(`__keyevent@${db}__:*`);

    return {
      stop: async () => {
        sub.disconnect();
        reader.disconnect();
      },
    };
  }

  /** best-effort read of the current value for a changed key */
  private async buildRow(
    reader: Redis,
    key: string,
    event: string,
    isDelete: boolean,
  ): Promise<Record<string, unknown>> {
    const base = { key, event };
    if (isDelete) return base; // value's gone
    try {
      const type = await reader.type(key);
      switch (type) {
        case 'string':
          return { ...base, type, value: await reader.get(key) };
        case 'hash':
          return { ...base, type, value: await reader.hgetall(key) };
        case 'list':
          return { ...base, type, value: await reader.lrange(key, 0, -1) };
        case 'set':
          return { ...base, type, value: await reader.smembers(key) };
        case 'zset':
          return { ...base, type, value: await reader.zrange(key, 0, -1, 'WITHSCORES') };
        default:
          return { ...base, type }; // 'none' (already gone) or unsupported type
      }
    } catch {
      return base; // key vanished between the event and the read
    }
  }

  /** pull an optional key glob from the bridge source filters, if present */
  private keyPattern(bridge: ResolvedBridge): string | null {
    if (bridge.source.kind !== 'table') return null;
    const filters = (bridge.source as { filters?: { column: string; value: unknown }[] }).filters;
    const keyFilter = filters?.find((f) => f.column === 'key');
    return keyFilter && typeof keyFilter.value === 'string' ? keyFilter.value : null;
  }

  /** minimal Redis-style glob match (`*` and `?`) */
  private globMatch(glob: string, value: string): boolean {
    const re = new RegExp(
      '^' +
        glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
    return re.test(value);
  }
}
