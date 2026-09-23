/**
 * keeps a bridge honest about the table it reads: has it changed since the
 * bridge was set up, does the change hurt, and what is done about it.
 *
 * The baseline — the table's columns as last accepted — is kept with the
 * bridge. It is recorded the first time the bridge is looked at, again whenever
 * the bridge is saved (whoever saves it has the current table in front of
 * them), and when somebody accepts a change.
 *
 * Only for sources that HAVE a schema. a MongoDB collection's or a Redis
 * keyspace's "columns" are whatever the last documents happened to hold.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  columnsUsed,
  describeDrift,
  diffColumns,
  planTargetTable,
  type BridgeSchemaDrift,
  type DatabaseEngine,
  type SchemaColumn,
  type SchemaDrift,
} from '@syncle/core';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma.service';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { DatabaseSinkService } from './database-sink.service';
import type { ResolvedBridge } from './bridges.types';

const WITH_SCHEMA: ReadonlySet<DatabaseEngine> = new Set([
  'postgres',
  'mysql',
  'sqlite',
]);

/** does a source of this engine have columns that can drift at all? (a document's shape is not a schema) */
export const tracksSchema = (engine: DatabaseEngine): boolean =>
  WITH_SCHEMA.has(engine);

export interface DriftVerdict {
  drift: SchemaDrift | null;
  missingUsed: string[];
  /** the bridge must not go on: why, in words for whoever has to fix it */
  stop: string | null;
}

const CLEAR: DriftVerdict = { drift: null, missingUsed: [], stop: null };

