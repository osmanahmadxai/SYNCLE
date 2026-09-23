/**
 * pure helpers for database-to-database bridges: projecting a source row onto a
 * target's columns, and translating a source table's shape into a portable
 * `CREATE TABLE` spec for a (possibly different-engine) target.
 *
 * framework-agnostic and engine-agnostic: the API sink layer supplies the
 * source column metadata and the target engine, this module decides the names
 * and types. kept here (not in an adapter) so the web preview can render the
 * exact same mapping the runner will perform.
 */
import type {
  ColumnDefinition,
  CreateTableSpec,
  DatabaseEngine,
} from '../adapters/types';
import type { ColumnMapping, BridgeDestination } from './bridge-config';
import { translateColumnType } from './type-map';

/* -------------------------------------------------------------------------- */
/* display helpers (shared by web list / map / panel)                         */
/* -------------------------------------------------------------------------- */

/** compact destination descriptor passed to the monitor UI for headers/cURL */
export interface EndpointInfo {
  kind: 'http' | 'database';
  /** HTTP URL, or a database target label */
  url: string;
  /** HTTP method, or "WRITE" for a database target */
  method: string;
}

/** the hostname of an HTTP destination URL, falling back to the raw string */
export function destinationHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * a short, human label for any destination. HTTP → "POST host", database → the
 * target table(s) it writes into. used by the bridge list, map and header.
 */
export function destinationLabel(dest: BridgeDestination): string {
  if (dest.kind === 'database') {
    const labels = dest.targets.map((t) =>
      t.schema ? `${t.schema}.${t.table}` : t.table,
    );
    const first = labels[0] ?? 'database';
    return labels.length > 1 ? `${first} +${labels.length - 1}` : first;
  }
  return `${dest.method} ${destinationHost(dest.url)}`;
}

/** a stable per-destination grouping key for the workspace map's right column */
export function destinationNodeKeys(dest: BridgeDestination): string[] {
  if (dest.kind === 'database') {
    return dest.targets.map((t) => {
      const tbl = t.schema ? `${t.schema}.${t.table}` : t.table;
      return `db:${t.connectionId}:${tbl}`;
    });
  }
  return [`http:${destinationHost(dest.url)}`];
}

type Row = Record<string, unknown>;

/**
 * a column the change did NOT carry, as opposed to one it set to NULL.
 *
 * PostgreSQL leaves a large (TOASTed) value out of an UPDATE's row image when
 * the UPDATE did not touch it. that is "unchanged", and the only correct thing
 * to do with it is nothing: writing NULL — what an absent value used to decay
 * to — erased the destination's copy of every large column on every update of
 * its row. a registered symbol, so it is one value across bundles and can never
 * be mistaken for data.
 */
export const UNCHANGED = Symbol.for('syncle.unchanged');

/**
 * where a row has ALREADY been, when it is one that a bridge wrote and another
 * bridge is now reading back (see the API's EchoGuardService): the tables the
 * change has passed through. carried on the row under a symbol, so that it goes
 * wherever the row goes — a copy of the row (`{ ...row }`) keeps it — and is
 * never data: `Object.keys`, `Object.entries`, `JSON.stringify`, every mapping
 * and every driver ignore it, so it cannot reach a destination or a payload.
 * what builds a NEW row column by column (a mapping, a codec) drops it, and
 * carries it over by hand where it matters.
 */
export const ORIGINS = Symbol.for('syncle.origins');

/** the tables this row has been through already; empty for a change somebody made */
export function originsOf(row: Row): string[] {
  const value = (row as Record<symbol, unknown>)[ORIGINS];
  return Array.isArray(value) ? (value as string[]) : [];
}

/** the same row, remembering where it has been */
export function withOrigins<T extends Row>(row: T, origins: readonly string[]): T {
  if (origins.length === 0) return row;
  return Object.assign({}, row, { [ORIGINS]: [...origins] }) as T;
}

