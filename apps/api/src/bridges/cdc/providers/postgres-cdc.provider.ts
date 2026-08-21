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
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@syncle/core';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { AdapterPoolService } from '../../../connections/adapter-pool.service';
import type { ResolvedBridge } from '../../bridges.types';
import {
  backoffMs,
  delay,
  type CdcChange,
  type CdcProvider,
  type CdcStreamContext,
  type CdcStreamHandle,
} from '../cdc-provider';

/** compare Postgres LSNs ("H/L" hex). true if `a` is strictly after `b` */
export function lsnAfter(a: string, b: string | null): boolean {
  if (!b) return true;
  try {
    const big = (l: string) => {
      const [h, lo] = l.split('/');
      if (!h || !lo) throw new Error('invalid LSN');
      return (BigInt('0x' + h) << 32n) | BigInt('0x' + lo);
    };
    return big(a) > big(b);
  } catch {
    // be conservative: treat a parse failure as "not after" to avoid dupes
    return false;
  }
}

@Injectable()
export class PostgresCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'postgres';
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
      return { engine: 'postgres', supported: true, ready: logical && canReplicate, checks, instructions };
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

  async provision(bridgeId: string, bridge: ResolvedBridge): Promise<void> {
    if (bridge.source.kind !== 'table') return;
    const src = bridge.source;
    const schema = src.schema || 'public';
    const pub = this.pubName(bridgeId);
    const slot = this.slotName(bridgeId);
    const target = `${this.quoteIdent(schema)}.${this.quoteIdent(src.table)}`;

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
        await a.query(`CREATE PUBLICATION ${this.quoteIdent(pub)} FOR TABLE ${target}`);
      } else if (existing?.schemaname !== schema || existing?.tablename !== src.table) {
        await a.query(`ALTER PUBLICATION ${this.quoteIdent(pub)} SET TABLE ${target}`);
        this.logger.log(`Updated CDC publication "${pub}" to target table "${schema}"."${src.table}"`);
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
      if (!dropped) {
        this.logger.error(
          `Could not drop replication slot "${slot}" — it will keep pinning WAL on the source until dropped manually: ${lastError}`,
        );
      }
      await a.query(`DROP PUBLICATION IF EXISTS ${this.quoteIdent(pub)}`).catch(() => undefined);
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
    let ackedLsn: string | null = ctx.fromCursor;
    // surface each distinct failure ONCE (a slot already in use, bad auth, …)
    // instead of spamming onError on every backoff retry
    let lastReported: string | null = null;
    const report = (err: Error): void => {
      if (stopped || err.message === lastReported) return;
      lastReported = err.message;
      handlers.onError(err);
    };

    const makeService = (): LogicalReplicationService => {
      const service = new LogicalReplicationService(this.clientConfig(conn, src.database), {
        // manual acknowledge: auto-ack confirms an LSN on receipt, so a crash
        // between receipt and the orchestrator persisting the cursor would
        // silently lose that change (the slot had already moved past it).
        // timeoutSeconds MUST be 0 too — the library's standby-status timer
        // acks the last *received* LSN even with auto:false
        acknowledge: { auto: false, timeoutSeconds: 0 },
        flowControl: { enabled: true }, // backpressure, await each delivery
      });

      // messages we don't deliver are deterministically skippable (begin/
      // commit/relation, disabled ops, other tables), and flow control has
      // fully processed everything before them, so confirming their LSN is
      // safe and keeps the slot from pinning WAL on a mostly-filtered stream
      const ackSkipped = (lsn: string): void => {
        ackedLsn = lsn;
        void service.acknowledge(lsn).catch(() => undefined);
      };

      service.on(
        'data',
        async (
          lsn: string,
          msg: {
            tag: string;
            relation?: { name: string; schema: string };
            new?: Record<string, unknown>;
            old?: Record<string, unknown>;
            key?: Record<string, unknown>;
          },
        ) => {
          // data is flowing, so the subscription is healthy: reset the backoff
          attempt = 0;
          lastReported = null;
          if (msg.tag !== 'insert' && msg.tag !== 'update' && msg.tag !== 'delete') {
            ackSkipped(lsn);
            return;
          }
          if (!ops.has(msg.tag as CdcOperation)) {
            ackSkipped(lsn);
            return;
          }
          if (!msg.relation || msg.relation.name !== src.table || msg.relation.schema !== schema) {
            ackSkipped(lsn);
            return;
          }
          const row = msg.tag === 'delete' ? (msg.old ?? msg.key ?? {}) : (msg.new ?? {});
          const change: CdcChange = { op: msg.tag as CdcOperation, row, cursor: lsn };
          await handlers.onChange(change);
        },
      );

      // with the ack timer off, keepalive replies are our only standby-status
      // traffic. reply with the last PERSISTED position (the server ignores
      // stale ones) or wal_sender_timeout would kill an idle stream
      service.on('heartbeat', (_lsn: string, _ts: number, shouldRespond: boolean) => {
        if (shouldRespond && ackedLsn) {
          void service.acknowledge(ackedLsn).catch(() => undefined);
        }
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
        ackedLsn = cursor;
        await current?.acknowledge(cursor).catch(() => undefined);
      },
      stop: async () => {
        stopped = true;
        await current?.stop().catch(() => undefined);
      },
    };
  }

  private clientConfig(conn: ConnectionConfig, database?: string) {
    if (conn.connectionString) {
      // logical replication is per-database: the stream must open against the
      // bridge's source database, not whatever database the saved string names
      if (database) {
        try {
          const u = new URL(conn.connectionString);
          u.pathname = `/${database}`;
          return { connectionString: u.toString() } as Record<string, unknown>;
        } catch {
          /* unparseable string, fall back to using it verbatim */
        }
      }
      return { connectionString: conn.connectionString } as Record<string, unknown>;
    }
    return {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: database || conn.database,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    } as Record<string, unknown>;
  }
}