@Injectable()
export class SchemaDriftService {
  private readonly logger = new Logger('SchemaDrift');
  /** what was last said about a bridge's drift, so that it is said once per change and not per batch */
  private readonly reported = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pool: AdapterPoolService,
    private readonly connections: ConnectionStoreService,
    private readonly databaseSink: DatabaseSinkService,
    private readonly alerts: AlertsService,
  ) {}

  /** does this bridge read a table whose columns can be compared at all? */
  async watches(bridge: ResolvedBridge): Promise<boolean> {
    if (bridge.source.kind !== 'table') return false;
    try {
      return WITH_SCHEMA.has(
        (await this.connections.get(bridge.source.connectionId)).engine,
      );
    } catch {
      return false;
    }
  }

  /** the source table's columns right now; null when the source has no schema to speak of */
  async columnsNow(bridge: ResolvedBridge): Promise<SchemaColumn[] | null> {
    if (bridge.source.kind !== 'table') return null;
    const src = bridge.source;
    const engine = (await this.connections.get(src.connectionId)).engine;
    if (!WITH_SCHEMA.has(engine)) return null;
    const schema = await this.pool.withAdapter(
      src.connectionId,
      src.database,
      (a) => a.getSchema(src.database),
    );
    const table = schema.namespaces
      .filter((n) => !src.schema || n.name === src.schema)
      .flatMap((n) => n.tables)
      .find((t) => t.name === src.table);
    if (!table) return null;
    return table.columns.map((c) => ({
      name: c.name,
      type: c.nativeType ?? c.dataType,
      nullable: c.nullable,
    }));
  }

  private async baseline(
    bridgeId: string,
  ): Promise<{ columns: SchemaColumn[] | null; at: Date | null }> {
    const row = await this.prisma.bridge.findUnique({
      where: { id: bridgeId },
      select: { sourceColumnsJson: true, sourceColumnsAt: true },
    });
    try {
      return {
        columns: row?.sourceColumnsJson
          ? (JSON.parse(row.sourceColumnsJson) as SchemaColumn[])
          : null,
        at: row?.sourceColumnsAt ?? null,
      };
    } catch {
      return { columns: null, at: null };
    }
  }

  private async record(
    bridgeId: string,
    columns: SchemaColumn[],
  ): Promise<void> {
    await this.prisma.bridge.update({
      where: { id: bridgeId },
      data: {
        sourceColumnsJson: JSON.stringify(columns),
        sourceColumnsAt: new Date(),
      },
    });
    this.reported.delete(bridgeId);
  }

  /**
   * the table as it is now becomes what the bridge is built for — unless the
   * bridge still USES a column that went. accepting that would be the quiet way
   * back to what all of this exists to prevent: the change is forgotten, the
   * bridge starts, and the column is written as NULL. so the columns standing
   * in the way are returned instead (empty = accepted, or nothing to record).
   *
   * `moved`: the bridge now reads another table. the old one's columns say
   * nothing about it
   */
  async accept(
    bridge: ResolvedBridge,
    opts: { moved?: boolean } = {},
  ): Promise<string[]> {
    const now = await this.columnsNow(bridge);
    if (!now) return [];
    if (!opts.moved) {
      const { columns: baseline } = await this.baseline(bridge.id);
      const drift = baseline ? diffColumns(baseline, now) : null;
      const inTheWay = drift ? this.missingUsed(bridge, drift) : [];
      if (inTheWay.length > 0) return inTheWay;
    }
    await this.record(bridge.id, now);
    // types may have changed: what the sink remembered of the source is stale
    this.databaseSink.forget(bridge.id);
    return [];
  }

  /** for the bridge's page: read-only, changes nothing */
  async status(bridge: ResolvedBridge): Promise<BridgeSchemaDrift> {
    const { columns: baseline, at } = await this.baseline(bridge.id);
    const now = await this.columnsNow(bridge).catch(() => null);
    const drift = baseline && now ? diffColumns(baseline, now) : null;
    return {
      baselineAt: at?.toISOString() ?? null,
      checkedAt: new Date().toISOString(),
      drift,
      missingUsed: drift ? this.missingUsed(bridge, drift) : [],
    };
  }

  private missingUsed(bridge: ResolvedBridge, drift: SchemaDrift): string[] {
    const gone = new Set(drift.removed.map((c) => c.name));
    return columnsUsed(bridge).filter((name) => gone.has(name));
  }

  /**
   * look at the table, and act on the bridge's `onSchemaChange`. called before a
   * run starts and — on a live bridge — the moment a row arrives whose columns
   * are not the ones the last row had, BEFORE that row is written.
   */
  async check(bridge: ResolvedBridge): Promise<DriftVerdict> {
    let now: SchemaColumn[] | null;
    try {
      now = await this.columnsNow(bridge);
    } catch (err) {
      // a source that cannot be looked at is the run's problem, and it will say so itself
      this.logger.debug(
        `could not read the columns of ${bridge.id}: ${(err as Error).message}`,
      );
      return CLEAR;
    }
    if (!now) return CLEAR;

    const { columns: baseline } = await this.baseline(bridge.id);
    if (!baseline) {
      await this.record(bridge.id, now);
      return CLEAR;
    }
    const drift = diffColumns(baseline, now);
    if (!drift) return CLEAR;

    const policy = bridge.delivery.onSchemaChange ?? 'stop';
    const missingUsed = this.missingUsed(bridge, drift);
    const what = describeDrift(drift);

    if (missingUsed.length > 0 && policy !== 'continue') {
      const stop =
        `The source table "${bridge.source.kind === 'table' ? bridge.source.table : ''}" has changed, and this bridge uses ${missingUsed.length === 1 ? 'a column that is' : 'columns that are'} gone: ${missingUsed.join(', ')}. ` +
        `Stopped before writing NULL over what the destination holds. (${what}) ` +
        'Edit the bridge for the table as it is now — saving it accepts the new columns — and start it again.';
      this.say(
        bridge,
        `stop|${what}`,
        'critical',
        `Bridge "${bridge.name}" stopped: its source table changed`,
        stop,
      );
      return { drift, missingUsed, stop };
    }

    let evolved = '';
    if (policy === 'evolve' && drift.added.length > 0) {
      evolved = await this.evolve(bridge, drift.added).catch((err) => {
        this.logger.warn(
          `could not add columns for ${bridge.id}: ${(err as Error).message}`,
        );
        return ` Adding the new columns to the destination failed: ${(err as Error).message}`;
      });
    }
    this.say(
      bridge,
      `note|${what}|${evolved}`,
      'warning',
      `The source table of bridge "${bridge.name}" has changed`,
      `${what}.${evolved} ${missingUsed.length ? `The bridge uses ${missingUsed.join(', ')}, and carries on because it is set to.` : 'Nothing the bridge uses is gone, so it carries on.'} ` +
        'Open the bridge to review it; saving it accepts the table as it is now.',
    );
    // a column that was ADDED and is now part of the destination is no longer drift
    if (
      evolved &&
      !missingUsed.length &&
      !drift.removed.length &&
      !drift.retyped.length
    )
      await this.accept(bridge);
    else this.databaseSink.forget(bridge.id);
    return { drift, missingUsed, stop: null };
  }

  private say(
    bridge: ResolvedBridge,
    signature: string,
    severity: 'warning' | 'critical',
    title: string,
    message: string,
  ): void {
    if (this.reported.get(bridge.id) === signature) return;
    this.reported.set(bridge.id, signature);
    this.logger.warn(`${title}: ${message}`);
    this.alerts.emit({
      type: 'bridge.schema_drift',
      severity,
      title,
      message,
      bridgeId: bridge.id,
      bridgeName: bridge.name,
    });
  }

  /**
   * `evolve`: a column the source gained is added to every target that takes
   * the row as it comes (no explicit mapping — there the columns were CHOSEN)
   * and that Syncle may create tables on. typed by the same map a created
   * table is, nullable, never anything but an ADD.
   */
  private async evolve(
    bridge: ResolvedBridge,
    added: SchemaColumn[],
  ): Promise<string> {
    if (bridge.destination.kind !== 'database') return '';
    const sourceEngine = (
      await this.connections.get(bridge.source.connectionId)
    ).engine;
    const done: string[] = [];
    for (const target of bridge.destination.targets) {
      if (target.mapping.length > 0 || !target.createMissingTable) continue;
      const engine = (await this.connections.get(target.connectionId)).engine;
      const plan = planTargetTable(
        target.table,
        target.schema,
        added.map((c) => ({
          name: c.name,
          sourceType: c.type,
          nullable: true,
        })),
        [],
        engine,
        sourceEngine,
      );
      const added_ = await this.pool.withAdapter(
        target.connectionId,
        target.database,
        async (adapter) => {
          if (!adapter.addColumns) return false;
          const existing = await adapter.getSchema(target.database).then((s) =>
            s.namespaces
              .filter((n) => !target.schema || n.name === target.schema)
              .flatMap((n) => n.tables)
              .find((t) => t.name === target.table),
          );
          // no table yet: the next write creates it, with the new columns in it
          if (!existing) return false;
          const have = new Set(existing.columns.map((c) => c.name));
          const missing = plan.spec.columns.filter((c) => !have.has(c.name));
          if (missing.length === 0) return false;
          await adapter.addColumns({
            schema: target.schema,
            table: target.table,
            columns: missing,
          });
          return true;
        },
      );
      if (added_) done.push(target.table);
    }
    return done.length
      ? ` Added ${added.map((c) => c.name).join(', ')} to ${done.join(', ')}.`
      : '';
  }
}
