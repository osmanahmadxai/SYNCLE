/**
 * A -> B plus B -> A.
 *
 * Two bridges that feed each other send one row back and forth for ever: A's
 * change is written to B, which B's change log reports, which the other bridge
 * writes to A, which A's change log reports … measured on two PostgreSQL
 * tables: one INSERT by a person, nine deliveries a second in each direction,
 * for as long as both bridges ran. (An upsert of the same values is still a
 * change as far as PostgreSQL's log is concerned.)
 *
 * What stops it is knowing a change for what it is: THIS instance's own write
 * coming back. So when a bridge writes to a table that another live bridge
 * reads, what it wrote is remembered for a while — by table, by key, in order —
 * and the bridge that reads that table looks each change up. A change that
 * matches what was just written there is an ECHO.
 *
 * An echo is not always dropped. A -> B -> C is a chain, and B's bridge to C
 * has to pass on exactly the rows that A's bridge wrote. So an echo remembers
 * where it has BEEN (its origins), and is only kept from going back to a table
 * it has already been through: A <-> B stops after one hop, A -> B -> C keeps
 * working, and A -> B -> C -> A stops at A.
 *
 * Deliberately not done with engine features (replication origins, markers in
 * the WAL): those need privileges or versions a source may not have, and only
 * exist on one engine. This needs Syncle's own Redis and nothing of the source.
 *
 * Two things keep what is remembered TRUE, because a memory of a write whose
 * change never comes would sit there waiting to be mistaken for somebody's edit:
 * the write is looked at first, and a row that is already what the bridge would
 * set it to is neither written nor remembered (which is also what makes a missed
 * echo die out by itself one hop later, on every engine); and a write that
 * failed or changed nothing is taken back.
 *
 * It fails open. A change that cannot be matched — the memory of it expired
 * because the reader was further behind than SYNCLE_ECHO_TTL_SECONDS, the two
 * bridges key the table differently — is delivered, as every change was before
 * this existed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import {
  UNCHANGED,
  keyText,
  originsOf,
  parseColumnType,
  sameValue,
  type CdcOperation,
  type CompareKind,
  type BridgeLoopStatus,
  type ConnectionConfig,
  type DatabaseTarget,
  type FilterSpec,
} from '@syncle/core';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';
import {
  redisConnectionOptions,
  runtimeConfig,
} from '../common/runtime-config';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { ECHO_KEY_PREFIX } from './echo-keys';
import { lookupValues } from './lookup-values';
import { decodeRows, encodeRows } from './row-codec';
import type { ResolvedBridge } from './bridges.types';

type Row = Record<string, unknown>;

/** writes remembered per row: a row a bridge changes more often than this within the TTL loses its oldest */
const PER_ROW = 20;
/** writes remembered per table for rows that cannot be looked up by the table's primary key */
const PER_TABLE_UNKEYED = 500;
/** how long the answer to "which tables are both written and read?" is believed */
const TOPOLOGY_TTL_MS = 5000;
/** how long what is known of a table (its key, its column types) is believed */
const TABLE_TTL_MS = 60_000;
/** the count of what a bridge held back is kept this long after the last time it held something back */
const HELD_BACK_TTL_SECONDS = 30 * 24 * 3600;

export interface TableRef {
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
}

interface Remembered {
  op: 'write' | 'delete';
  /** the row as it was written, or the identity a delete went by (row codec) — in Redis, under the master key */
  r: string;
  origins: string[];
}

/** what was announced for one write, so that it can be taken back if the write changed nothing */
export interface EchoReceipt {
  entries: Array<[key: string, value: string]>;
}

/**
 * how the rows are about to be written: `upsert` looks at what is there first;
 * `insert` has no key to look by; `delete` removes; `soft-delete` marks the row
 * (which the table's change log reports as an UPDATE, and is remembered as one)
 */
export type WriteMode = 'upsert' | 'insert' | 'delete' | 'soft-delete';

export interface Announcement {
  receipt: EchoReceipt | null;
  /** rows (by index) that are already exactly what would be written: not to be written */
  unchanged: Set<number>;
}

export interface EchoVerdict {
  /** this change is a write of this instance's coming back */
  echo: boolean;
  /** the tables it has been through; carried on with the row if it is passed on */
  origins: string[];
}

