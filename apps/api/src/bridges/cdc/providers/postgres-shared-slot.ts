/**
 * One PostgreSQL replication slot for MANY bridges.
 *
 * A bridge with a slot of its own costs its source a slot, a walsender, a
 * connection and one full decoding of the WAL. A server allows ten slots and
 * ten senders by default, and every slot pins WAL by itself: thirty tables are
 * thirty of each. A bridge whose trigger says `slot: 'shared'` reads instead
 * through one slot per source connection and database, which every such bridge
 * there shares — one stream, decoded once, each change handed to the bridges
 * whose table it belongs to.
 *
 * What makes that safe:
 *
 *  - a change's cursor is read off the WAL (commit LSN, change LSN, ordinal), so
 *    it is the SAME cursor for every member. each member keeps its own
 *    watermark, and a transaction the server sends again is dropped per member
 *  - the slot is confirmed only up to the SLOWEST member — including members
 *    that are not running. each member's confirmed position is kept in the
 *    metadata store (`cdc_shared_members`) so that it outlives the process; a
 *    member that is stopped holds WAL for all of them until it is started,
 *    deleted, or given up by the source guard
 *  - a member joins through a barrier. adding a table to a publication of a
 *    slot that already exists has no "consistent point": a transaction that
 *    changed the table BEFORE it was published and commits after would be
 *    neither in the copy nor in the stream. so after the table is added, the
 *    join waits for every transaction that was open at that moment to end, and
 *    only then takes the member's starting position (which is what creating a
 *    slot does for a bridge that has its own)
 *  - one publication per SET OF OPERATIONS. a publication that publishes
 *    updates makes PostgreSQL refuse UPDATEs on a table that has no replica
 *    identity — whoever reads them. an insert-only member must never impose
 *    that on somebody's table because another member wants updates
 *  - those publications are a FIXED set, created BEFORE the slot and never
 *    after. pgoutput looks a publication up as the catalog was at the time of
 *    the change it is decoding, and fails the whole stream with `publication
 *    "x" does not exist` for a change older than the publication. a shared
 *    slot is often held back (that is the point of confirming the slowest), so
 *    a publication made when a member joins would be younger than changes the
 *    slot still has to decode. tables are added to and taken out of the fixed
 *    set; the set itself only goes with the slot
 *
 * A member that joins or resumes restarts the stream: the server sends again
 * from the slowest member's position, and the others drop what they have had.
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestError,
  type CdcOperation,
  type ConnectionConfig,
} from '@syncle/core';
import {
  LogicalReplicationService,
  PgoutputPlugin,
} from 'pg-logical-replication';
import { PrismaService } from '../../../common/prisma.service';
import { runtimeConfig } from '../../../common/runtime-config';
import { AdapterPoolService } from '../../../connections/adapter-pool.service';
import type { ResolvedBridge } from '../../bridges.types';
import {
  backoffMs,
  delay,
  type CdcChange,
  type CdcSourceHold,
  type CdcStreamContext,
  type CdcStreamHandle,
} from '../cdc-provider';
import {
  lsnAfter,
  lsnForClient,
  normalizeLsn,
  parsePgCursor,
  present,
  sameValue,
  withUnchanged,
} from './postgres-lsn';

type TableSource = Extract<ResolvedBridge['source'], { kind: 'table' }>;

interface Member {
  bridgeId: string;
  schema: string;
  table: string;
  ops: Set<CdcOperation>;
  handlers: CdcStreamContext['handlers'];
  /** the highest cursor handed to this member: anything at or before it has been had */
  highest: string | null;
  /** the WAL position up to which this member has everything durably (H/L) */
  confirmed: string;
  persistedAt: number;
  /**
   * the first reader that may hand this member anything. a member joins while a
   * reader is running that is already further along than the member's own
   * position: one change from THAT reader would put the member's watermark
   * beyond changes it has not had, and the reader that is started for it
   * afterwards — from further back — would see them dropped as duplicates
   */
  since: number;
}

