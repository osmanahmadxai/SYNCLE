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
 * into the same run/monitor machinery as an HTTP delivery: success only if
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
  buildCreateTableSpec,
  mapRow,
  type CdcOperation,
  type DatabaseTarget,
  type TargetColumnShape,
} from '@syncle/core';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import type { DeliveryOutcome } from './hooks.types';
import type { ResolvedHook } from './hooks.types';

type Row = Record<string, unknown>;
const SUMMARY_LIMIT = 16_384;

@Injectable()
export class DatabaseSinkService {
  private readonly logger = new Logger('DatabaseSink');
  /** targets we've already ensured exist this process (id → true) */
  private readonly ensured = new Set<string>();
  /** cached source column shapes per hook (resolved once) */
  private readonly sourceCols = new Map<string, TargetColumnShape[] | null>();

  constructor(
    private readonly pool: AdapterPoolService,
    private readonly connections: ConnectionStoreService,
  ) {}

  /** drop cached schema/existence state for a hook (on edit/delete) */
  forget(hookId: string): void {
    this.sourceCols.delete(hookId);
    // ensured keys are keyed by target identity, not hook, so leave them;
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
    hook: ResolvedHook,
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
      try {
        await this.ensureTarget(hook, target, rows[0] ?? {});
        const affected = await this.writeRows(target, rows, op);
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
    const mappedPreview = rows.map((r) => mapRow(r, targets[0]?.mapping ?? []));
    const serialized = JSON.stringify(
      mappedPreview.length === 1 ? mappedPreview[0] : mappedPreview,
    );
    const requestBody = serialized.slice(0, SUMMARY_LIMIT);

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
      bodyTruncated: serialized.length > SUMMARY_LIMIT,
      // checkpoint only matters while the delivery is failed; a success clears it
      succeededTargets: firstError ? succeeded : null,
    };
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
        // write the whole batch for this target, one row at a time
        const writeBatch = async (): Promise<void> => {
          for (const row of rows) {
            const mapped = mapRow(row, target.mapping);
            if (op === 'delete') {
              const identity = pick(mapped, target.keyColumns);
              const res = await adapter.deleteRow({
                schema: target.schema,
                table: target.table,
                identity,
              });
              affected += res.affectedRows ?? 0;
            } else if (target.writeMode === 'insert') {
              const res = await adapter.insertRow({
                schema: target.schema,
                table: target.table,
                values: mapped,
              });
              affected += res.affectedRows ?? 1;
            } else {
              if (target.keyColumns.length === 0) {
                throw new Error(
                  'Upsert needs at least one key column; set keys or use insert mode',
                );
              }
              const res = await adapter.upsertRow({
                schema: target.schema,
                table: target.table,
                values: mapped,
                keyColumns: target.keyColumns,
              });
              affected += res.affectedRows ?? 1;
            }
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
    hook: ResolvedHook,
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
      this.ensured.add(key);
      return;
    }

    if (!target.createMissingTable) {
      throw new Error(
        `Target table "${target.table}" does not exist (auto-create is off)`,
      );
    }

    const engine = (await this.connections.resolve(target.connectionId)).engine;
    const columns = await this.targetColumns(hook, target, sampleRow);
    if (columns.length === 0) {
      throw new Error('Cannot create target table: no columns to derive');
    }
    await this.pool.withAdapter(target.connectionId, target.database, (adapter) =>
      adapter.createTable(
        buildCreateTableSpec(
          target.table,
          target.schema,
          columns,
          target.keyColumns,
          engine,
        ),
      ),
    );
    this.logger.log(
      `Created target table ${targetLabel(target)} (${columns.length} cols)`,
    );
    this.ensured.add(key);
  }

  /**
   * the target's columns to create: the mapped target names, typed from the
   * source table's REAL column types (schema introspection, cached per hook)
   * so bridge.ts's normalizeType/engineColumnType translation gets a proper
   * dataType string — a pg BIGINT/NUMERIC arrives as a string at runtime and
   * would otherwise decay to TEXT. only when no schema is available (query
   * source, introspection failure, renamed column) do we fall back to
   * inferring a column's type from the sample row's runtime value.
   */
  private async targetColumns(
    hook: ResolvedHook,
    target: DatabaseTarget,
    sampleRow: Row,
  ): Promise<TargetColumnShape[]> {
    const source = await this.resolveSourceCols(hook);
    const byName = new Map((source ?? []).map((c) => [c.name, c]));
    const mappedSample = mapRow(sampleRow, target.mapping);

    // which target columns to create: the explicit mapping, else identity over
    // the source schema when known, else whatever the sample row carries
    const pairs: { name: string; source: string }[] =
      target.mapping.length > 0
        ? target.mapping.map((m) => ({ name: m.target, source: m.source }))
        : source
          ? source.map((c) => ({ name: c.name, source: c.name }))
          : Object.keys(mappedSample).map((name) => ({ name, source: name }));

    return pairs.map(({ name, source: sourceName }) => {
      const known = byName.get(sourceName);
      return {
        name,
        sourceType: known ? known.sourceType : inferType(mappedSample[name]),
        nullable: known ? known.nullable : !target.keyColumns.includes(name),
      };
    });
  }

  /**
   * the source table's column shapes (name / dataType / nullable), resolved
   * once per hook via schema introspection and cached in {@link sourceCols}.
   * a cached `null` means the shape is unknowable (query source, or
   * introspection failed) and callers fall back to sample-row inference.
   */
  private async resolveSourceCols(hook: ResolvedHook): Promise<TargetColumnShape[] | null> {
    const cached = this.sourceCols.get(hook.id);
    if (cached !== undefined) return cached;

    let cols: TargetColumnShape[] | null = null;
    if (hook.source.kind === 'table') {
      const src = hook.source;
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
            sourceType: c.dataType,
            nullable: c.nullable,
          }));
        }
      } catch {
        /* introspection unavailable (engine/permissions), fall back to inference */
      }
    }
    this.sourceCols.set(hook.id, cols);
    return cols;
  }
}

/* ----- helpers ----- */

function pick(row: Row, keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

function targetKey(t: DatabaseTarget): string {
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