const NOTHING: EchoVerdict = { echo: false, origins: [] };

const sha = (text: string): string =>
  createHash('sha1').update(text).digest('hex');
/** a table, as it is named in keys and in a row's origins */
export const tableTag = (id: string): string => sha(id).slice(0, 16);

@Injectable()
export class EchoGuardService implements OnModuleDestroy {
  private readonly logger = new Logger('EchoGuard');
  private redis: Redis | null = null;
  private topology: {
    at: number;
    read: Set<string>;
    written: Set<string>;
  } | null = null;
  private readonly identities = new Map<string, { at: number; id: string }>();
  private readonly tableFacts = new Map<
    string,
    { at: number; primaryKey: string[]; kinds: Record<string, CompareKind> }
  >();
  /** echoes kept from going round again, per bridge, since this process started */
  private readonly dropped = new Map<string, number>();
  private readonly lastSaid = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    await redis?.quit().catch(() => undefined);
  }

  private get enabled(): boolean {
    return runtimeConfig.echoTtlSeconds > 0;
  }

  private client(): Redis {
    if (!this.redis) {
      this.redis = new Redis({
        ...redisConnectionOptions(),
        maxRetriesPerRequest: 1,
      });
      // said where it matters: a lookup that fails is a change that is delivered
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }

  /* ----- which table is which ----- */

  /**
   * a table as the SERVER knows it, not as a connection record names it: the
   * bridge that writes a table and the bridge that reads it usually go through
   * two different connections to the same database
   */
  async tableId(ref: TableRef): Promise<string> {
    const cacheKey = `${ref.connectionId}|${ref.database ?? ''}`;
    let base = this.identities.get(cacheKey);
    if (!base || Date.now() - base.at > TABLE_TTL_MS) {
      let id = `connection:${ref.connectionId}`;
      try {
        id = physicalId(
          await this.connections.resolve(ref.connectionId),
          ref.database,
        );
      } catch {
        /* a connection that cannot be resolved is only ever equal to itself */
      }
      base = { at: Date.now(), id };
      this.identities.set(cacheKey, base);
    }
    const schema =
      ref.schema || (base.id.startsWith('postgres://') ? 'public' : '');
    return `${base.id}#${schema}.${ref.table}`;
  }

  /**
   * the tables some live bridge READS, and the tables some bridge WRITES — a
   * loop needs a table that is both.
   *
   * a reader counts while it is listening, or stopped so recently that what is
   * remembered now will still be there when it picks its position up again.
   * one that has been stopped for longer would find nothing left whatever was
   * done here, so nothing is: no look before the write, nothing kept in Redis
   */
  private async tables(): Promise<{ read: Set<string>; written: Set<string> }> {
    if (this.topology && Date.now() - this.topology.at < TOPOLOGY_TTL_MS)
      return this.topology;
    const rows = await this.prisma.bridge.findMany({
      select: {
        id: true,
        enabled: true,
        sourceJson: true,
        destinationJson: true,
        triggerJson: true,
      },
    });
    const listening = new Set(
      (
        await this.prisma.bridgeJob.findMany({
          where: {
            OR: [
              {
                status: {
                  in: ['queued', 'running', 'canceling', 'interrupted'],
                },
              },
              {
                finishedAt: {
                  gte: new Date(
                    Date.now() - runtimeConfig.echoTtlSeconds * 1000,
                  ),
                },
              },
            ],
          },
          select: { bridgeId: true },
          distinct: ['bridgeId'],
        })
      ).map((job) => job.bridgeId),
    );
    const read = new Set<string>();
    const written = new Set<string>();
    for (const row of rows) {
      try {
        const source = JSON.parse(row.sourceJson) as {
          kind: string;
        } & TableRef;
        const trigger = row.triggerJson
          ? (JSON.parse(row.triggerJson) as { kind: string })
          : { kind: 'replay' };
        const destination = JSON.parse(row.destinationJson) as {
          kind: string;
          targets?: DatabaseTarget[];
        };
        if (
          row.enabled &&
          source.kind === 'table' &&
          trigger.kind !== 'replay' &&
          listening.has(row.id)
        )
          read.add(await this.tableId(source));
        if (destination.kind === 'database')
          for (const target of destination.targets ?? [])
            written.add(await this.tableId(target));
      } catch {
        /* a bridge whose JSON cannot be read takes part in no loop */
      }
    }
    this.topology = { at: Date.now(), read, written };
    return this.topology;
  }

  /** a bridge or a connection was saved or deleted, or a bridge began to listen: who reads and writes what may have changed */
  forget(): void {
    this.topology = null;
    this.identities.clear();
    this.tableFacts.clear();
  }

  /** the table's primary key, and what kind of value each of its columns holds */
  private async factsOf(
    ref: TableRef,
    id: string,
  ): Promise<{ primaryKey: string[]; kinds: Record<string, CompareKind> }> {
    const cached = this.tableFacts.get(id);
    if (cached && Date.now() - cached.at < TABLE_TTL_MS) return cached;
    const facts = {
      at: Date.now(),
      primaryKey: [] as string[],
      kinds: {} as Record<string, CompareKind>,
    };
    try {
      const engine = (await this.connections.get(ref.connectionId)).engine;
      const schema = await this.pool.withAdapter(
        ref.connectionId,
        ref.database,
        (a) => a.getSchema(ref.database),
      );
      const table = schema.namespaces
        .filter((n) => !ref.schema || n.name === ref.schema)
        .flatMap((n) => n.tables)
        .find((t) => t.name === ref.table);
      if (!table) return facts; // not there yet (a target a bridge is about to create): asked again
      facts.primaryKey = table.primaryKey;
      for (const column of table.columns) {
        try {
          facts.kinds[column.name] = parseColumnType(
            column.nativeType ?? column.dataType,
            engine,
          ).kind;
        } catch {
          /* compared by what the values are */
        }
      }
    } catch {
      // cannot be read just now: not remembered, so it is asked again
      return facts;
    }
    this.tableFacts.set(id, facts);
    return facts;
  }

  /* ----- the writing side ----- */

  /**
   * a bridge is ABOUT to write these rows (as they will be written: the target's
   * column names, converted values) to this target. said before the write, not
   * after it: the change can come back through the other bridge's stream within
   * a millisecond of the commit, and has to find this there when it does.
   *
   * only when some live bridge reads that table — otherwise nobody will ever ask,
   * and this costs the write nothing.
   *
   * `unchanged` are the rows (by index) that are already exactly this at the
   * target: the caller does not write them.
   */
  async announce(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
    written: readonly Row[],
    sourceRows: readonly Row[],
    mode: WriteMode,
  ): Promise<Announcement> {
    const silent: Announcement = { receipt: null, unchanged: new Set() };
    if (!this.enabled || written.length === 0 || bridge.source.kind !== 'table')
      return silent;
    try {
      const id = await this.tableId(target);
      if (!(await this.tables()).read.has(id)) return silent;
      const from = tableTag(await this.tableId(bridge.source));
      const { primaryKey, kinds } = await this.factsOf(target, id);
      const tag = tableTag(id);

      // what is there now: a row that will not change sends no change back
      const unchanged = new Set<number>();
      const quiet = new Set<number>();
      if (mode !== 'insert' && target.keyColumns.length > 0) {
        const there = await this.current(target, written, kinds).catch(
          () => null,
        );
        if (there) {
          written.forEach((row, i) => {
            const now = there.get(
              keyText(
                target.keyColumns.map((c) => row[c]),
                target.keyColumns.map((c) => kinds[c] ?? 'unknown'),
              ),
            );
            if (mode === 'upsert') {
              if (
                now &&
                Object.entries(row).every(([column, value]) =>
                  sameValue(kinds[column] ?? 'unknown', value, now[column]),
                )
              )
                unchanged.add(i);
            } else if (!now) {
              quiet.add(i); // nothing there to delete or to mark
            }
          });
        }
      }

      // from here on it is Redis. if THAT fails, what was just seen still
      // stands: the rows that are already right are not written — which is what
      // makes a change nobody recognises die out one hop later, and must not
      // depend on the thing that failed
      try {
        const receipt: EchoReceipt = { entries: [] };
        const pipeline = this.client().pipeline();
        written.forEach((row, i) => {
          if (unchanged.has(i) || quiet.has(i)) return;
          const entry: Remembered = {
            op: mode === 'delete' ? 'delete' : 'write',
            r: this.crypto.encrypt(encodeRows([compact(row)])),
            // where the row has been, plus where it was just read from
            origins: [...new Set([...originsOf(sourceRows[i] ?? {}), from])],
          };
          const value = JSON.stringify(entry);
          const key = keyOf(tag, row, primaryKey, kinds);
          pipeline.rpush(key, value);
          pipeline.ltrim(
            key,
            key.endsWith(UNKEYED) ? -PER_TABLE_UNKEYED : -PER_ROW,
            -1,
          );
          pipeline.expire(key, runtimeConfig.echoTtlSeconds);
          receipt.entries.push([key, value]);
        });
        if (receipt.entries.length > 0) await pipeline.exec();
        return { receipt, unchanged };
      } catch (err) {
        this.logger.debug(
          `could not announce a write: ${(err as Error).message}`,
        );
        return { receipt: null, unchanged };
      }
    } catch (err) {
      this.logger.debug(
        `could not announce a write: ${(err as Error).message}`,
      );
      return silent;
    }
  }

  /**
   * the rows a target holds under the keys of the rows about to be written, by
   * key text. one `IN` per key column narrows it down on the server (for a
   * composite key that is a superset); the exact match is made by the caller
   */
  private async current(
    target: DatabaseTarget,
    rows: readonly Row[],
    kinds: Record<string, CompareKind>,
  ): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const columns = target.keyColumns;
    const keys = rows
      .map((row) => columns.map((c) => row[c]))
      .filter((key) => key.every((v) => v !== null && v !== undefined));
    if (keys.length === 0) return out;
    const engine = (await this.connections.get(target.connectionId)).engine;
    const keyKinds = columns.map((c) => kinds[c] ?? 'unknown');
    const filters: FilterSpec[] = columns.map((column, i) => ({
      column,
      operator: 'in' as const,
      value: lookupValues(
        keys.map((key) => key[i]),
        engine,
      ),
    }));
    for (let offset = 0; ; ) {
      const page = await this.pool.withAdapter(
        target.connectionId,
        target.database,
        (a) =>
          a.browse({
            schema: target.schema,
            table: target.table,
            filters,
            sort: columns.map((column) => ({
              column,
              direction: 'asc' as const,
            })),
            limit: 1000,
            offset,
          }),
      );
      for (const row of page.rows)
        out.set(
          keyText(
            columns.map((c) => row[c]),
            keyKinds,
          ),
          row,
        );
      if (!page.hasMore || page.rows.length === 0) break;
      offset += page.rows.length;
    }
    return out;
  }

  /**
   * a bridge is about to EMPTY a target, as its source was emptied. two bridges
   * that mirror truncates to each other would otherwise empty each other's
   * tables for ever (PostgreSQL logs a TRUNCATE of an empty table too)
   */
  async announceTruncate(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
    sourceRow: Row | undefined,
  ): Promise<EchoReceipt | null> {
    if (!this.enabled || bridge.source.kind !== 'table') return null;
    try {
      const id = await this.tableId(target);
      if (!(await this.tables()).read.has(id)) return null;
      const from = tableTag(await this.tableId(bridge.source));
      const key = `${ECHO_KEY_PREFIX}${tableTag(id)}${TRUNCATES}`;
      const value = JSON.stringify({
        origins: [...new Set([...originsOf(sourceRow ?? {}), from])],
        n: randomUUID(),
      });
      await this.client()
        .pipeline()
        .rpush(key, value)
        .ltrim(key, -PER_ROW, -1)
        .expire(key, runtimeConfig.echoTtlSeconds)
        .exec();
      return { entries: [[key, value]] };
    } catch (err) {
      this.logger.debug(
        `could not announce a truncate: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** the source table was emptied: by this instance (another bridge mirroring a truncate), or by somebody? */
  async recogniseTruncate(bridge: ResolvedBridge): Promise<EchoVerdict> {
    if (!this.enabled || bridge.source.kind !== 'table') return NOTHING;
    try {
      const id = await this.tableId(bridge.source);
      if (!(await this.tables()).written.has(id)) return NOTHING;
      const text = await this.client().lpop(
        `${ECHO_KEY_PREFIX}${tableTag(id)}${TRUNCATES}`,
      );
      if (!text) return NOTHING;
      return {
        echo: true,
        origins: (JSON.parse(text) as { origins: string[] }).origins,
      };
    } catch (err) {
      this.logger.debug(
        `could not look a truncate up: ${(err as Error).message}`,
      );
      return NOTHING;
    }
  }

  /**
   * the write failed, or changed nothing (the rows were already what it set
   * them to, the row to delete was not there): no change will come back, and
   * what was announced would sit there waiting to be mistaken for somebody's
   */
  async retract(receipt: EchoReceipt | null): Promise<void> {
    if (!receipt?.entries.length) return;
    try {
      const pipeline = this.client().pipeline();
      for (const [key, value] of receipt.entries) pipeline.lrem(key, -1, value);
      await pipeline.exec();
    } catch (err) {
      this.logger.debug(
        `could not take an announcement back: ${(err as Error).message}`,
      );
    }
  }

  /* ----- the reading side ----- */

  /**
   * is this change — read from `bridge`'s source — a write of this instance's
   * coming back? `primaryKey` is the source table's. a match is CONSUMED: the
   * next change of that row is compared with what was written after it
   */
  async recognise(
    bridge: ResolvedBridge,
    change: { op: CdcOperation | undefined; row: Row },
    primaryKey: readonly string[] | null | undefined,
  ): Promise<EchoVerdict> {
    if (
      !this.enabled ||
      bridge.source.kind !== 'table' ||
      change.op === 'truncate'
    )
      return NOTHING;
    try {
      const id = await this.tableId(bridge.source);
      if (!(await this.tables()).written.has(id)) return NOTHING;
      const facts = await this.factsOf(bridge.source, id);
      const kinds = facts.kinds;
      const tag = tableTag(id);
      const client = this.client();

      const keyed = keyOf(
        tag,
        change.row,
        primaryKey?.length ? primaryKey : facts.primaryKey,
        kinds,
      );
      if (!keyed.endsWith(UNKEYED)) {
        const entries = await client.lrange(keyed, 0, -1);
        for (const [i, text] of entries.entries()) {
          const entry = this.open(text);
          if (!entry || !matches(entry, change, kinds)) continue;
          // it, and whatever was written to the row before it: a reader that
          // polls sees only the last of several writes, and a stream has
          // already been past the earlier ones
          await client.ltrim(keyed, i + 1, -1);
          return { echo: true, origins: entry.origins };
        }
      }
      // written without the table's own key (the bridge is keyed on something
      // else, or the table has none): looked for among the table's unkeyed writes
      const loose = await client.lrange(
        `${ECHO_KEY_PREFIX}${tag}${UNKEYED}`,
        0,
        -1,
      );
      for (const text of loose) {
        const entry = this.open(text);
        if (!entry || !matches(entry, change, kinds, true)) continue;
        await client.lrem(`${ECHO_KEY_PREFIX}${tag}${UNKEYED}`, 1, text);
        return { echo: true, origins: entry.origins };
      }
      return NOTHING;
    } catch (err) {
      this.logger.debug(
        `could not look a change up: ${(err as Error).message}`,
      );
      return NOTHING;
    }
  }

  /**
   * an entry as it was remembered, its row readable again. the row is kept
   * under the master key: it is somebody's data, and Syncle's Redis is not
   * where that is otherwise found. null = not readable (the key was changed and
   * the old one taken away within the last few minutes): it matches nothing
   */
  private open(text: string): Remembered | null {
    try {
      const entry = JSON.parse(text) as Remembered;
      return { ...entry, r: this.crypto.decrypt(entry.r) };
    } catch {
      return null;
    }
  }

  /**
   * what to do with a change that was recognised. 'drop' = every table this
   * bridge would write it to is one it has already been through: it is the loop
   * closing, and the change is not sent round again
   */
  async route(
    bridge: ResolvedBridge,
    verdict: EchoVerdict,
  ): Promise<'drop' | 'forward'> {
    if (!verdict.echo || bridge.destination.kind !== 'database')
      return 'forward';
    const targets = bridge.destination.targets;
    if (targets.length === 0) return 'forward';
    const been = new Set(verdict.origins);
    for (const target of targets)
      if (!been.has(tableTag(await this.tableId(target)))) return 'forward';
    this.count(bridge);
    return 'drop';
  }

  private count(bridge: ResolvedBridge): void {
    this.dropped.set(bridge.id, (this.dropped.get(bridge.id) ?? 0) + 1);
    // …and where every process can read it: the page is answered by whichever
    // process the request reaches, which is not always the one that reads the bridge
    const key = `${ECHO_KEY_PREFIX}held:${bridge.id}`;
    try {
      void this.client()
        .pipeline()
        .incr(key)
        .expire(key, HELD_BACK_TTL_SECONDS)
        .exec()
        .catch(() => undefined);
    } catch {
      /* a count that could not be kept is not a reason to deliver an echo */
    }
    const last = this.lastSaid.get(bridge.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.lastSaid.set(bridge.id, Date.now());
    this.logger.log(
      `Bridge "${bridge.name}" reads a table that another bridge writes: changes this instance wrote there are recognised and not sent back (${this.dropped.get(bridge.id)} so far).`,
    );
  }

  /**
   * who a bridge is tied to: the bridges that write the table it reads, and the
   * live bridges that read a table it writes (itself included, if it writes
   * what it reads)
   */
  async status(bridge: ResolvedBridge): Promise<BridgeLoopStatus> {
    const status: BridgeLoopStatus = {
      guard: this.enabled,
      fedBy: [],
      feeds: [],
      heldBack: await this.heldBack(bridge.id),
    };
    const mine =
      bridge.source.kind === 'table' ? await this.tableId(bridge.source) : null;
    const written = new Set<string>();
    if (bridge.destination.kind === 'database')
      for (const target of bridge.destination.targets)
        written.add(await this.tableId(target));
    if (!mine && written.size === 0) return status;

    const rows = await this.prisma.bridge.findMany({
      select: {
        id: true,
        name: true,
        enabled: true,
        sourceJson: true,
        destinationJson: true,
        triggerJson: true,
      },
      orderBy: { name: 'asc' },
    });
    for (const row of rows) {
      try {
        const source = JSON.parse(row.sourceJson) as {
          kind: string;
        } & TableRef;
        const trigger = row.triggerJson
          ? (JSON.parse(row.triggerJson) as { kind: string })
          : { kind: 'replay' };
        const destination = JSON.parse(row.destinationJson) as {
          kind: string;
          targets?: DatabaseTarget[];
        };
        const peer = { bridgeId: row.id, name: row.name };
        if (mine && destination.kind === 'database') {
          for (const target of destination.targets ?? []) {
            if ((await this.tableId(target)) !== mine) continue;
            status.fedBy.push(peer);
            break;
          }
        }
        if (
          row.enabled &&
          source.kind === 'table' &&
          trigger.kind !== 'replay' &&
          written.has(await this.tableId(source))
        )
          status.feeds.push(peer);
      } catch {
        /* a bridge whose JSON cannot be read is tied to nothing */
      }
    }
    return status;
  }

  /** how many changes THIS process has recognised as this instance's own and not sent round again */
  droppedBy(bridgeId: string): number {
    return this.dropped.get(bridgeId) ?? 0;
  }

  /** …and how many every process has, together (kept in Redis; this process's own count if that cannot be read) */
  private async heldBack(bridgeId: string): Promise<number> {
    try {
      const text = await this.client().get(
        `${ECHO_KEY_PREFIX}held:${bridgeId}`,
      );
      return Math.max(Number(text ?? 0) || 0, this.droppedBy(bridgeId));
    } catch {
      return this.droppedBy(bridgeId);
    }
  }
}

const UNKEYED = ':rows';
const TRUNCATES = ':truncates';

/** where a row's writes are remembered: under its primary key, or — without one — with the table's other unkeyed rows */
function keyOf(
  tag: string,
  row: Row,
  primaryKey: readonly string[],
  kinds: Record<string, CompareKind>,
): string {
  if (primaryKey.length > 0) {
    const key = primaryKey.map((c) => row[c]);
    if (key.every((v) => v !== undefined && v !== null && v !== UNCHANGED)) {
      return `${ECHO_KEY_PREFIX}${tag}:k:${sha(
        keyText(
          key,
          primaryKey.map((c) => kinds[c] ?? 'unknown'),
        ),
      )}`;
    }
  }
  return `${ECHO_KEY_PREFIX}${tag}${UNKEYED}`;
}

/** values longer than this are remembered by their digest: what is kept per written row stays small */
const LARGE = 2048;

/** the bytes of a large text or binary value, or null for anything else */
function largeBytes(value: unknown): Buffer | null {
  if (typeof value === 'string')
    return value.length > LARGE ? Buffer.from(value, 'utf8') : null;
  if (value instanceof Uint8Array)
    return value.length > LARGE ? Buffer.from(value) : null;
  return null;
}

const digestOf = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** a row as it is remembered: a document or a file in a column is kept as its SHA-256, not whole */
export function compact(row: Row): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(row)) {
    const bytes = largeBytes(value);
    out[column] = bytes ? { [DIGEST]: digestOf(bytes) } : value;
  }
  return out;
}

const DIGEST = '$syncle.sha256';
const digestIn = (value: unknown): string | null =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as Record<string, unknown>)[DIGEST] === 'string'
    ? ((value as Record<string, unknown>)[DIGEST] as string)
    : null;

/**
 * is the change that was read the write that was remembered? every column that
 * was WRITTEN has to read the same (kind-aware: 1 and '1.00' are one number).
 * columns the bridge did not write are not looked at — it cannot know them.
 *
 * `strict`: the entry was not found by key, so the columns themselves have to
 * say it is the same row — a delete has to carry every column it went by.
 */
export function matches(
  entry: { op: 'write' | 'delete'; r: string },
  change: { op: CdcOperation | undefined; row: Row },
  kinds: Record<string, CompareKind>,
  strict = false,
): boolean {
  if ((entry.op === 'delete') !== (change.op === 'delete')) return false;
  const [written] = decodeRows(entry.r);
  if (!written) return false;
  let compared = 0;
  for (const [column, value] of Object.entries(written)) {
    const read = change.row[column];
    // a large value PostgreSQL left out because the UPDATE did not touch it: it cannot differ
    if (read === UNCHANGED) continue;
    // a delete says which row went, and often nothing else
    if (entry.op === 'delete' && read === undefined) {
      if (strict) return false;
      continue;
    }
    const digest = digestIn(value);
    if (digest !== null) {
      const bytes = largeBytes(read);
      if (!bytes || digestOf(bytes) !== digest) return false;
    } else if (!sameValue(kinds[column] ?? 'unknown', value, read))
      return false;
    compared++;
  }
  return strict ? compared > 0 : true;
}

/** the server and database a connection leads to, whatever the connection is called */
export function physicalId(conn: ConnectionConfig, database?: string): string {
  let host = conn.host ?? '';
  let port = conn.port ?? 0;
  let db = database ?? conn.database ?? '';
  if (conn.connectionString) {
    try {
      const url = new URL(conn.connectionString);
      host = url.hostname || host;
      port = Number(url.port) || port;
      db = database ?? (url.pathname.replace(/^\//, '') || db);
    } catch {
      /* not a URL: what the fields say */
    }
  }
  if (conn.engine === 'sqlite') return `sqlite://${conn.database ?? ''}`;
  // a Redis database is a number, and a connection carries it among its options
  if (conn.engine === 'redis' && database === undefined) {
    const index = (conn.options as { db?: unknown } | undefined)?.db;
    if (index !== undefined && index !== null && index !== '')
      db = String(index);
    else if (!db) db = '0';
  }
  // the same server is often reached under more than one name from one machine
  const normal = ['localhost', '::1', '0.0.0.0'].includes(host.toLowerCase())
    ? '127.0.0.1'
    : host.toLowerCase();
  const via = conn.ssh?.host ? `@${conn.ssh.host.toLowerCase()}` : '';
  return `${conn.engine}://${normal}:${port}${via}/${db}`;
}