/**
 * project a source row onto the target's column names. an empty mapping means
 * "identity" (keep every column with its original name). `undefined` values are
 * normalized to `null` so drivers bind them as SQL NULL rather than erroring;
 * a column marked {@link UNCHANGED} is left out of the write altogether.
 */
export function mapRow(row: Row, mapping: ColumnMapping[]): Row {
  const out: Row = {};
  if (!mapping || mapping.length === 0) {
    for (const [k, v] of Object.entries(row)) {
      if (v !== UNCHANGED) out[k] = v === undefined ? null : v;
    }
    return out;
  }
  for (const m of mapping) {
    const v = row[m.source];
    if (v !== UNCHANGED) out[m.target] = v === undefined ? null : v;
  }
  return out;
}

/** the source column name that feeds a given target column under a mapping */
export function sourceColumnFor(target: string, mapping: ColumnMapping[]): string {
  const hit = mapping.find((m) => m.target === target);
  return hit ? hit.source : target;
}

/* -------------------------------------------------------------------------- */
/* auto-created destination tables                                            */
/* -------------------------------------------------------------------------- */

/** a target column to (re)create: its name, the source type, and nullability */
export interface TargetColumnShape {
  name: string;
  /** the source column's native type, as precisely as the source reports it */
  sourceType: string;
  nullable: boolean;
  /**
   * `sourceType` is not the source engine's spelling: a column transform changed
   * what the column holds (a hashed integer is text), and the type is given in
   * PostgreSQL's spelling for the type map to read with no source engine
   */
  generic?: boolean;
}

/** a column whose target type cannot hold everything the source type can */
export interface ColumnTypeWarning {
  column: string;
  sourceType: string;
  targetType: string;
  message: string;
}

export interface TargetTablePlan {
  spec: CreateTableSpec;
  /** empty when every column translates faithfully */
  warnings: ColumnTypeWarning[];
}

/**
 * plan the `CREATE TABLE` for `engine` from the projected target columns, and
 * report every column the target cannot represent faithfully. `keyColumns`
 * become the primary key (so upserts have something to conflict on); values are
 * inserted verbatim, so nothing is marked auto-increment.
 *
 * `sourceEngine` matters: `timestamp`, `float` and `int` do not mean the same
 * thing in every engine. leave it undefined when the columns did not come from
 * schema introspection (a query source, or types inferred from a sample row).
 */
export function planTargetTable(
  table: string,
  schema: string | undefined,
  columns: TargetColumnShape[],
  keyColumns: string[],
  engine: DatabaseEngine,
  sourceEngine?: DatabaseEngine,
): TargetTablePlan {
  const keys = new Set(keyColumns);
  const warnings: ColumnTypeWarning[] = [];
  const defs: ColumnDefinition[] = columns.map((c) => {
    const isKey = keys.has(c.name);
    const plan = translateColumnType(c.sourceType, {
      // a transformed column's type is not the source engine's to read
      source: c.generic ? undefined : sourceEngine,
      target: engine,
      isKey,
    });
    for (const message of plan.warnings) {
      warnings.push({
        column: c.name,
        sourceType: c.sourceType,
        targetType: plan.type,
        message,
      });
    }
    return {
      name: c.name,
      type: plan.type,
      // key columns must be NOT NULL to serve as a primary key
      nullable: isKey ? false : c.nullable,
      primaryKey: isKey,
      autoIncrement: false,
    };
  });
  return { spec: { table, schema, columns: defs }, warnings };
}

/** {@link planTargetTable} for callers that only need the spec */
export function buildCreateTableSpec(
  table: string,
  schema: string | undefined,
  columns: TargetColumnShape[],
  keyColumns: string[],
  engine: DatabaseEngine,
  sourceEngine?: DatabaseEngine,
): CreateTableSpec {
  return planTargetTable(table, schema, columns, keyColumns, engine, sourceEngine).spec;
}
