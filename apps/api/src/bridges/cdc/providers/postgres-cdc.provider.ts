/**
 * PostgreSQL CDC via logical replication, same mechanism Debezium/Fivetran use.
 * changes stream from the WAL in real time (no polling), decoded with the
 * built-in `pgoutput` plugin (no server extension needed). we auto-provision
 * the publication + replication slot. the one thing we can't automate is
 * `wal_level=logical` (it needs a server restart), so `readiness()` checks it
 * and tells the user what to do.
 *
 * the slot persists the confirmed LSN, so a restart resumes exactly where it
 * left off. this is a verbatim extract of the original BridgeCdcService Postgres
 * logic, now behind the {@link CdcProvider} interface.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestError,
  UNCHANGED,
  sourceColumnFor,
  type CdcOperation,
  type CdcReadiness,
  type CdcReadinessDTO,
  type ConnectionConfig,
  type DatabaseEngine,
} from '@syncle/core';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { nodeTlsOptions, withDatabase } from '@syncle/core/adapters';
import { AdapterPoolService } from '../../../connections/adapter-pool.service';
import type { ResolvedBridge } from '../../bridges.types';
import {
  backoffMs,
  delay,
  type CdcChange,
  type CdcProvider,
  type CdcSourceHold,
  type CdcStreamContext,
  type CdcStreamHandle,
} from '../cdc-provider';

/**
 * Where a Postgres change sits in the stream.
 *
 * It is NOT the change's own LSN, which is what this used to be. Two things are
 * wrong with that, and both lost rows with nothing erroring:
 *
 *  1. Postgres tags every change with the WAL position it was written at, but
 *     streams whole transactions in COMMIT order. A transaction that started
 *     early and committed late arrives after ones with HIGHER positions, and a
 *     "highest position seen" watermark discards its rows as already processed.
 *     Measured with two overlapping transactions: rows [1, 2, 3] written,
 *     [2, 3] delivered.
 *  2. Positions are not unique. COPY writes a couple of hundred rows per WAL
 *     record and every one of them carries that record's LSN, so as soon as a
 *     batch boundary fell inside a record the rest of it compared as "not after
 *     the watermark". Measured: COPY of 3000 rows, 1412 delivered.
 *
 * What IS ordered and unique: the transaction's commit position, then the
 * change's position within it, then its ordinal among changes sharing that
 * position. So a cursor is
 *
 *     <commitLsn>#<changeLsn>.<n>      a change
 *     <commitLsn>#c:<commitEndLsn>     the end of a transaction
 *
 * The commit LSN comes from the transaction's BEGIN message. The end marker
 * sorts after every change of its transaction and carries the position that may
 * be confirmed to the server. All three parts are read off the WAL, so a
 * transaction the server sends again (after a restart) gets the same cursors
 * whatever the publication or the bridge's settings have become since.
 *
 * A bare `H/L` is a cursor saved before this existed: "everything that was sent
 * before this position". Any transaction committing at or after it is accepted
 * whole, which can re-deliver a few rows once after an upgrade (upserts absorb
 * that) and can never skip one.
 */
export interface PgPosition {
  /** the transaction's commit LSN (or the bare LSN of a legacy cursor) */
  commit: bigint;
  /** the change's own LSN; -1 for a legacy cursor, END for a transaction's end */
  change: bigint;
  /** ordinal among the changes sharing `change` */
  ordinal: number;
  /** the position that may be confirmed to the server once this one is durable */
  ack: string | null;
}

const END = 1n << 64n;

function lsnValue(text: string): bigint {
  const [h, lo, ...rest] = text.split('/');
  if (!h || !lo || rest.length || !/^[0-9a-f]{1,8}$/i.test(h) || !/^[0-9a-f]{1,8}$/i.test(lo)) {
    throw new Error('invalid LSN');
  }
  return (BigInt('0x' + h) << 32n) | BigInt('0x' + lo);
}

/** the form Postgres prints: `16/B374D848` */
export function formatLsn(value: bigint): string {
  return `${(value >> 32n).toString(16).toUpperCase()}/${(value & 0xffffffffn).toString(16).toUpperCase()}`;
}

export function parsePgCursor(cursor: string): PgPosition | null {
  try {
    const hash = cursor.indexOf('#');
    if (hash < 0) return { commit: lsnValue(cursor), change: -1n, ordinal: 0, ack: cursor };
    const commit = lsnValue(cursor.slice(0, hash));
    const rest = cursor.slice(hash + 1);
    if (rest.startsWith('c:')) {
      const end = rest.slice(2);
      lsnValue(end); // validates
      return { commit, change: END, ordinal: 0, ack: end };
    }
    const dot = rest.lastIndexOf('.');
    if (dot < 0) return null;
    const ordinal = Number(rest.slice(dot + 1));
    if (!Number.isInteger(ordinal) || ordinal < 0) return null;
    return { commit, change: lsnValue(rest.slice(0, dot)), ordinal, ack: null };
  } catch {
    return null;
  }
}