/** every set of operations a member can publish: one publication each, all made with the slot */
export const OPS_CODES = ['i', 'u', 'd', 'iu', 'id', 'ud', 'iud', 'n'] as const;

/** `iud`, `i`, `id` …: the operations a member publishes, as its publication's suffix. truncate is always published */
export function opsCode(operations: readonly CdcOperation[]): string {
  return (
    (['insert', 'update', 'delete'] as const)
      .filter((op) => operations.includes(op))
      .map((op) => op[0])
      .join('') || 'n'
  );
}

const lsnNumber = (lsn: string): bigint => {
  const [h, l] = lsn.split('/');
  return (BigInt(`0x${h}`) << 32n) | BigInt(`0x${l}`);
};
const lsnMin = (a: string, b: string): string =>
  lsnNumber(a) <= lsnNumber(b) ? a : b;
const lsnMax = (a: string, b: string): string =>
  lsnNumber(a) >= lsnNumber(b) ? a : b;

const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** everything a stream needs that is not the members */
interface StreamSetup {
  key: string;
  slot: string;
  clientConfig: Record<string, unknown>;
}

class SharedStream {
  readonly members = new Map<string, Member>();
  /** members of this slot that are NOT running here, and where each of them stands */
  private idle = new Map<string, string>();
  private current: LogicalReplicationService | null = null;
  private generation = 0;
  private running: Promise<void> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private closed = false;
  private attempt = 0;
  private cycle: NodeJS.Timeout | null = null;

  constructor(
    private readonly setup: StreamSetup,
    private readonly owner: PgSharedSlotService,
    private readonly logger: Logger,
  ) {}

  /** the position the SERVER may be told: the slowest of everybody, running or not */
  private floor(): string | null {
    let min: string | null = null;
    for (const m of this.members.values())
      min = min ? lsnMin(min, m.confirmed) : m.confirmed;
    for (const [id, lsn] of this.idle)
      if (!this.members.has(id)) min = min ? lsnMin(min, lsn) : lsn;
    return min;
  }

  async refreshIdle(): Promise<void> {
    this.idle = await this.owner.positions(this.setup.key);
  }

  private confirm(): void {
    const floor = this.floor();
    const at = floor && lsnForClient(floor);
    if (at) void this.current?.acknowledge(at).catch(() => undefined);
  }

  /** a member starts, or starts again: it is read for from its own position on, by a reader of its own time */
  async add(member: Member): Promise<void> {
    member.since = this.generation + 1;
    this.members.set(member.bridgeId, member);
    await this.restart();
  }

  /**
   * read again from the slowest member's position. what the reader that is
   * running hands out stops counting AT ONCE (its generation is over); the
   * reader itself is replaced a moment later, so that thirty members resuming
   * together are one restart and not thirty
   */
  async restart(): Promise<void> {
    await this.refreshIdle();
    this.generation++;
    this.attempt = 0;
    if (this.cycle || this.closed) return;
    this.cycle = setTimeout(() => {
      this.cycle = null;
      if (this.closed) return;
      const old = this.current;
      this.current = null;
      void old?.stop().catch(() => undefined);
      if (!this.running)
        this.running = this.run().finally(() => (this.running = null));
    }, 100);
  }

