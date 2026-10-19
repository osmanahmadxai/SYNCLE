/**
 * what a bridge connects, spelled out: for each end, the connection, its
 * engine, where it runs and the database and table — and, between them, which
 * columns cross, how the bridge fires and how it writes. the bridge list and
 * the workspace map both say it, so both read it from here.
 *
 * nothing is fetched: it is all in the bridge and the workspace's connections,
 * which the page already holds. words are left to the components (the
 * translations live there); this returns the facts.
 */
import {
  destinationHost,
  type Bridge,
  type ConnectionConfig,
  type DatabaseEngine,
  type DatabaseTarget,
  type DeletePolicy,
} from '@syncle/core';

export interface EndpointSummary {
  connectionId: string;
  /** null when the connection is gone (deleted, or in another workspace) */
  connection: ConnectionConfig | null;
  connectionName: string | null;
  engine: DatabaseEngine | null;
  /**
   * where the database runs: `host:port`, or the file for SQLite. null when the
   * connection was saved as a connection string, which the API never sends back
   */
  address: string | null;
  /** the SSH host it is reached through, if any */
  via: string | null;
  database: string | null;
  /** `schema.table` (or the collection / key prefix); null for a custom query */
  table: string | null;
}

export interface TargetSummary extends EndpointSummary {
  writeMode: DatabaseTarget['writeMode'];
  keyColumns: string[];
  onDelete: DeletePolicy;
  softDeleteColumn: string | null;
  /** the columns this target receives; see {@link streamedColumns} */
  columns: StreamedColumns;
}

export interface HttpSummary {
  method: string;
  host: string;
  /** the path and query, without the host; '' for the root */
  path: string;
}

/** `null` = every column of the source, as it comes */
export type StreamedColumns = { source: string; target: string }[] | null;

export interface BridgeSummary {
  source: EndpointSummary;
  /** database destinations, one per target; empty for an HTTP destination */
  targets: TargetSummary[];
  http: HttpSummary | null;
  /** the source's conditions: only rows that meet them cross */
  filterCount: number;
  /** masking, casts and computed columns applied on the way */
  transformCount: number;
}

const qualified = (schema: string | undefined, table: string) =>
  schema ? `${schema}.${table}` : table;

function addressOf(connection: ConnectionConfig): string | null {
  if (connection.engine === 'sqlite') return connection.database || null;
  if (!connection.host) return null;
  return connection.port
    ? `${connection.host}:${connection.port}`
    : connection.host;
}

function endpoint(
  connectionId: string,
  byId: Map<string, ConnectionConfig>,
  database: string | undefined,
  table: string | null,
): EndpointSummary {
  const connection = byId.get(connectionId) ?? null;
  return {
    connectionId,
    connection,
    connectionName: connection?.name ?? null,
    engine: connection?.engine ?? null,
    address: connection ? addressOf(connection) : null,
    via: connection?.ssh?.host ?? null,
    // SQLite's "database" is the file, already shown as the address
    database:
      connection?.engine === 'sqlite'
        ? null
        : database || connection?.database || null,
    table,
  };
}

/**
 * the columns a database target receives. its own mapping when it has one —
 * that is exactly what is written, renames and all. without one every column
 * crosses under its own name, narrowed only by the HTTP field list, which a
 * database target does not read
 */
export function streamedColumns(target: DatabaseTarget): StreamedColumns {
  // (defaults may be missing from a bridge stored before they existed)
  const mapping = target.mapping ?? [];
  return mapping.length > 0
    ? mapping.map((m) => ({ source: m.source, target: m.target }))
    : null;
}

/** the HTTP payload's columns, when it names them */
export function httpColumns(bridge: Bridge): StreamedColumns {
  const fields = bridge.transform.fields;
  if (!fields || fields.length === 0) return null;
  const rename = bridge.transform.rename ?? {};
  return fields.map((f) => ({ source: f, target: rename[f] ?? f }));
}

function httpOf(url: string, method: string): HttpSummary {
  try {
    const u = new URL(url);
    const path =
      u.pathname === '/' && !u.search ? '' : `${u.pathname}${u.search}`;
    return { method, host: u.host, path };
  } catch {
    return { method, host: destinationHost(url), path: '' };
  }
}

export function summarizeBridge(
  bridge: Bridge,
  connections: ConnectionConfig[],
): BridgeSummary {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const src = bridge.source;
  const source = endpoint(
    src.connectionId,
    byId,
    src.database,
    src.kind === 'table' ? qualified(src.schema, src.table) : null,
  );

  const dest = bridge.destination;
  const targets: TargetSummary[] =
    dest.kind === 'database'
      ? dest.targets.map((t) => ({
          ...endpoint(
            t.connectionId,
            byId,
            t.database,
            qualified(t.schema, t.table),
          ),
          writeMode: t.writeMode ?? 'upsert',
          keyColumns: t.keyColumns ?? [],
          onDelete: t.onDelete ?? 'delete',
          softDeleteColumn: t.softDelete?.column ?? null,
          columns: streamedColumns(t),
        }))
      : [];

  return {
    source,
    targets,
    http: dest.kind === 'http' ? httpOf(dest.url, dest.method) : null,
    filterCount: src.kind === 'table' ? (src.filters?.length ?? 0) : 0,
    transformCount: bridge.transform.columns?.length ?? 0,
  };
}

/** `id, email, name +3` — a column list that fits on one line */
export function columnList(
  columns: { source: string; target: string }[],
  shown = 4,
): string {
  const names = columns.map((c) =>
    c.source === c.target ? c.source : `${c.source}→${c.target}`,
  );
  const head = names.slice(0, shown).join(', ');
  return names.length > shown ? `${head} +${names.length - shown}` : head;
}
