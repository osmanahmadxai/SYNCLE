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
 * project a source row onto the target's column names. an empty mapping means
 * "identity" (keep every column with its original name). `undefined` values are
 * normalized to `null` so drivers bind them as SQL NULL rather than erroring.
 */
export function mapRow(row: Row, mapping: ColumnMapping[]): Row {
  const out: Row = {};
  if (!mapping || mapping.length === 0) {
    for (const [k, v] of Object.entries(row)) out[k] = v === undefined ? null : v;
    return out;
  }
  for (const m of mapping) {
    out[m.target] = row[m.source] === undefined ? null : row[m.source];
  }
  return out;
}

/** the source column name that feeds a given target column under a mapping */
export function sourceColumnFor(target: string, mapping: ColumnMapping[]): string {
  const hit = mapping.find((m) => m.target === target);
  return hit ? hit.source : target;
}

/* -------------------------------------------------------------------------- */
/* portable type translation (source dataType string → target engine type)    */
/* -------------------------------------------------------------------------- */

export type PortableType =
  | 'integer'
  | 'bigint'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'json'
  | 'uuid'
  | 'text';

/**
 * collapse an engine-specific column type string into a portable category. errs
 * toward `text`, the universally-safe fallback, when nothing matches.
 */
export function normalizeType(dataType: string): PortableType {
  const t = (dataType || '').toLowerCase();
  if (/(^| )(uuid)/.test(t)) return 'uuid';
  if (/(bool)/.test(t)) return 'boolean';
  if (/(timestamp|datetime|^date$| date|time with|time without)/.test(t))
    return 'timestamp';
  if (/(json|jsonb|object|array|bson)/.test(t)) return 'json';
  if (/(bigint|int8|long)/.test(t)) return 'bigint';
  if (/(serial|^int|integer|int4|int2|smallint|tinyint|mediumint)/.test(t))
    return 'integer';
  if (/(numeric|decimal|real|double|float|money|number)/.test(t)) return 'number';
  return 'text';
}

/**
 * render a portable type as a concrete column type for the target engine. key
 * columns get an indexable type (e.g. MySQL `VARCHAR(255)` instead of `TEXT`,
 * which can't carry a primary key without a prefix length).
 */
export function engineColumnType(
  engine: DatabaseEngine,
  type: PortableType,
  isKey: boolean,
): string {
  switch (engine) {
    case 'postgres':
      return {
        integer: 'INTEGER',
        bigint: 'BIGINT',
        number: 'DOUBLE PRECISION',
        boolean: 'BOOLEAN',
        timestamp: 'TIMESTAMP',
        json: 'JSONB',
        uuid: 'UUID',
        text: 'TEXT',
      }[type];
    case 'mysql':
      return {
        integer: 'INT',
        bigint: 'BIGINT',
        number: 'DOUBLE',
        boolean: 'TINYINT(1)',
        timestamp: 'DATETIME',
        json: 'JSON',
        uuid: isKey ? 'VARCHAR(255)' : 'CHAR(36)',
        text: isKey ? 'VARCHAR(255)' : 'TEXT',
      }[type];
    case 'sqlite':
    default:
      return {
        integer: 'INTEGER',
        bigint: 'INTEGER',
        number: 'REAL',
        boolean: 'INTEGER',
        timestamp: 'TEXT',
        json: 'TEXT',
        uuid: 'TEXT',
        text: 'TEXT',
      }[type];
  }
}

/** a target column to (re)create: its name, the source type, and nullability */
export interface TargetColumnShape {
  name: string;
  sourceType: string;
  nullable: boolean;
}

/**
 * build a `CREATE TABLE` spec for `engine` from the projected target columns.
 * `keyColumns` become the primary key (so upserts have something to conflict
 * on); values are inserted verbatim, so nothing is marked auto-increment.
 */
export function buildCreateTableSpec(
  table: string,
  schema: string | undefined,
  columns: TargetColumnShape[],
  keyColumns: string[],
  engine: DatabaseEngine,
): CreateTableSpec {
  const keys = new Set(keyColumns);
  const defs: ColumnDefinition[] = columns.map((c) => {
    const isKey = keys.has(c.name);
    return {
      name: c.name,
      type: engineColumnType(engine, normalizeType(c.sourceType), isKey),
      // key columns must be NOT NULL to serve as a primary key
      nullable: isKey ? false : c.nullable,
      primaryKey: isKey,
      autoIncrement: false,
    };
  });
  return { table, schema, columns: defs };
}