  async remove(bridgeId: string): Promise<void> {
    const member = this.members.get(bridgeId);
    if (!member) return;
    this.members.delete(bridgeId);
    await this.owner.persist(member, true);
    await this.refreshIdle();
    if (this.members.size === 0) await this.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.cycle) clearTimeout(this.cycle);
    this.cycle = null;
    this.generation++;
    const old = this.current;
    this.current = null;
    await old?.stop().catch(() => undefined);
    await this.running?.catch(() => undefined);
    this.owner.forget(this.setup.key, this);
  }

  async ack(member: Member, cursor: string): Promise<void> {
    // a position INSIDE a transaction confirms nothing (see the provider's own `ack`)
    const confirmed = parsePgCursor(cursor)?.ack;
    if (!confirmed) return;
    member.confirmed = lsnMax(member.confirmed, confirmed);
    await this.owner.persist(member, false);
    this.confirm();
  }

  private async run(): Promise<void> {
    while (!this.closed && this.members.size > 0) {
      const generation = this.generation;
      // nothing of the previous reader may still be on its way to a member
      await this.inflight.catch(() => undefined);
      // all of the fixed set, always: which of them a table is in decides what is sent
      const plugin = new PgoutputPlugin({
        protoVersion: 1,
        publicationNames: OPS_CODES.map((code) =>
          this.owner.pubName(this.setup.key, code),
        ),
      });
      const service = this.makeService(generation);
      this.current = service;
      try {
        await service.subscribe(plugin, this.setup.slot);
        if (this.closed || generation !== this.generation) continue;
        await delay(backoffMs(this.attempt++)); // the server closed it: again
      } catch (err) {
        if (this.closed || generation !== this.generation) continue;
        const error = new Error(
          `replication stream error: ${(err as Error).message}`,
        );
        for (const m of this.members.values()) m.handlers.onError(error);
        await delay(backoffMs(this.attempt++));
      } finally {
        await service.stop().catch(() => undefined);
      }
    }
  }

  private makeService(generation: number): LogicalReplicationService {
    // see the provider's own stream for why acknowledging is manual and the timer is off
    const service = new LogicalReplicationService(this.setup.clientConfig, {
      acknowledge: { auto: false, timeoutSeconds: 0 },
      flowControl: { enabled: true },
    });
    let txn: { commit: string; lsn: string; shared: number } | null = null;

    /** hand something to the members it concerns, in order, each once */
    const each = async (
      cursor: string,
      pick: (m: Member) => boolean,
      deliver: (m: Member) => Promise<void>,
    ): Promise<void> => {
      for (const member of [...this.members.values()]) {
        if (member.since > generation) continue; // joined after this reader began: not this reader's to serve
        if (!pick(member) || !lsnAfter(cursor, member.highest)) continue;
        member.highest = cursor;
        try {
          await deliver(member);
        } catch (err) {
          // one member's trouble is not the others'. it has NOT had this change,
          // so it is given nothing further: it stops where it last confirmed, and
          // is told. (the orchestrator's handlers do not throw; this is the net)
          this.members.delete(member.bridgeId);
          await this.owner.persist(member, true);
          await this.refreshIdle();
          const message = `the shared change stream stopped delivering to this bridge: ${(err as Error).message}`;
          if (member.handlers.onFatal)
            await member.handlers.onFatal(message).catch(() => undefined);
          else member.handlers.onError(new Error(message));
        }
      }
    };

    service.on('data', (lsn: string, msg: PgMessage) => {
      const work = (async () => {
        if (generation !== this.generation) return; // a reader that has been replaced
        this.attempt = 0;
        if (msg.tag === 'begin') {
          txn = msg.commitLsn
            ? { commit: normalizeLsn(msg.commitLsn), lsn: '', shared: 0 }
            : null;
          return;
        }
        if (msg.tag === 'commit') {
          const commit = msg.commitLsn
            ? normalizeLsn(msg.commitLsn)
            : txn?.commit;
          txn = null;
          if (!commit) return;
          // the end of a transaction is EVERY member's to pass: a member whose
          // table it did not touch would otherwise never move, and hold the slot
          const cursor = `${commit}#c:${normalizeLsn(msg.commitEndLsn ?? lsn)}`;
          await each(
            cursor,
            () => true,
            (m) => m.handlers.onSkip?.(cursor) ?? Promise.resolve(),
          );
          return;
        }
        // each call is the position of one emitted change — the same sequence
        // whoever the members are, so that a cursor means the same to all
        const at = (): string => {
          if (!txn) return lsn;
          txn.shared = txn.lsn === lsn ? txn.shared + 1 : 0;
          txn.lsn = lsn;
          return `${txn.commit}#${lsn}.${txn.shared}`;
        };

        if (msg.tag === 'truncate') {
          const cursor = at();
          const touched = (m: Member) =>
            (msg.relations ?? []).some(
              (r) => r?.name === m.table && r?.schema === m.schema,
            );
          await each(cursor, touched, async (m) => {
            if (m.ops.has('truncate'))
              return m.handlers.onChange({ op: 'truncate', row: {}, cursor });
            if (!m.handlers.onNotice) return m.handlers.onSkip?.(cursor);
            return m.handlers.onNotice(
              `${m.schema}.${m.table} was TRUNCATEd at the source. That was not applied to the destination, ` +
                'which still holds the rows: this bridge does not capture truncates. ' +
                'Add "truncate" to its operations to mirror them.',
              cursor,
            );
          });
          return;
        }
        if (
          msg.tag !== 'insert' &&
          msg.tag !== 'update' &&
          msg.tag !== 'delete'
        )
          return;
        const relation = msg.relation;
        const op = msg.tag as CdcOperation;
        const mine = (m: Member) =>
          !!relation &&
          relation.name === m.table &&
          relation.schema === m.schema;

        if (msg.tag === 'delete') {
          const cursor = at();
          const row = present(msg.old ?? msg.key ?? {});
          await each(cursor, mine, (m) =>
            m.ops.has(op)
              ? m.handlers.onChange({ op: 'delete', row, cursor })
              : (m.handlers.onSkip?.(cursor) ?? Promise.resolve()),
          );
          return;
        }
        // an UPDATE that changes the row's key is the row MOVING: the old one goes first
        let keyChanged = false;
        if (msg.tag === 'update' && relation) {
          const before = msg.key ?? msg.old;
          const moved =
            !!before &&
            (relation.keyColumns ?? []).some(
              (c) =>
                before[c] !== undefined && !sameValue(before[c], msg.new?.[c]),
            );
          if (moved) {
            const cursor = at();
            const row = present(before);
            await each(
              cursor,
              (m) => mine(m) && m.ops.has('update'),
              (m) => m.handlers.onChange({ op: 'delete', row, cursor }),
            );
            keyChanged = true;
          }
        }
        const cursor = at();
        const change: CdcChange = {
          op,
          row: withUnchanged(msg.new ?? {}),
          cursor,
          ...(keyChanged ? { keyChanged } : {}),
        };
        await each(cursor, mine, (m) =>
          m.ops.has(op)
            ? m.handlers.onChange(change)
            : (m.handlers.onSkip?.(cursor) ?? Promise.resolve()),
        );
      })();
      this.inflight = work.catch(() => undefined);
      return work;
    });

    // an idle stream is answered with what may be confirmed, or the server's timeout ends it
    service.on(
      'heartbeat',
      (_lsn: string, _ts: number, shouldRespond: boolean) => {
        if (shouldRespond && generation === this.generation) this.confirm();
      },
    );
    service.on('error', (err: Error) => {
      if (generation !== this.generation) return;
      this.logger.debug(`shared slot ${this.setup.slot}: ${err.message}`);
    });
    return service;
  }
}