/** true if position `a` is strictly after `b` (either cursor format) */
export function lsnAfter(a: string, b: string | null): boolean {
  if (!b) return true;
  const pa = parsePgCursor(a);
  const pb = parsePgCursor(b);
  // be conservative: treat a parse failure as "not after" to avoid dupes
  if (!pa || !pb) return false;
  if (pa.commit !== pb.commit) return pa.commit > pb.commit;
  if (pa.change !== pb.change) return pa.change > pb.change;
  return pa.ordinal > pb.ordinal;
}

/** `00000001/BD940508` (as the protocol messages print it) -> `1/BD940508` */
function normalizeLsn(lsn: string): string {
  try {
    return formatLsn(lsnValue(lsn));
  } catch {
    return lsn;
  }
}

/**
 * the LSN to hand the replication client so that the server is told exactly
 * `lsn`. the client sends `lsn + 1` ("last byte + 1"), but the positions
 * Postgres reports are ALREADY one past the last byte: a commit's end is where
 * the next record starts. one byte further is inside that next record — and
 * when that is another transaction's commit, Postgres treats the transaction
 * as confirmed and never sends it again. measured with two transactions
 * committing back to back and a restart between them: the second was gone.
 */
export function lsnForClient(lsn: string): string | null {
  try {
    const value = lsnValue(lsn);
    return value > 0n ? formatLsn(value - 1n) : null;
  } catch {
    return null;
  }
}

/**
 * a value the message did not include comes out of the decoder as `undefined`:
 * a large column an UPDATE did not touch. mark it, so it is left alone at the
 * destination instead of being written as NULL (see UNCHANGED in @syncle/core).
 * under REPLICA IDENTITY FULL the decoder fills these from the old row, so there
 * is nothing to mark.
 */
function withUnchanged(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) (out ??= { ...row })[k] = UNCHANGED;
  }
  return out ?? row;
}

/** an old-row image, minus the columns it does not actually carry */
function present(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}

/** decoded values compare by content: two Dates or Buffers are never `===` */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(a, b) === 0;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** what identifies a row in the table's change messages */
interface ReplicaIdentity {
  /** 'd' default (primary key) · 'i' an index · 'f' the whole row · 'n' nothing */
  kind: 'd' | 'i' | 'f' | 'n';
  /** columns an UPDATE/DELETE's old-row image carries; empty = it carries none */
  columns: string[];
  partitioned: boolean;
  serverVersion: number;
}

