/**
 * database destination: writes each delivered row into one or more target
 * databases (a "bridge"). cross-engine by construction, it only speaks the
 * adapter contract, so a Postgres source can feed MySQL, SQLite, Mongo, etc.
 *
 * idempotency: `upsert` mode writes keyed by the target's key columns, so a
 * replay or an at-least-once redelivery never duplicates. CDC deletes route to
 * a keyed delete. when a target table is missing and `createMissingTable` is
 * on, the table is created once from the source's column shape.
 *
 * a write to N targets is reported as ONE {@link DeliveryOutcome} so it slots
 * into the same job/monitor machinery as an HTTP delivery: success only if
 * every target succeeded, otherwise failed (and safely retryable for upserts).
 *
 * atomicity: each target's batch is written inside a single transaction on
 * transaction-capable engines (Postgres/MySQL/SQLite), so the batch commits
 * all-or-nothing. that closes the partial-batch hole: if row 3 fails, rows 1–2
 * roll back too, so a retry of the failed batch can't double-apply the rows
 * that had committed. engines without ACID (Mongo/Redis) rely on idempotent
 * per-row upsert/delete instead, which is equally retry-safe.
 *
 * cross-target retry: the delivery is still reported failed if ANY target
 * fails (the monitor depends on that single-outcome contract), but the outcome
 * carries the keys of the targets that DID commit ({@link DeliveryOutcome}'s
 * `succeededTargets`, persisted with the delivery row). a retry passes those
 * back as `skipTargets` so already-committed targets are skipped, not re-run —
 * without that checkpoint, `insert` mode would duplicate target A's atomic
 * batch on every retry that only target B needs.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  UnsupportedError,
  mapRow,
  planTargetTable,
  rowConverterFor,
  transformedType,
  canBecomeNull,
  columnsAdded,
  copiedColumn,
  type CdcOperation,
  type ColumnTypeWarning,
  type DatabaseEngine,
  type DatabaseTarget,
  type TargetColumnShape,
} from '@syncle/core';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import type { DeliveryOutcome } from './bridges.types';
import type { ResolvedBridge } from './bridges.types';

type Row = Record<string, unknown>;
const SUMMARY_LIMIT = 16_384;

@Injectable()
export class DatabaseSinkService {
  private readonly logger = new Logger('DatabaseSink');
  /** targets we've already ensured exist this process (id → true) */
  private readonly ensured = new Set<string>();
  /** cached source column shapes per bridge (resolved once) */
  private readonly sourceCols = new Map<string, TargetColumnShape[] | null>();
  /**
   * cached value converters, per bridge and target (`null` = nothing to
   * convert). see `value-map.ts`: what a driver READS for a column is not
   * always something another engine's driver can WRITE.
   */
  private readonly converters = new Map<string, ((row: Row) => Row) | null>();

  constructor(
    private readonly pool: AdapterPoolService,
    private readonly connections: ConnectionStoreService,
  ) {}

  /** drop cached schema/existence state for a bridge (on edit/delete) */
  forget(bridgeId: string): void {
    this.sourceCols.delete(bridgeId);
    for (const key of this.converters.keys()) {
      if (key.startsWith(`${bridgeId}::`)) this.converters.delete(key);
    }
    // ensured keys are keyed by target identity, not bridge, so leave them;
    // a changed target table name produces a new key anyway.
  }

  /**
   * write a batch of rows to every target. `op` is the CDC operation when the
   * rows came from a change stream (`delete` removes by key); for replay/watch
   * it's undefined and rows are inserted/upserted per the target's writeMode.
   * `skipTargets` are target keys that already committed on a previous attempt
   * (from the persisted delivery); those are skipped, never re-written.
   */
  async deliver(
    bridge: ResolvedBridge,
    targets: DatabaseTarget[],
    rows: Row[],
    op: CdcOperation | undefined,
    skipTargets?: ReadonlySet<string>,
  ): Promise<DeliveryOutcome> {
    const started = performance.now();
    const summaries: string[] = [];
    const succeeded: string[] = [];
    let firstError: string | null = null;

    for (const target of targets) {
      const label = targetLabel(target);
      const key = targetKey(target);
      // committed on an earlier attempt of this same delivery: skip, but keep
      // it in the succeeded set so the checkpoint survives another failure
      if (skipTargets?.has(key)) {
        succeeded.push(key);
        summaries.push(`${label}: skipped (already written by a previous attempt)`);
        continue;
      }
      // a target with no key columns (append-only `insert` mode) has nothing to
      // delete BY. attempting it builds an empty WHERE, which every engine
      // rejects — so each delete on the source would fail the whole delivery
      if (op === 'delete' && target.keyColumns.length === 0) {
        succeeded.push(key);
        summaries.push(`${label}: delete not applied (target has no key columns)`);
        continue;
      }
      try {
        await this.ensureTarget(bridge, target, rows[0] ?? {});
        if (op === 'truncate') {
          summaries.push(`${label}: ${await this.truncate(target)}`);
          succeeded.push(key);
          continue;
        }
        const convert = await this.converterFor(bridge, target);
        const affected = await this.writeRows(
          target,
          convert ? rows.map(convert) : rows,
          op,
        );
        succeeded.push(key);
        summaries.push(`${label}: ${op === 'delete' ? 'deleted' : 'wrote'} ${affected}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        firstError ??= `${label}: ${message}`;
        summaries.push(`${label}: FAILED ${message}`);
      }
    }

    // requestBody mirrors what we attempted to write (mapped to the first
    // target's columns), so the monitor can show the exact payload
    const { requestBody, bodyTruncated } = previewBody(rows, targets);

    return {
      status: firstError ? 'failed' : 'success',
      httpStatus: null,
      attempts: 1,
      error: firstError,
      requestBody,
      responseBody: summaries.join('\n').slice(0, SUMMARY_LIMIT) || null,
      durationMs: Math.round(performance.now() - started),
      op: op ?? null,
      // a capped capture can't be replayed faithfully; the resend path refuses it
      bodyTruncated,
      // checkpoint only matters while the delivery is failed; a success clears it
      succeededTargets: firstError ? succeeded : null,
    };
  }

  /** empty one target, as the source was emptied */
  private async truncate(target: DatabaseTarget): Promise<string> {
    return this.pool.withAdapter(target.connectionId, target.database, async (adapter) => {
      try {
        await adapter.truncateTable(target.table, target.schema);
        return 'truncated';
      } catch (err) {
        // a key-value store has no table to empty; say so rather than fail a
        // bridge over an operation its destination has no word for
        if (err instanceof UnsupportedError) {
          return 'truncate not applied (this engine has no tables to truncate)';
        }
        throw err;
      }
    });
  }

  /** write every row to one target, returning the affected-row count */
  private async writeRows(
    target: DatabaseTarget,
    rows: Row[],
    op: CdcOperation | undefined,
  ): Promise<number> {
    let affected = 0;
    await this.pool.withAdapter(
      target.connectionId,
      target.database,
      async (adapter) => {
        const { schema, table } = target;

        // one set-based statement per batch where the engine supports it,
        // otherwise the original row-at-a-time loop. Both paths must produce
        // the same rows and the same `affected` count — only the number of
        // round trips differs.
        const writeBatch = async (): Promise<void> => {
          const mapped = rows.map((row) => mapRow(row, target.mapping));
          const isUpsert = op !== 'delete' && target.writeMode !== 'insert';
          if (isUpsert && target.keyColumns.length === 0) {
            throw new Error(
              'Upsert needs at least one key column; set keys or use insert mode',
            );
          }

          if (op === 'delete') {
            const identities = mapped.map((m) => pick(m, target.keyColumns));
            // a delete that does not say WHICH row is not a smaller delete: it
            // matches nothing, reports "deleted 0", and the row stays for ever.
            // that is a failure, and it has to look like one
            for (const identity of identities) {
              const blank = target.keyColumns.find(
                (k) => identity[k] === undefined || identity[k] === null,
              );
              if (blank !== undefined) {
                throw new Error(
                  `the delete carries no value for key column "${blank}", so it cannot say which row to remove. ` +
                    'The source only sends its own key with a delete: key this target on that, ' +
                    'or make the source send whole rows (PostgreSQL: REPLICA IDENTITY FULL; MongoDB: pre-images).',
                );
              }
            }
            if (adapter.deleteRows) {
              const res = await adapter.deleteRows({ schema, table, identities });
              affected += res.affectedRows ?? 0;
              return;
            }
            for (const identity of identities) {
              const res = await adapter.deleteRow({ schema, table, identity });
              affected += res.affectedRows ?? 0;
            }
            return;
          }

          if (target.writeMode === 'insert') {
            if (adapter.insertRows) {
              const res = await adapter.insertRows({ schema, table, rows: mapped });
              affected += res.affectedRows ?? mapped.length;
              return;
            }
            for (const values of mapped) {
              const res = await adapter.insertRow({ schema, table, values });
              affected += res.affectedRows ?? 1;
            }
            return;
          }

          if (adapter.upsertRows) {
            const res = await adapter.upsertRows({
              schema,
              table,
              rows: mapped,
              keyColumns: target.keyColumns,
            });
            affected += res.affectedRows ?? mapped.length;
            return;
          }
          for (const values of mapped) {
            const res = await adapter.upsertRow({
              schema,
              table,
              values,
              keyColumns: target.keyColumns,
            });
            affected += res.affectedRows ?? 1;
          }
        };

        // make the batch atomic where the engine supports it: on any failure
        // the whole batch rolls back, so a retry can't double-apply a committed
        // prefix. a rollback means none of these writes persisted, so restore
        // the running `affected` count to what it was before the batch.
        if (adapter.capabilities.transactions && adapter.withTransaction) {
          const before = affected;
          try {
            await adapter.withTransaction(writeBatch);
          } catch (err) {
            affected = before;
            throw err;
          }
        } else {
          await writeBatch();
        }
      },
    );
    return affected;
  }

  /**
   * make sure the target table exists, creating it from the source's column
   * shape when `createMissingTable` is set. runs at most once per target per
   * process (cheap existence probe), so it never adds per-row overhead.
   */
  private async ensureTarget(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
    sampleRow: Row,
  ): Promise<void> {
    const key = targetKey(target);
    if (this.ensured.has(key)) return;

    const exists = await this.pool.withAdapter(
      target.connectionId,
      target.database,
      async (adapter) => {
        try {
          await adapter.browse({
            schema: target.schema,
            table: target.table,
            limit: 1,
            offset: 0,
          });
          return true;
        } catch {
          return false;
        }
      },
    );

    if (exists) {
      // The target being present does NOT mean its key is indexed. A MongoDB
      // collection springs into existence on first write, so this branch is the
      // one a Mongo destination always takes — and without the index every
      // upsert is a collection scan. ensureKeyIndex is idempotent.
      await this.ensureKeyIndex(target);
      this.ensured.add(key);
      return;
    }

    if (!target.createMissingTable) {
      throw new Error(
        `Target table "${target.table}" does not exist (auto-create is off)`,
      );
    }

    const plan = await this.planTable(bridge, target, sampleRow);
    if (plan.spec.columns.length === 0) {
      throw new Error('Cannot create target table: no columns to derive');
    }
    await this.pool.withAdapter(target.connectionId, target.database, (adapter) =>
      adapter.createTable(plan.spec),
    );
    this.logger.log(
      `Created target table ${targetLabel(target)} (${plan.spec.columns.length} cols)`,
    );
    // a column the target cannot represent faithfully is said out loud, once,
    // at the moment the table is made — not discovered later as a bad value
    for (const w of plan.warnings) {
      this.logger.warn(
        `${targetLabel(target)}.${w.column} (${w.sourceType} → ${w.targetType}): ${w.message}`,
      );
    }
    await this.ensureKeyIndex(target);
    this.ensured.add(key);
  }

  /**
   * Ask the destination to index the columns this target upserts on, where the
   * engine needs it. Relational engines index their primary key already and do
   * not implement this; MongoDB does. Failure is logged, not fatal — a missing
   * index makes writes slow, not wrong.
   */
  private async ensureKeyIndex(target: DatabaseTarget): Promise<void> {
    if (target.writeMode !== 'upsert' || target.keyColumns.length === 0) return;
    try {
      await this.pool.withAdapter(target.connectionId, target.database, (adapter) =>
        adapter.ensureKeyIndex
          ? adapter.ensureKeyIndex({
              schema: target.schema,
              table: target.table,
              columns: target.keyColumns,
            })
          : Promise.resolve(),
      );
    } catch (err) {
      this.logger.warn(
        `Could not index key columns on ${targetLabel(target)} — upserts will be slower: ${(err as Error).message}`,
      );
    }
  }

  /**
   * the `CREATE TABLE` a target would get, and every column it cannot hold
   * faithfully. used when the table is actually created, and by the preview so
   * the DDL can be read BEFORE anything runs.
   */
  async planTable(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
    sampleRow: Row,
  ): Promise<{ spec: ReturnType<typeof planTargetTable>['spec']; warnings: ColumnTypeWarning[] }> {
    const engine = (await this.connections.resolve(target.connectionId)).engine;
    const columns = await this.targetColumns(bridge, target, sampleRow);
    // type names are read in the SOURCE engine's dialect, but only when they
    // really came from its catalog; inferred types are engine-neutral
    const known = await this.resolveSourceCols(bridge);
    const sourceEngine = known ? await this.sourceEngine(bridge) : undefined;
    return planTargetTable(
      target.table,
      target.schema,
      columns,
      target.keyColumns,
      engine,
      sourceEngine,
    );
  }

  /**
   * how this bridge's rows have to change to be writable on this target, or
   * null when they don't (always, between two instances of one engine). built
   * from the source's column types, so it needs the schema: a query source, or
   * a source that cannot be introspected, is written as read.
   */
  private async converterFor(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
  ): Promise<((row: Row) => Row) | null> {
    const cacheKey = `${bridge.id}::${targetKey(target)}`;
    const cached = this.converters.get(cacheKey);
    if (cached !== undefined) return cached;

    let convert: ((row: Row) => Row) | null = null;
    try {
      const columns = await this.resolveSourceCols(bridge);
      const source = columns ? await this.sourceEngine(bridge) : undefined;
      if (columns && source) {
        const engine = (await this.connections.resolve(target.connectionId)).engine;
        // a transformed column no longer holds what its source type says (a
        // boolean cast to text, a timestamp hashed): converting it by the
        // SOURCE's type would mangle it. it is converted by what it has become,
        // which is spelled the PostgreSQL way
        const transforms = bridge.transform.columns;
        const byName = new Map(columns.map((c) => [c.name, c]));
        const untouched: TargetColumnShape[] = [];
        const reshaped: { name: string; sourceType: string }[] = [];
        // the columns the steps ADD are in the row too, and need converting as
        // much as any other: a `{{$now}}` cast to a date, a copy of a timestamp
        for (const name of [...byName.keys(), ...columnsAdded(transforms, [...byName.keys()])]) {
          const sourceType = transformedType(transforms, name);
          if (sourceType) {
            reshaped.push({ name, sourceType });
            continue;
          }
          // a plain copy holds what its origin holds, under its own name
          const origin = byName.get(copiedColumn(transforms, name) ?? name);
          if (origin) untouched.push({ ...origin, name });
        }
        const first = rowConverterFor(untouched, source, engine);
        const second = reshaped.length ? rowConverterFor(reshaped, 'postgres', engine) : null;
        convert = first && second ? (row) => second(first(row)) : (first ?? second);
      }
    } catch {
      convert = null; // unknown shape: write what was read, as before
    }
    this.converters.set(cacheKey, convert);
    return convert;
  }

  /**
   * what a run would do to this target's TABLE, without doing it: is it there,
   * and if not, exactly which columns it would be created with and which of
   * them cannot hold everything the source column can. nothing is written.
   */
  async describeTarget(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
    sampleRow: Row,
  ): Promise<{
    exists: boolean | null;
    columns?: Array<{
      name: string;
      sourceType: string;
      type: string;
      nullable: boolean;
      primaryKey: boolean;
    }>;
    warnings: ColumnTypeWarning[];
  }> {
    let exists: boolean | null;
    try {
      exists = await this.pool.withAdapter(target.connectionId, target.database, (adapter) =>
        adapter
          .browse({ schema: target.schema, table: target.table, limit: 1, offset: 0 })
          .then(
            () => true,
            () => false,
          ),
      );
    } catch {
      exists = null; // the target connection itself is unreachable
    }
    if (exists !== false || !target.createMissingTable) return { exists, warnings: [] };

    const plan = await this.planTable(bridge, target, sampleRow);
    const shapes = await this.targetColumns(bridge, target, sampleRow);
    const sourceTypeOf = new Map(shapes.map((c) => [c.name, c.sourceType]));
    return {
      exists,
      columns: plan.spec.columns.map((c) => ({
        name: c.name,
        sourceType: sourceTypeOf.get(c.name) ?? '',
        type: c.type,
        nullable: c.nullable,
        primaryKey: c.primaryKey,
      })),
      warnings: plan.warnings,
    };
  }

  private async sourceEngine(bridge: ResolvedBridge): Promise<DatabaseEngine | undefined> {
    try {
      return (await this.connections.resolve(bridge.source.connectionId)).engine;
    } catch {
      return undefined;
    }
  }

  /**
   * the target's columns to create: the mapped target names, typed from the
   * source table's REAL column types (schema introspection, cached per bridge)
   * so bridge.ts's normalizeType/engineColumnType translation gets a proper
   * dataType string — a pg BIGINT/NUMERIC arrives as a string at runtime and
   * would otherwise decay to TEXT. only when no schema is available (query
   * source, introspection failure, renamed column) do we fall back to
   * inferring a column's type from the sample row's runtime value.
   */
  private async targetColumns(
    bridge: ResolvedBridge,
    target: DatabaseTarget,
    sampleRow: Row,
  ): Promise<TargetColumnShape[]> {
    const source = await this.resolveSourceCols(bridge);
    const byName = new Map((source ?? []).map((c) => [c.name, c]));
    const mappedSample = mapRow(sampleRow, target.mapping);

    // which target columns to create: the explicit mapping, else identity over
    // the source schema when known, else whatever the sample row carries
    const steps = bridge.transform.columns;
    const pairs: { name: string; source: string }[] =
      target.mapping.length > 0
        ? target.mapping.map((m) => ({ name: m.target, source: m.source }))
        : source
          ? [
              ...source.map((c) => c.name),
              // an identity mapping sends the whole row, and the row has the
              // columns the steps ADD: a table without them would refuse it
              ...columnsAdded(steps, source.map((c) => c.name)),
            ].map((name) => ({ name, source: name }))
          : Object.keys(mappedSample).map((name) => ({ name, source: name }));

    return pairs.map(({ name, source: sourceName }) => {
      // a plain copy of a column (`{{price}}`) is typed like the column it copies
      const known = byName.get(copiedColumn(steps, sourceName) ?? sourceName);
      const isKey = target.keyColumns.includes(name);
      // NOT NULL at the source means nothing once a step can write NULL
      const nullable =
        (known ? known.nullable : !isKey) || (!isKey && canBecomeNull(steps, sourceName));
      // what the transforms turned the column INTO decides its type: a hashed
      // integer is text, and created as an integer it would refuse every row
      const reshaped = transformedType(steps, sourceName);
      if (reshaped) return { name, sourceType: reshaped, generic: true, nullable };
      return {
        name,
        sourceType: known ? known.sourceType : inferType(mappedSample[name]),
        nullable,
      };
    });
  }

  /**
   * the source table's column shapes (name / dataType / nullable), resolved
   * once per bridge via schema introspection and cached in {@link sourceCols}.
   * a cached `null` means the shape is unknowable (query source, or
   * introspection failed) and callers fall back to sample-row inference.
   */
  private async resolveSourceCols(bridge: ResolvedBridge): Promise<TargetColumnShape[] | null> {
    const cached = this.sourceCols.get(bridge.id);
    if (cached !== undefined) return cached;

    let cols: TargetColumnShape[] | null = null;
    if (bridge.source.kind === 'table') {
      const src = bridge.source;
      try {
        const schema = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
          a.getSchema(src.database),
        );
        const table = schema.namespaces
          .filter((ns) => !src.schema || ns.name === src.schema)
          .flatMap((ns) => ns.tables)
          .find((t) => t.name === src.table);
        if (table) {
          cols = table.columns.map((c) => ({
            name: c.name,
            // the precise spelling where the engine gives one: Postgres'
            // catalog label drops precision, length and array element types
            sourceType: c.nativeType ?? c.dataType,
            nullable: c.nullable,
          }));
        }
      } catch {
        /* introspection unavailable (engine/permissions), fall back to inference */
      }
    }
    this.sourceCols.set(bridge.id, cols);
    return cols;
  }
}

/* ----- helpers ----- */

/**
 * the capped payload shown in the monitor for a set of rows: mapped to the
 * first target's columns, exactly as {@link DatabaseSinkService.deliver} records
 * it. `bodyTruncated` marks a capture that can no longer be replayed faithfully.
 */
export function previewBody(
  rows: Row[],
  targets: DatabaseTarget[],
): { requestBody: string; bodyTruncated: boolean } {
  const mapped = rows.map((r) => mapRow(r, targets[0]?.mapping ?? []));
  const serialized = JSON.stringify(mapped.length === 1 ? mapped[0] : mapped);
  return {
    requestBody: serialized.slice(0, SUMMARY_LIMIT),
    bodyTruncated: serialized.length > SUMMARY_LIMIT,
  };
}

function pick(row: Row, keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

/** stable identity of a target, as persisted in `succeededTargets` checkpoints */
export function targetKey(t: DatabaseTarget): string {
  return `${t.connectionId}::${t.database ?? ''}::${t.schema ?? ''}::${t.table}`;
}

function targetLabel(t: DatabaseTarget): string {
  return t.schema ? `${t.schema}.${t.table}` : t.table;
}

/** infer a portable-ish type string from a runtime value (for auto-create) */
function inferType(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'double';
  }
  if (typeof value === 'bigint') return 'bigint';
  if (value instanceof Date) return 'timestamp';
  if (value && typeof value === 'object') return 'json';
  return 'text';
}