interface PgMessage {
  tag: string;
  commitLsn?: string;
  commitEndLsn?: string;
  relation?: { name: string; schema: string; keyColumns?: string[] };
  relations?: Array<{ name: string; schema: string } | undefined>;
  new?: Record<string, unknown>;
  old?: Record<string, unknown> | null;
  key?: Record<string, unknown> | null;
}

@Injectable()
export class PgSharedSlotService {
  private readonly logger = new Logger('BridgeCdc:pg-shared');
  private readonly streams = new Map<string, SharedStream>();
  /** joins and leaves of one slot happen one at a time */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pool: AdapterPoolService,
  ) {}

  /* ----- names ----- */

  keyOf(src: Pick<TableSource, 'connectionId' | 'database'>): string {
    return createHash('sha256')
      .update(`${src.connectionId}\u0000${src.database ?? ''}`)
      .digest('hex')
      .slice(0, 16);
  }
  slotName(key: string): string {
    return `syncle_shared_${key}`;
  }
  pubName(key: string, ops: string): string {
    return `syncle_sp_${key}_${ops}`;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /* ----- the store ----- */

  /** where every member of a slot stands, by bridge id */
  async positions(key: string): Promise<Map<string, string>> {
    const rows = await this.prisma.cdcSharedMember.findMany({
      where: { slotKey: key },
      select: { bridgeId: true, confirmedLsn: true },
    });
    return new Map(rows.map((r) => [r.bridgeId, r.confirmedLsn]));
  }

  /** a member's position is written at most once a second while it runs, and always when it stops */
  async persist(member: Member, force: boolean): Promise<void> {
    if (!force && Date.now() - member.persistedAt < 1000) return;
    member.persistedAt = Date.now();
    await this.prisma.cdcSharedMember
      .updateMany({
        where: { bridgeId: member.bridgeId },
        data: { confirmedLsn: member.confirmed },
      })
      .catch((err) =>
        this.logger.warn(
          `could not save the position of ${member.bridgeId}: ${(err as Error).message}`,
        ),
      );
  }

  forget(key: string, stream: SharedStream): void {
    if (this.streams.get(key) === stream) this.streams.delete(key);
  }

  /* ----- joining and leaving ----- */

  /**
   * make this bridge a member: the slot and its publications exist, its table is
   * published under its set of operations, and — for a member that is new — a
   * starting position has been taken behind the barrier. idempotent: a member
   * that is one already keeps its position, also when its table or operations
   * have changed (as a bridge with a slot of its own does)
   */
  join(
    bridgeId: string,
    bridge: ResolvedBridge,
    serverVersion: number,
  ): Promise<void> {
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc')
      return Promise.resolve();
    const src = bridge.source;
    const operations = bridge.trigger.operations;
    const key = this.keyOf(src);
    return this.serial(key, async () => {
      const schema = src.schema || 'public';
      const ops = opsCode(operations);
      const existing = await this.prisma.cdcSharedMember.findUnique({
        where: { bridgeId },
      });
      // a row of ANOTHER slot is a bridge that has moved: here it is new
      const was = existing && existing.slotKey === key ? existing : null;

      await this.pool.withAdapter(src.connectionId, src.database, async (a) => {
        const slot = this.slotName(key);
        await this.ensureSlot(a, key, serverVersion);

        if (was) {
          if (
            was.schemaName === schema &&
            was.tableName === src.table &&
            was.ops === ops
          ) {
            await this.publish(a, key, ops, schema, src.table); // (put back if somebody took it out)
            return;
          }
          await this.publish(a, key, ops, schema, src.table);
          await this.prisma.cdcSharedMember.update({
            where: { bridgeId },
            data: { schemaName: schema, tableName: src.table, ops },
          });
          await this.unpublish(a, key, was.ops, was.schemaName, was.tableName);
          return;
        }

        // held from HERE on: whatever the running stream confirms while the
        // barrier is waited for, it is not beyond what this member will need
        const floor = await a.query(
          `select confirmed_flush_lsn::text as lsn from pg_replication_slots where slot_name = $1`,
          [slot],
        );
        const provisional = normalizeLsn(String(floor.rows[0]?.lsn ?? '0/0'));
        const data = {
          slotKey: key,
          schemaName: schema,
          tableName: src.table,
          ops,
          confirmedLsn: provisional,
        };
        await this.prisma.cdcSharedMember.upsert({
          where: { bridgeId },
          create: { bridgeId, ...data },
          update: data,
        });
        await this.streams.get(key)?.refreshIdle();
        try {
          // a table that was already published has no gap to close
          if (await this.publish(a, key, ops, schema, src.table))
            await this.barrier(a);
          const now = await a.query(`select pg_current_wal_lsn()::text as lsn`);
          await this.prisma.cdcSharedMember.update({
            where: { bridgeId },
            data: { confirmedLsn: normalizeLsn(String(now.rows[0]?.lsn)) },
          });
          await this.streams.get(key)?.refreshIdle();
        } catch (err) {
          // not a member after all: nothing of it may stay behind to hold the slot
          await this.prisma.cdcSharedMember
            .delete({ where: { bridgeId } })
            .catch(() => undefined);
          await this.unpublish(a, key, ops, schema, src.table).catch(
            () => undefined,
          );
          await this.streams.get(key)?.refreshIdle();
          throw err;
        }
      });
    });
  }

  /**
   * the fixed set of publications, THEN the slot: a publication has to be older
   * than every change the slot will ever decode (see the top of this file)
   */
  private async ensureSlot(
    a: Adapter,
    key: string,
    serverVersion: number,
  ): Promise<void> {
    const have = await a.query(
      `select pubname from pg_publication where pubname like $1`,
      [`syncle\\_sp\\_${key}\\_%`],
    );
    const names = new Set(have.rows.map((r) => String(r.pubname)));
    for (const code of OPS_CODES) {
      const pub = this.pubName(key, code);
      if (names.has(pub)) continue;
      const publish = [
        ...(code === 'n'
          ? []
          : [...code].map(
              (c) => ({ i: 'insert', u: 'update', d: 'delete' })[c]!,
            )),
        'truncate',
      ].join(', ');
      const options =
        `publish = '${publish}'` +
        (serverVersion >= 130000 ? ', publish_via_partition_root = true' : '');
      await a.query(`CREATE PUBLICATION ${quote(pub)} WITH (${options})`);
    }
    const slot = this.slotName(key);
    const hasSlot = await a.query(
      `select 1 from pg_replication_slots where slot_name = $1`,
      [slot],
    );
    if (hasSlot.rows.length === 0)
      await a.query(
        `select pg_create_logical_replication_slot($1, 'pgoutput')`,
        [slot],
      );
  }

  /** the table is in the publication for this set of operations. true = it was not before */
  private async publish(
    a: Adapter,
    key: string,
    ops: string,
    schema: string,
    table: string,
  ): Promise<boolean> {
    const pub = this.pubName(key, ops);
    const has = await a.query(
      `select 1 from pg_publication_tables where pubname = $1 and schemaname = $2 and tablename = $3`,
      [pub, schema, table],
    );
    if (has.rows.length > 0) return false;
    await a.query(
      `ALTER PUBLICATION ${quote(pub)} ADD TABLE ${quote(schema)}.${quote(table)}`,
    );
    return true;
  }

  /** out of the publication again, unless another member reads the same table with the same operations */
  private async unpublish(
    a: Adapter,
    key: string,
    ops: string,
    schema: string,
    table: string,
  ): Promise<void> {
    const others = await this.prisma.cdcSharedMember.count({
      where: { slotKey: key, ops, schemaName: schema, tableName: table },
    });
    if (others > 0) return;
    await a
      .query(
        `ALTER PUBLICATION ${quote(this.pubName(key, ops))} DROP TABLE ${quote(schema)}.${quote(table)}`,
      )
      .catch(() => undefined);
  }

  /**
   * wait until every transaction that was open when the table was published has
   * ended. one of them may have changed the table BEFORE it was published: that
   * change is in no stream, so it has to be in the table by the time the
   * member's position is taken (and its copy, if it makes one, begins)
   */
  private async barrier(a: Adapter): Promise<void> {
    const at = await a.query(
      `select txid_snapshot_xmax(txid_current_snapshot())::text as xmax`,
    );
    const xmax = BigInt(String(at.rows[0]?.xmax ?? '0'));
    const deadline = Date.now() + runtimeConfig.sharedSlotJoinWaitMs;
    for (;;) {
      const now = await a.query(
        `select txid_snapshot_xmin(txid_current_snapshot())::text as xmin`,
      );
      if (BigInt(String(now.rows[0]?.xmin ?? '0')) >= xmax) return;
      if (Date.now() > deadline) {
        const blockers = await a
          .query(
            `select pid, coalesce(usename, '') as usename, coalesce(application_name, '') as app, (now() - xact_start)::text as open_for
             from pg_stat_activity where backend_xid is not null and pid <> pg_backend_pid() order by xact_start limit 3`,
          )
          .catch(() => ({ rows: [] as Record<string, unknown>[] }));
        const who = blockers.rows
          .map(
            (r) =>
              `pid ${String(r.pid)} (${String(r.usename)}${r.app ? `, ${String(r.app)}` : ''}, open for ${String(r.open_for)})`,
          )
          .join('; ');
        throw new BadRequestError(
          'This bridge could not join the shared replication slot: a transaction that was open on the source when its table was published has still not ended, ' +
            `and what it changed before that moment is in no stream. ${who ? `Waiting for: ${who}. ` : ''}Start the bridge again when it has.`,
          { reason: 'shared-slot-busy' },
        );
      }
      await delay(200);
    }
  }

  /**
   * no longer a member: nothing of this bridge holds the slot any more. the last
   * member to leave takes the slot and the publications with it. THROWS when the
   * slot could not be dropped (the caller queues it and tries again)
   */
  leave(bridgeId: string, src: TableSource): Promise<void> {
    const key = this.keyOf(src);
    return this.serial(key, async () => {
      await this.streams.get(key)?.remove(bridgeId);
      const row = await this.prisma.cdcSharedMember.findUnique({
        where: { bridgeId },
      });
      if (row)
        await this.prisma.cdcSharedMember.delete({ where: { bridgeId } });
      const remaining = await this.prisma.cdcSharedMember.count({
        where: { slotKey: key },
      });
      await this.streams.get(key)?.refreshIdle();

      await this.pool.withAdapter(src.connectionId, src.database, async (a) => {
        if (row)
          await this.unpublish(
            a,
            row.slotKey,
            row.ops,
            row.schemaName,
            row.tableName,
          );
        if (remaining > 0) return;
        await this.streams.get(key)?.close();
        const slot = this.slotName(key);
        let dropped = false;
        let lastError = '';
        for (let attempt = 0; attempt < 5 && !dropped; attempt++) {
          if (attempt > 0) await delay(backoffMs(attempt - 1, 250, 2000));
          try {
            await a.query(
              `select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = $1 and active`,
              [slot],
            );
            await a.query(`select pg_drop_replication_slot($1)`, [slot]);
            dropped = true;
          } catch (err) {
            const message = (err as Error).message;
            if (/does not exist/i.test(message)) dropped = true;
            else lastError = message;
          }
        }
        const pubs = await a
          .query(`select pubname from pg_publication where pubname like $1`, [
            `syncle\\_sp\\_${key}\\_%`,
          ])
          .catch(() => ({ rows: [] as Record<string, unknown>[] }));
        for (const p of pubs.rows)
          await a
            .query(`DROP PUBLICATION IF EXISTS ${quote(String(p.pubname))}`)
            .catch(() => undefined);
        if (!dropped)
          throw new Error(
            `could not drop the shared replication slot "${slot}": ${lastError}`,
          );
      });
    });
  }

  async isMember(bridgeId: string): Promise<boolean> {
    return (
      (await this.prisma.cdcSharedMember.count({ where: { bridgeId } })) > 0
    );
  }

  /** the position a member that has just joined starts from, as a cursor; null = not a member */
  async position(bridgeId: string): Promise<string | null> {
    const row = await this.prisma.cdcSharedMember.findUnique({
      where: { bridgeId },
      select: { confirmedLsn: true },
    });
    return row?.confirmedLsn ?? null;
  }

  /* ----- reading ----- */

  async open(
    ctx: CdcStreamContext,
    clientConfig: (
      conn: ConnectionConfig,
      database?: string,
    ) => Record<string, unknown>,
  ): Promise<CdcStreamHandle> {
    const { bridgeId, bridge, handlers } = ctx;
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc')
      throw new Error('Postgres CDC requires a table source and cdc trigger.');
    const src = bridge.source;
    const operations = bridge.trigger.operations;
    const key = this.keyOf(src);
    return this.serial(key, async () => {
      const row = await this.prisma.cdcSharedMember.findUnique({
        where: { bridgeId },
      });
      if (!row)
        throw new Error(
          `bridge ${bridgeId} is not a member of the shared replication slot`,
        );
      let stream = this.streams.get(key);
      if (!stream) {
        stream = new SharedStream(
          {
            key,
            slot: this.slotName(key),
            clientConfig: clientConfig(ctx.conn, src.database),
          },
          this,
          this.logger,
        );
        this.streams.set(key, stream);
      }
      const member: Member = {
        bridgeId,
        schema: src.schema || 'public',
        table: src.table,
        ops: new Set(operations),
        handlers,
        // what it has had: its saved cursor, or — never having read — everything before it joined
        highest: ctx.fromCursor ?? row.confirmedLsn,
        confirmed: row.confirmedLsn,
        persistedAt: 0,
        since: 0,
      };
      const opened = stream;
      await opened.add(member);
      return {
        ack: (cursor: string) => opened.ack(member, cursor),
        stop: () => this.serial(key, () => opened.remove(bridgeId)),
      };
    });
  }

  /* ----- what it costs the source ----- */

  async inspect(
    bridgeId: string,
    src: TableSource,
    cursor: string | null,
  ): Promise<CdcSourceHold | null> {
    const key = this.keyOf(src);
    const name = this.slotName(key);
    const row = await this.prisma.cdcSharedMember.findUnique({
      where: { bridgeId },
    });
    const members = await this.prisma.cdcSharedMember.count({
      where: { slotKey: key },
    });
    return this.pool.withAdapter(src.connectionId, src.database, async (a) => {
      const server = await a.query(
        `select current_setting('server_version_num')::int as version,
                (select setting from pg_settings where name = 'max_slot_wal_keep_size') as keep_limit`,
      );
      const info = (server.rows[0] ?? {}) as {
        version?: number;
        keep_limit?: string | null;
      };
      const modern = Number(info.version ?? 0) >= 130000;
      const limitMb = info.keep_limit == null ? -1 : Number(info.keep_limit);
      const limitBytes = limitMb >= 0 ? limitMb * 1024 * 1024 : null;
      const base = {
        engine: 'postgres' as const,
        kind: 'replication-slot' as const,
        name,
        limitBytes,
      };
      if (!row) {
        // never joined (nothing held) — or given up, with a position that now points nowhere
        if (!cursor) return null;
        return {
          ...base,
          exists: false,
          active: null,
          retainedBytes: null,
          status: 'lost',
          detail:
            `this bridge has a position, and no place in the shared replication slot "${name}" to go with it: ` +
            'it read through a slot of its own before, or its place in the shared one was given up',
        };
      }
      const res = await a.query(
        `select s.active,
                pg_wal_lsn_diff(case when pg_is_in_recovery() then pg_last_wal_receive_lsn() else pg_current_wal_lsn() end, $2::pg_lsn)::text as held,
                s.restart_lsn is null as invalidated
                ${modern ? ', s.wal_status' : ''}
         from pg_replication_slots s where s.slot_name = $1`,
        [name, row.confirmedLsn],
      );
      const slot = res.rows[0] as
        | {
            active?: boolean;
            held?: string | null;
            invalidated?: boolean;
            wal_status?: string | null;
          }
        | undefined;
      if (!slot) {
        return {
          ...base,
          exists: false,
          active: null,
          retainedBytes: null,
          status: 'lost',
          detail: `the shared replication slot "${name}" does not exist on the server`,
        };
      }
      const status: CdcSourceHold['status'] =
        slot.wal_status === 'lost' || slot.invalidated
          ? 'lost'
          : slot.wal_status === 'unreserved'
            ? 'at-risk'
            : 'ok';
      return {
        ...base,
        exists: true,
        active: slot.active === true,
        // what THIS member keeps the source from discarding: the WAL since its own position
        retainedBytes:
          slot.held == null ? null : Math.max(0, Number(slot.held)),
        status,
        detail:
          status === 'lost'
            ? `the server invalidated the shared replication slot "${name}": it needed more WAL than max_slot_wal_keep_size allows`
            : status === 'at-risk'
              ? `the shared replication slot "${name}" is past max_slot_wal_keep_size; the server will invalidate it at the next checkpoint`
              : `shared by ${members} bridge${members === 1 ? '' : 's'}; the amount is what this one still has to read`,
      };
    });
  }
}

type Adapter = Parameters<Parameters<AdapterPoolService['withAdapter']>[2]>[0];