@Injectable()
export class PostgresCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'postgres';
  readonly capturesTruncate = true;
  private readonly logger = new Logger('BridgeCdc:pg');

  constructor(private readonly pool: AdapterPoolService) {}

  cursorAfter(a: string, b: string | null): boolean {
    return lsnAfter(a, b);
  }

  /* ----- readiness ----- */

  async readiness(dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness> {
    const checks: CdcReadiness['checks'] = [];
    const instructions: string[] = [];
    try {
      const res = await this.pool.withAdapter(dto.connectionId, dto.database, (a) =>
        a.query(
          `select current_setting('wal_level') as wal_level,
                  (select rolreplication or rolsuper from pg_roles where rolname = current_user) as can_replicate`,
        ),
      );
      const row = (res.rows[0] ?? {}) as { wal_level?: string; can_replicate?: boolean };
      const logical = row.wal_level === 'logical';
      const canReplicate = row.can_replicate === true;
      checks.push({
        label: 'wal_level = logical',
        ok: logical,
        detail: row.wal_level ? `currently "${row.wal_level}"` : undefined,
      });
      checks.push({ label: 'role can replicate', ok: canReplicate });
      if (!logical) {
        instructions.push(
          'Set wal_level=logical on the server (postgresql.conf or your provider’s parameter group) and restart it. This is the one step we can’t automate — it needs a server restart.',
        );
      }
      if (!canReplicate) {
        instructions.push(
          `Grant replication to the connection's role:  ALTER ROLE "${conn.user ?? 'your_user'}" REPLICATION;`,
        );
      }
      // table-level facts. they do not block readiness on their own — what a
      // bridge may capture depends on its operations, which `provision` checks —
      // but whoever is building the bridge should see them now, not at start
      try {
        const identity = await this.replicaIdentity(dto.connectionId, dto.database, dto.schema, dto.table);
        const described =
          identity.kind === 'f'
            ? 'the whole row (REPLICA IDENTITY FULL)'
            : identity.columns.length
              ? identity.columns.join(', ')
              : 'none';
        checks.push({
          label: 'table has a replica identity',
          ok: identity.columns.length > 0 || identity.kind === 'f',
          detail: `identifies rows by: ${described}`,
        });
        if (identity.columns.length === 0 && identity.kind !== 'f') {
          instructions.push(
            'This table has no primary key and no replica identity, so only INSERTs can be captured from it. ' +
              'To capture updates and deletes, add a primary key, or run:  ' +
              `ALTER TABLE ${this.qualified(dto.schema, dto.table)} REPLICA IDENTITY FULL;`,
          );
        }
        if (identity.partitioned && identity.serverVersion < 130000) {
          checks.push({
            label: 'partitioned table (needs PostgreSQL 13+)',
            ok: false,
            detail: 'changes are reported under the partitions’ names on this server version',
          });
          instructions.push(
            'This is a partitioned table on PostgreSQL 12 or older, where a publication cannot report changes under the parent’s name. Bridge each partition separately, or upgrade to 13+.',
          );
        }
      } catch {
        /* the table may not exist yet while the bridge is being drafted */
      }
      const capacity = await this.capacity(dto).catch(() => null);
      let room = true;
      const advisories: string[] = [];
      if (capacity) {
        // a slot and a walsender each. a bridge that already has its slot needs
        // no new one, so it is not failed by a server that is otherwise full
        const slotOk = capacity.ownsSlot || capacity.slotsUsed < capacity.slotsMax;
        const senderOk = capacity.sendersUsed < capacity.sendersMax;
        room = slotOk && senderOk;
        checks.push({
          label: 'a free replication slot',
          ok: slotOk,
          detail: `${capacity.slotsUsed} of ${capacity.slotsMax} in use${capacity.ownsSlot ? ' (one of them is this bridge’s)' : ''}`,
        });
        checks.push({
          label: 'a free WAL sender',
          ok: senderOk,
          detail: `${capacity.sendersUsed} of ${capacity.sendersMax} in use`,
        });
        if (!slotOk) {
          instructions.push(
            `Every replication slot on this server is taken (max_replication_slots = ${capacity.slotsMax}), and each CDC bridge needs one. ` +
              'Raise max_replication_slots (needs a restart), or free one: delete a bridge you no longer need, or drop a slot nothing reads — ' +
              `SELECT slot_name, active FROM pg_replication_slots;`,
          );
        }
        if (!senderOk) {
          instructions.push(
            `Every WAL sender on this server is busy (max_wal_senders = ${capacity.sendersMax}). Raise max_wal_senders (needs a restart) or stop another replication client.`,
          );
        }
        if (capacity.keepLimitMb === -1) {
          advisories.push(
            'Nothing limits how much WAL a replication slot can pin on this server (max_slot_wal_keep_size = -1). ' +
              'A bridge that is paused — or a Syncle that is switched off — keeps its slot, and the server keeps every change since, until the disk is full. ' +
              'Setting max_slot_wal_keep_size (for example 10GB) makes the server give up the slot instead; the bridge then needs a fresh start, but the database stays up.',
          );
        }
      }
      return {
        engine: 'postgres',
        supported: true,
        ready: logical && canReplicate && room,
        checks,
        instructions,
        ...(advisories.length ? { advisories } : {}),
      };
    } catch (err) {
      return {
        engine: 'postgres',
        supported: true,
        ready: false,
        checks: [{ label: 'connect to database', ok: false, detail: (err as Error).message }],
        instructions: ['Could not query the database to check readiness.'],
      };
    }
  }

  /** how many replication slots and WAL senders the server has left */
  private async capacity(dto: CdcReadinessDTO): Promise<{
    slotsMax: number;
    slotsUsed: number;
    sendersMax: number;
    sendersUsed: number;
    ownsSlot: boolean;
    /** max_slot_wal_keep_size in MB; -1 = unlimited; null = the server predates it (< 13) */
    keepLimitMb: number | null;
  }> {
    const slot = dto.bridgeId ? this.slotName(dto.bridgeId) : '';
    const res = await this.pool.withAdapter(dto.connectionId, dto.database, (a) =>
      a.query(
        `select current_setting('max_replication_slots')::int as slots_max,
                (select count(*) from pg_replication_slots)::int as slots_used,
                current_setting('max_wal_senders')::int as senders_max,
                (select count(*) from pg_stat_replication)::int as senders_used,
                exists(select 1 from pg_replication_slots where slot_name = $1) as owns_slot,
                (select setting from pg_settings where name = 'max_slot_wal_keep_size') as keep_limit`,
        [slot],
      ),
    );
    const row = (res.rows[0] ?? {}) as Record<string, unknown>;
    const keep = row.keep_limit;
    return {
      slotsMax: Number(row.slots_max ?? 0),
      slotsUsed: Number(row.slots_used ?? 0),
      sendersMax: Number(row.senders_max ?? 0),
      sendersUsed: Number(row.senders_used ?? 0),
      ownsSlot: row.owns_slot === true,
      keepLimitMb: keep === null || keep === undefined ? null : Number(keep),
    };
  }

  /* ----- what the bridge holds on the source ----- */

  async inspect(bridgeId: string, bridge: ResolvedBridge): Promise<CdcSourceHold | null> {
    if (bridge.source.kind !== 'table') return null;
    const src = bridge.source;
    const name = this.slotName(bridgeId);
    return this.pool.withAdapter(src.connectionId, src.database, async (a) => {
      const server = await a.query(
        `select current_setting('server_version_num')::int as version,
                (select setting from pg_settings where name = 'max_slot_wal_keep_size') as keep_limit`,
      );
      const info = (server.rows[0] ?? {}) as { version?: number; keep_limit?: string | null };
      // wal_status / safe_wal_size arrived with max_slot_wal_keep_size, in 13
      const modern = Number(info.version ?? 0) >= 130000;
      const res = await a.query(
        `select s.active,
                pg_wal_lsn_diff(
                  case when pg_is_in_recovery() then pg_last_wal_receive_lsn() else pg_current_wal_lsn() end,
                  s.restart_lsn
                )::text as retained
                ${modern ? ', s.wal_status' : ''}
         from pg_replication_slots s
         where s.slot_name = $1`,
        [name],
      );
      const limitMb = info.keep_limit == null ? -1 : Number(info.keep_limit);
      const limitBytes = limitMb >= 0 ? limitMb * 1024 * 1024 : null;
      const row = res.rows[0] as { active?: boolean; retained?: string | null; wal_status?: string | null } | undefined;
      if (!row) {
        return {
          engine: 'postgres',
          kind: 'replication-slot',
          name,
          exists: false,
          active: null,
          retainedBytes: null,
          limitBytes,
          status: 'lost',
          detail: `replication slot "${name}" does not exist on the server`,
        };
      }
      // restart_lsn is NULL once the server has invalidated the slot
      const retained = row.retained == null ? null : Math.max(0, Number(row.retained));
      const status: CdcSourceHold['status'] =
        row.wal_status === 'lost' || (modern && row.retained == null)
          ? 'lost'
          : row.wal_status === 'unreserved'
            ? 'at-risk'
            : 'ok';
      return {
        engine: 'postgres',
        kind: 'replication-slot',
        name,
        exists: true,
        active: row.active === true,
        retainedBytes: retained,
        limitBytes,
        status,
        detail:
          status === 'lost'
            ? `the server invalidated replication slot "${name}": it needed more WAL than max_slot_wal_keep_size allows`
            : status === 'at-risk'
              ? `replication slot "${name}" is past max_slot_wal_keep_size; the server will invalidate it at the next checkpoint`
              : undefined,
      };
    });
  }

  /* ----- provisioning ----- */

  private pubName(bridgeId: string): string {
    return `syncle_pub_${bridgeId.replace(/-/g, '')}`;
  }
  private slotName(bridgeId: string): string {
    return `syncle_slot_${bridgeId.replace(/-/g, '')}`;
  }
  private quoteIdent(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }

  private qualified(schema: string | undefined, table: string): string {
    return `${this.quoteIdent(schema || 'public')}.${this.quoteIdent(table)}`;
  }

  /** how the table identifies a row in its UPDATE/DELETE messages */
  private async replicaIdentity(
    connectionId: string,
    database: string | undefined,
    schema: string | undefined,
    table: string,
  ): Promise<ReplicaIdentity> {
    return this.pool.withAdapter(connectionId, database, async (a) => {
      const res = await a.query(
        `select c.relreplident as kind, c.relkind,
                current_setting('server_version_num')::int as version,
                coalesce((
                  -- ::text: the driver does not parse a name[] and hands back the string '{id}'
                  select array_agg(att.attname::text order by k.ord)
                  from pg_index i
                  cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
                  join pg_attribute att on att.attrelid = i.indrelid and att.attnum = k.attnum
                  where i.indrelid = c.oid
                    and case c.relreplident when 'd' then i.indisprimary
                                            when 'i' then i.indisreplident
                                            else false end
                ), '{}'::text[]) as columns
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2`,
        [schema || 'public', table],
      );
      const row = res.rows[0] as
        | { kind?: string; relkind?: string; version?: number; columns?: string[] }
        | undefined;
      if (!row) throw new Error(`Table ${this.qualified(schema, table)} was not found.`);
      return {
        kind: (row.kind as ReplicaIdentity['kind']) ?? 'd',
        columns: Array.isArray(row.columns) ? row.columns : [],
        partitioned: row.relkind === 'p',
        serverVersion: Number(row.version ?? 0),
      };
    });
  }

  /**
   * refuse, BEFORE anything is created on the source, a bridge this table
   * cannot serve. both refusals are about harm that would otherwise be silent:
   *
   * 1. publishing UPDATE/DELETE for a table with no replica identity makes
   *    those statements FAIL at the source ("cannot update table … because it
   *    does not have a replica identity and publishes updates"). creating the
   *    publication would break the application that owns the database.
   * 2. a DELETE message carries only the replica-identity columns. a target
   *    keyed on any other column is handed a delete with no key in it, which
   *    matches nothing: the row stays at the destination for ever, no error.
   */
  private assertServable(bridge: ResolvedBridge, identity: ReplicaIdentity): void {
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc') return;
    const table = this.qualified(bridge.source.schema, bridge.source.table);
    const ops = new Set<CdcOperation>(bridge.trigger.operations);
    const full = identity.kind === 'f';

    if ((ops.has('update') || ops.has('delete')) && !full && identity.columns.length === 0) {
      throw new BadRequestError(
        `${table} has no primary key and no replica identity, so PostgreSQL can only report INSERTs for it — ` +
          'and publishing updates or deletes for such a table would make UPDATE and DELETE on it fail in your database. ' +
          'Either capture inserts only, add a primary key, or run:  ' +
          `ALTER TABLE ${table} REPLICA IDENTITY FULL;`,
      );
    }
    if (identity.partitioned && identity.serverVersion < 130000) {
      throw new BadRequestError(
        `${table} is partitioned, and PostgreSQL ${Math.floor(identity.serverVersion / 10000)} reports its changes under the partitions' names. ` +
          'Bridge each partition separately, or upgrade the server to 13+.',
      );
    }
    if (!ops.has('delete') || full || bridge.destination.kind !== 'database') return;

    const carried = new Set(identity.columns);
    for (const target of bridge.destination.targets) {
      const missing = target.keyColumns
        .map((key) => sourceColumnFor(key, target.mapping))
        .filter((column) => !carried.has(column));
      if (missing.length > 0) {
        throw new BadRequestError(
          `Deletes cannot reach ${target.table}: it is keyed on ${target.keyColumns.join(', ')}, ` +
            `but a DELETE on ${table} only carries ${identity.columns.join(', ')} ` +
            `(${missing.join(', ')} would be missing). Key the target on ${identity.columns.join(', ')}, ` +
            'stop capturing deletes, or have the table send whole rows:  ' +
            `ALTER TABLE ${table} REPLICA IDENTITY FULL;`,
        );
      }
    }
  }

  async provision(bridgeId: string, bridge: ResolvedBridge): Promise<void> {
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc') return;
    const src = bridge.source;
    const schema = src.schema || 'public';
    const pub = this.pubName(bridgeId);
    const slot = this.slotName(bridgeId);
    const target = `${this.quoteIdent(schema)}.${this.quoteIdent(src.table)}`;

    const identity = await this.replicaIdentity(src.connectionId, src.database, src.schema, src.table);
    this.assertServable(bridge, identity);

    // publish ONLY what the bridge captures. a publication that publishes
    // updates imposes the replica-identity requirement on the table even if
    // nobody reads them, so "insert only" has to mean insert only on the server
    // …with one exception: truncate is ALWAYS published. it costs the table
    // nothing (no replica identity is needed for it), and a bridge that is not
    // told about a TRUNCATE cannot even say that its destination has stopped
    // matching — whether it is APPLIED is still the bridge's own choice
    const publish = (['insert', 'update', 'delete', 'truncate'] as const)
      .filter(
        (op) =>
          op === 'truncate' ||
          (bridge.trigger.kind === 'cdc' && bridge.trigger.operations.includes(op)),
      )
      .join(', ');
    // a partitioned table's changes are logged against its PARTITIONS; without
    // this they arrive under the partition's name and are discarded as another
    // table's — a partitioned source streamed nothing at all. harmless otherwise
    const options =
      `publish = '${publish}'` +
      (identity.serverVersion >= 130000 ? ', publish_via_partition_root = true' : '');

    await this.pool.withAdapter(src.connectionId, src.database, async (a) => {
      // check the publication exists and points at the correct table. if the
      // user edited the bridge to change the source table OR schema we have to
      // update the publication, otherwise we'd silently stream the old table
      const pubInfo = await a.query(
        `select pt.schemaname, pt.tablename
         from pg_publication pub
         join pg_publication_tables pt on pt.pubname = pub.pubname
         where pub.pubname = $1`,
        [pub],
      );
      const existing = pubInfo.rows[0] as
        | { schemaname?: string; tablename?: string }
        | undefined;
      if (pubInfo.rows.length === 0) {
        await a.query(
          `CREATE PUBLICATION ${this.quoteIdent(pub)} FOR TABLE ${target} WITH (${options})`,
        );
      } else {
        if (existing?.schemaname !== schema || existing?.tablename !== src.table) {
          await a.query(`ALTER PUBLICATION ${this.quoteIdent(pub)} SET TABLE ${target}`);
          this.logger.log(`Updated CDC publication "${pub}" to target table "${schema}"."${src.table}"`);
        }
        // publications made before this existed publish everything and never
        // set the partition option; and the bridge's operations may have changed
        await a.query(`ALTER PUBLICATION ${this.quoteIdent(pub)} SET (${options})`);
      }

      const hasSlot = await a.query(
        `select 1 from pg_replication_slots where slot_name = $1`,
        [slot],
      );
      if (hasSlot.rows.length === 0) {
        await a.query(`select pg_create_logical_replication_slot($1, 'pgoutput')`, [slot]);
      }
    });
  }

  async deprovision(bridgeId: string, bridge: ResolvedBridge): Promise<void> {
    if (bridge.source.kind !== 'table') return;
    const slot = this.slotName(bridgeId);
    const pub = this.pubName(bridgeId);
    await this.pool.withAdapter(bridge.source.connectionId, bridge.source.database, async (a) => {
      // an orphaned slot pins WAL forever and eventually fills the source's
      // disk. the walsender often still holds the slot "active" right after
      // our client closes, so retry: kick any holder off, then drop.
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
          // already gone is exactly the state we want
          if (/does not exist/i.test(message)) dropped = true;
          else lastError = message;
        }
      }
      // the publication costs the source nothing; the slot is what matters
      await a.query(`DROP PUBLICATION IF EXISTS ${this.quoteIdent(pub)}`).catch(() => undefined);
      if (!dropped) {
        // NOT swallowed: a slot nothing reads pins WAL until the disk is full,
        // and once the bridge is gone this is the last anyone hears of its name.
        // the caller queues it and tries again
        throw new Error(`could not drop replication slot "${slot}": ${lastError}`);
      }
    });
  }

  /* ----- the stream ----- */

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const { bridgeId, bridge, conn, handlers } = ctx;
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc') {
      throw new Error('Postgres CDC requires a table source and cdc trigger.');
    }
    const src = bridge.source;
    const ops = new Set<CdcOperation>(bridge.trigger.operations);
    const schema = src.schema || 'public';

    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [this.pubName(bridgeId)],
    });

    let stopped = false;
    let current: LogicalReplicationService | null = null;
    let attempt = 0;
    // highest LSN the orchestrator has durably checkpointed (seeded from the
    // resume cursor). this is the ONLY position we ever confirm to the server,
    // so the slot can never advance past a change that isn't persisted yet
    let ackedLsn: string | null = await this.confirmedPosition(
      bridgeId,
      src,
      ctx.fromCursor ? (parsePgCursor(ctx.fromCursor)?.ack ?? null) : null,
    );
    // the transaction being decoded: its commit LSN (from BEGIN), and the last
    // change position handed out with how many changes have shared it. every
    // change's cursor is derived from these
    let txn: { commit: string; lsn: string; shared: number } | null = null;
    // surface each distinct failure ONCE (a slot already in use, bad auth, …)
    // instead of spamming onError on every backoff retry
    let lastReported: string | null = null;
    const report = (err: Error): void => {
      if (stopped || err.message === lastReported) return;
      lastReported = err.message;
      handlers.onError(err);
    };

    const makeService = (): LogicalReplicationService => {
      // a reconnect starts over at a transaction's BEGIN
      txn = null;
      const service = new LogicalReplicationService(this.clientConfig(conn, src.database), {
        // manual acknowledge: auto-ack confirms an LSN on receipt, so a crash
        // between receipt and the orchestrator persisting the cursor would
        // silently lose that change (the slot had already moved past it).
        // timeoutSeconds MUST be 0 too — the library's standby-status timer
        // acks the last *received* LSN even with auto:false
        acknowledge: { auto: false, timeoutSeconds: 0 },
        flowControl: { enabled: true }, // backpressure, await each delivery
      });

      // messages we don't deliver (begin/commit/relation, disabled ops, other
      // tables) still have to move the slot along, or a mostly-skipped stream
      // pins WAL on the source. but their LSN must NOT be confirmed from here.
      // flow control only guarantees the rows before them were HANDED to the
      // orchestrator — which batches, so those rows are typically still in
      // memory. confirming a COMMIT's LSN at this point put the slot's restart
      // position past its own transaction's undelivered rows: a failed delivery
      // or a crash then had nothing left to re-read. the orchestrator is told
      // instead, and confirms the position once everything before it is durable
      const skip = (lsn: string): Promise<void> =>
        handlers.onSkip ? handlers.onSkip(lsn) : Promise.resolve();

      service.on(
        'data',
        async (
          lsn: string,
          msg: {
            tag: string;
            commitLsn?: string;
            commitEndLsn?: string;
            relation?: { name: string; schema: string; keyColumns?: string[] };
            relations?: Array<{ name: string; schema: string } | undefined>;
            new?: Record<string, unknown>;
            old?: Record<string, unknown> | null;
            key?: Record<string, unknown> | null;
          },
        ) => {
          // data is flowing, so the subscription is healthy: reset the backoff
          attempt = 0;
          lastReported = null;

          if (msg.tag === 'begin') {
            txn = msg.commitLsn ? { commit: normalizeLsn(msg.commitLsn), lsn: '', shared: 0 } : null;
            return;
          }
          if (msg.tag === 'commit') {
            const commit = msg.commitLsn ? normalizeLsn(msg.commitLsn) : txn?.commit;
            txn = null;
            // the end of the transaction: the one position that, once everything
            // before it is durable, may be confirmed to the server
            if (commit) await skip(`${commit}#c:${normalizeLsn(msg.commitEndLsn ?? lsn)}`);
            return;
          }
          // the position of the change being handled; each call is a new one.
          // the bare `lsn` is only a fallback for a change that arrives outside
          // a transaction, which pgoutput never sends
          const at = (): string => {
            if (!txn) return lsn;
            txn.shared = txn.lsn === lsn ? txn.shared + 1 : 0;
            txn.lsn = lsn;
            return `${txn.commit}#${lsn}.${txn.shared}`;
          };

          if (msg.tag === 'truncate') {
            const ours = (msg.relations ?? []).some(
              (r) => r?.name === src.table && r?.schema === schema,
            );
            if (!ours) return void (await skip(at()));
            if (ops.has('truncate')) {
              await handlers.onChange({ op: 'truncate', row: {}, cursor: at() });
            } else if (handlers.onNotice) {
              // emptying someone's destination is not something to do on a
              // default. but a destination that has silently stopped matching
              // its source is not acceptable either: say so, on the timeline
              await handlers.onNotice(
                `${schema}.${src.table} was TRUNCATEd at the source. That was not applied to the destination, ` +
                  'which still holds the rows: this bridge does not capture truncates. ' +
                  'Add "truncate" to its operations to mirror them.',
                at(),
              );
            } else {
              await skip(at());
            }
            return;
          }

          // relation / type / origin / message: descriptions of what follows,
          // tagged with the NEXT change's position. they are not positions of
          // their own — treating one as passed is treating that change as done
          if (msg.tag !== 'insert' && msg.tag !== 'update' && msg.tag !== 'delete') return;

          if (!ops.has(msg.tag as CdcOperation)) {
            await skip(at());
            return;
          }
          if (!msg.relation || msg.relation.name !== src.table || msg.relation.schema !== schema) {
            await skip(at());
            return;
          }
          if (msg.tag === 'delete') {
            await handlers.onChange({ op: 'delete', row: present(msg.old ?? msg.key ?? {}), cursor: at() });
            return;
          }

          // an UPDATE that changes the row's key is the row MOVING. the old-row
          // image is there exactly when that can have happened: `key` when the
          // identity columns changed, `old` under REPLICA IDENTITY FULL. writing
          // the new row alone left the old one at the destination for ever
          let keyChanged = false;
          if (msg.tag === 'update') {
            const before = msg.key ?? msg.old;
            const identityColumns = msg.relation.keyColumns ?? [];
            const moved =
              !!before &&
              identityColumns.some((c) => before[c] !== undefined && !sameValue(before[c], msg.new?.[c]));
            if (moved) {
              await handlers.onChange({ op: 'delete', row: present(before), cursor: at() });
              keyChanged = true;
            }
          }

          const change: CdcChange = {
            op: msg.tag as CdcOperation,
            row: withUnchanged(msg.new ?? {}),
            cursor: at(),
            ...(keyChanged ? { keyChanged } : {}),
          };
          await handlers.onChange(change);
        },
      );

      // with the ack timer off, keepalive replies are our only standby-status
      // traffic. reply with the last PERSISTED position (the server ignores
      // stale ones) or wal_sender_timeout would kill an idle stream
      service.on('heartbeat', (_lsn: string, _ts: number, shouldRespond: boolean) => {
        const at = ackedLsn && lsnForClient(ackedLsn);
        if (shouldRespond && at) void service.acknowledge(at).catch(() => undefined);
      });

      service.on('error', (err: Error) => report(err));
      return service;
    };

    // `subscribe` rejects on connection loss and the library does NOT reconnect
    // on its own — without this loop a dropped stream would show "Live" forever.
    // the slot persists the confirmed LSN, so each reconnect resumes exactly.
    const loop = async (): Promise<void> => {
      while (!stopped) {
        const service = makeService();
        current = service;
        try {
          await service.subscribe(plugin, this.slotName(bridgeId));
          if (stopped) break;
          // stream ended without an error (server closed it): reconnect
          await delay(backoffMs(attempt++));
        } catch (err) {
          if (stopped) break;
          report(new Error(`replication stream error: ${(err as Error).message}`));
          await delay(backoffMs(attempt++));
        } finally {
          await service.stop().catch(() => undefined);
        }
      }
    };
    // drive the loop in the background, it owns its own lifecycle
    void loop().catch((err) => handlers.onError(err as Error));

    return {
      // called by the orchestrator once the cursor for this change is durably
      // persisted: only now may the slot's confirmed LSN move past the change
      ack: async (cursor: string) => {
        // a position INSIDE a transaction confirms nothing: the server can only
        // be told "everything up to here is safe" at a transaction's end. after
        // a restart it re-sends the unfinished transaction whole, and the
        // watermark drops the changes already delivered
        const confirm = parsePgCursor(cursor)?.ack;
        const at = confirm && lsnForClient(confirm);
        if (!confirm || !at) return;
        ackedLsn = confirm;
        await current?.acknowledge(at).catch(() => undefined);
      },
      stop: async () => {
        stopped = true;
        await current?.stop().catch(() => undefined);
      },
    };
  }

  /**
   * what keepalives are answered with until the first transaction is confirmed:
   * the further of the saved cursor and what the slot already holds. answering
   * with the slot's own position changes nothing on the server, but NOT
   * answering gets an idle stream disconnected every wal_sender_timeout — a
   * bridge started on a quiet table, or resumed in the middle of a transaction,
   * had nothing to answer with
   */
  private async confirmedPosition(
    bridgeId: string,
    src: { connectionId: string; database?: string },
    fromCursor: string | null,
  ): Promise<string | null> {
    let slot: string | null = null;
    try {
      const res = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a.query(
          `select confirmed_flush_lsn::text as lsn from pg_replication_slots where slot_name = $1`,
          [this.slotName(bridgeId)],
        ),
      );
      const value = res.rows[0]?.lsn;
      slot = typeof value === 'string' && value ? value : null;
    } catch {
      slot = null; // best effort: the saved cursor alone is what it used to be
    }
    if (!slot || !fromCursor) return slot ?? fromCursor;
    return lsnAfter(slot, fromCursor) ? slot : fromCursor;
  }

  private clientConfig(conn: ConnectionConfig, database?: string) {
    if (conn.connectionString) {
      // logical replication is per-database: the stream must open against the
      // bridge's source database, not whatever database the saved string names
      const ssl = conn.tls ? nodeTlsOptions(conn) : undefined;
      return {
        connectionString: withDatabase(conn.connectionString, database),
        // a TLS setting chosen beside the string says how far to trust the
        // certificate, exactly as it does for the ordinary connection
        ...(ssl ? { ssl } : {}),
      } as Record<string, unknown>;
    }
    return {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: database || conn.database,
      // the same trust decision as the ordinary connection — this one used to
      // hard-code `rejectUnauthorized: false`, so the change stream was never
      // verified even where the connection it belongs to was
      ssl: nodeTlsOptions(conn),
    } as Record<string, unknown>;
  }
}
