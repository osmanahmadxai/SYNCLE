/** PostgreSQL adapter backed by `pg` with a per-connection pool */
import {
  Pool,
  types as pgTypes,
  type PoolClient,
  type PoolConfig,
  type QueryResult as PgResult,
} from 'pg';
import { withDatabase } from '../connection-string';
import { nodeTlsOptions } from '../tls-options';
import type {
  InsertRowsParams,
  UpsertRowsParams,
  AdapterCapabilities,
  ColumnSchema,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  QueryResult,
  SchemaNamespace,
  TableSchema,
} from '../types';
import { ConnectionError, QueryError } from '../../errors';
import { quoteIdent } from '../../sql';
import {
  BaseSqlAdapter,
  type SqlTransactionConnection,
} from './base-sql-adapter';

/**
 * Temporal values are read as the TEXT Postgres sends, not as JavaScript Dates.
 *
 * `pg` turns date/timestamp columns into `Date` objects by default, and for a
 * tool whose job is to move a value unchanged that is wrong three times over:
 *
 *  - a `timestamp WITHOUT time zone` is a wall-clock reading. `pg` parses it in
 *    the PROCESS's zone, so '2026-03-04 05:06:07' became a Date meaning 00:36Z
 *    on a server running at UTC+4:30 — and any writer that formats Dates as UTC
 *    (the JSON bulk path, a MySQL or SQLite target) then stored a different
 *    time than the source holds. Correct only where the process sits in UTC.
 *  - a Date is millisecond-precise and Postgres is microsecond-precise, so
 *    every `now()`-stamped column was silently rounded on its way across.
 *  - a `date` is a calendar day, not an instant; as a Date it could land on the
 *    previous day once a zone offset was applied.
 *
 * An `interval` arrived as a `PostgresInterval` object, which no other driver
 * can bind. Its text form goes straight back into Postgres and is readable
 * anywhere else.
 *
 * The parsers are process-wide on purpose: the logical-replication client
 * decodes change events with these same `pg` parsers, so a row reads the same
 * whether it came from a replay or from the change stream.
 */
const RAW_TEXT_TYPES = {
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
} as const;
const RAW_TEXT_ARRAY_TYPES = {
  _date: 1182,
  _timestamp: 1115,
  _timestamptz: 1185,
  _interval: 1187,
} as const;

/**
 * split a Postgres array literal into its elements, leaving each as text.
 * pg-types' typings and its runtime disagree on this API's shape (a function
 * vs. an object with `create`), so both are accepted.
 */
function parseTextArray(value: string): unknown[] {
  const keep = (element: string): string => element;
  const api = pgTypes.arrayParser as unknown as
    | ((source: string, transform: (e: string) => unknown) => unknown[])
    | { create(source: string, transform: (e: string) => unknown): { parse(): unknown[] } };
  return typeof api === 'function' ? api(value, keep) : api.create(value, keep).parse();
}

// the array OIDs are real but absent from pg-types' `TypeId` enum
const setParser = pgTypes.setTypeParser as unknown as (
  oid: number,
  parse: (value: string) => unknown,
) => void;

for (const oid of Object.values(RAW_TEXT_TYPES)) {
  setParser(oid, (value) => value);
}
for (const oid of Object.values(RAW_TEXT_ARRAY_TYPES)) {
  // still an array, as every other array type is — just of untouched text
  setParser(oid, parseTextArray);
}

export const POSTGRES_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'sql',
  schemas: true,
  multipleDatabases: true,
  foreignKeys: true,
  rowEditing: true,
  transactions: true,
  ddl: true,
  keysetPaging: true,
  manageDatabases: true,
  backupFormats: ['json', 'sql'],
};

export class PostgresAdapter extends BaseSqlAdapter {
  readonly engine = 'postgres' as const;
  readonly capabilities = POSTGRES_CAPABILITIES;

  private pool: Pool | null = null;
  /** last error emitted by an idle pooled client (kept for diagnostics) */
  private lastPoolError: Error | null = null;

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const cfg: PoolConfig = this.config.connectionString
      ? // pg lets the string win over a `database` beside it, so the database
        // that was actually asked for has to go INTO the string
        { connectionString: withDatabase(this.config.connectionString, this.config.database) }
      : {
          host: this.config.host,
          port: this.config.port ?? 5432,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
        };
    cfg.max = 5;
    cfg.idleTimeoutMillis = 30_000;
    cfg.connectionTimeoutMillis = 10_000;
    // what "TLS" means is decided in one place for every driver (tls-options).
    // a connection string that names its own sslmode keeps it: pg lets the
    // string win over this field
    const ssl = nodeTlsOptions(this.config);
    if (ssl) cfg.ssl = ssl;
    this.pool = new Pool(cfg);
    // an idle client losing its connection emits 'error' on the pool; with no
    // listener Node treats it as an unhandled 'error' event and crashes the
    // process. core has no logger, so just remember it — the next query will
    // surface the failure to the caller anyway
    this.pool.on('error', (err) => {
      this.lastPoolError = err;
    });
    return this.pool;
  }

  async connect(): Promise<void> {
    await this.ping();
  }

  async ping(): Promise<void> {
    try {
      const client = await this.getPool().connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    } catch (err) {
      throw new ConnectionError(
        `Could not connect to PostgreSQL: ${(err as Error).message}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Bulk writes that carry the rows as ONE json parameter instead of one
   * parameter per value.
   *
   * A multi-row INSERT binds `rows × columns` parameters, and the wire protocol
   * caps that at 65,535 — so a large batch has to be split into several
   * statements no matter how much the caller batched, and each split pays a
   * parse and a round trip. `json_populate_recordset(null::table, $1)` binds a
   * single value however many rows it carries, and takes its column types from
   * the target table itself, so no introspection is needed.
   *
   * It is also the ONLY correct path for a structured value. As a bound
   * parameter `pg` serialises a JavaScript array as a Postgres array literal
   * — right for an `integer[]` column, wrong for a `jsonb` one, and the driver
   * cannot know which it is writing to. `[1,2]` bound to jsonb is a syntax
   * error; `[]` is worse, because `{}` is valid JSON and lands as an empty
   * OBJECT with no error at all. Here the target table's own column types do
   * the casting, so a JSON array becomes an array in an array column and stays
   * JSON in a json column. Any batch holding an array or object therefore takes
   * this path whatever its size — two paths with different semantics on either
   * side of a row-count threshold is how the same data synced differently in a
   * backfill than it did live.
   */
  private needsJsonPath(rows: Array<Record<string, unknown>>): boolean {
    if (rows.length >= PostgresAdapter.JSON_BULK_MIN) return true;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (
          v !== null &&
          typeof v === 'object' &&
          !(v instanceof Date) &&
          !(v instanceof Uint8Array)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** rows below this are cheaper as a plain multi-row INSERT */
  private static readonly JSON_BULK_MIN = 250;

  override async insertRows(p: InsertRowsParams): Promise<QueryResult> {
    if (!this.needsJsonPath(p.rows)) return super.insertRows(p);
    return this.jsonBulk(p.table, p.schema, p.rows, '');
  }

  override async upsertRows(p: UpsertRowsParams): Promise<QueryResult> {
    if (p.keyColumns.length === 0 || !this.needsJsonPath(p.rows)) {
      return super.upsertRows(p);
    }
    // grouped by column set, because the tail names the columns to update
    let affected = 0;
    for (const [, group] of this.groupRows(p.rows)) {
      const tail = this.upsertClause(p.keyColumns, Object.keys(group[0] ?? {}));
      const res = await this.jsonBulk(p.table, p.schema, group, tail);
      affected += res.affectedRows ?? group.length;
    }
    return {
      affectedRows: affected,
      rowCount: affected,
      rows: [],
      columns: [],
      executionMs: 0,
    };
  }

  /** group rows by their exact column set; sparse streams need this */
  private groupRows(
    rows: Array<Record<string, unknown>>,
  ): Map<string, Array<Record<string, unknown>>> {
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = JSON.stringify(Object.keys(row).sort());
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }
    return groups;
  }

  /** one statement, one parameter, however many rows */
  private async jsonBulk(
    table: string,
    schema: string | undefined,
    rows: Array<Record<string, unknown>>,
    tail: string,
  ): Promise<QueryResult> {
    const target = this.qualify(table, schema);
    const columns = Object.keys(rows[0] ?? {});
    if (columns.length === 0) {
      return { affectedRows: 0, rowCount: 0, rows: [], columns: [], executionMs: 0 };
    }
    const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
    const sql =
      `INSERT INTO ${target} (${colSql}) ` +
      `SELECT ${colSql} FROM json_populate_recordset(null::${target}, $1::json) ` +
      tail;
    const res = await this.runSql(sql.trim(), [JSON.stringify(rows.map(toJsonRow))]);
    return {
      affectedRows: res.affectedRows ?? rows.length,
      rowCount: res.affectedRows ?? rows.length,
      rows: [],
      columns: [],
      executionMs: res.executionMs ?? 0,
    };
  }

  protected override quoteIdent(identifier: string): string {
    return quoteIdent('postgres', identifier);
  }

  protected override placeholder(index: number): string {
    return `$${index}`;
  }

  protected override likeKeyword(): string {
    return 'ILIKE';
  }

  protected override serialType(): string {
    return 'SERIAL';
  }

  protected override booleanLiteral(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
  }

  protected override readOnlyBeginSql(): string {
    return 'BEGIN TRANSACTION READ ONLY';
  }

  protected override hexLiteral(buf: Buffer): string {
    return `'\\x${buf.toString('hex')}'`;
  }

  protected override async execPooled(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    const started = performance.now();
    try {
      const raw = (await this.getPool().query(sql, params)) as
        | PgResult
        | PgResult[];
      return normalizePgResult(raw, started);
    } catch (err) {
      throw new QueryError((err as Error).message, { sql });
    }
  }

  /** borrow a single pooled client and drive BEGIN/COMMIT/ROLLBACK on it */
  protected override async acquireTransactionConnection(): Promise<SqlTransactionConnection> {
    const client: PoolClient = await this.getPool().connect();
    return {
      run: async (sql, params) => {
        const started = performance.now();
        try {
          const raw = (await client.query(sql, params)) as
            | PgResult
            | PgResult[];
          return normalizePgResult(raw, started);
        } catch (err) {
          throw new QueryError((err as Error).message, { sql });
        }
      },
      begin: async () => {
        await client.query('BEGIN');
      },
      commit: async () => {
        await client.query('COMMIT');
      },
      rollback: async () => {
        await client.query('ROLLBACK');
      },
      release: () => client.release(),
    };
  }

  protected override async countRows(args: {
    table: string;
    schema?: string;
    hasFilters: boolean;
  }): Promise<{ total: number | null; estimated: boolean }> {
    // exact COUNT(*) on a large filtered view is expensive, skip it
    if (args.hasFilters) return { total: null, estimated: false };
    // use the planner's row estimate, instant, no table scan
    const target = this.qualify(args.table, args.schema);
    const res = await this.runSql(
      `SELECT reltuples::bigint AS count FROM pg_class WHERE oid = $1::regclass`,
      [target],
    ).catch(() => null);
    const n = res?.rows[0] ? Number(res.rows[0].count) : null;
    // reltuples is -1 (PG14+) / 0 for never-analyzed tables, report unknown
    if (n == null || n < 1) return { total: null, estimated: false };
    return { total: n, estimated: true };
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.runSql(
      `SELECT datname FROM pg_database
       WHERE datistemplate = false ORDER BY datname`,
      [],
    );
    return res.rows.map((r) => String(r.datname));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const database =
      this.config.database ??
      (await this.runSql('SELECT current_database() AS db', [])).rows[0]?.db;

    // columns across all user schemas in one pass
    const cols = await this.runSql(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
              c.is_nullable, c.column_default, c.ordinal_position
       FROM information_schema.columns c
       WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      [],
    );

    // the precise spelling of each column's type. information_schema drops
    // everything a bridge needs to recreate a column faithfully: precision and
    // scale, varchar length, an array's element type. a domain is resolved to
    // the base type it wraps, since the domain itself exists in this database
    // only. best-effort: without it the looser `data_type` is used as before
    const fullTypes = await this.runSql(
      `SELECT n.nspname AS table_schema, c.relname AS table_name,
              a.attname AS column_name,
              CASE WHEN t.typtype = 'd'
                   THEN format_type(t.typbasetype, t.typtypmod)
                   ELSE format_type(a.atttypid, a.atttypmod)
              END AS full_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
      [],
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    const fullTypeOf = new Map<string, string>();
    for (const r of fullTypes.rows) {
      fullTypeOf.set(
        `${r.table_schema}.${r.table_name}.${r.column_name}`,
        String(r.full_type),
      );
    }

    const relkind = await this.runSql(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m')
         AND n.nspname NOT IN ('pg_catalog','information_schema')`,
      [],
    );

    const pks = await this.runSql(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'`,
      [],
    );

    const fks = await this.runSql(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table,
              ccu.column_name AS ref_column, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'`,
      [],
    );

    const indexes = await this.runSql(
      `SELECT schemaname AS schema, tablename AS table, indexname AS name,
              indexdef
       FROM pg_indexes
       WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      [],
    );

    return buildSchema(String(database ?? ''), {
      cols: cols.rows,
      relkind: relkind.rows,
      pks: pks.rows,
      fks: fks.rows,
      indexes: indexes.rows,
      fullTypeOf,
    });
  }
}

type Row = Record<string, unknown>;

/** shape a raw `pg` result (or multi-statement array) into a QueryResult */
function normalizePgResult(
  raw: PgResult | PgResult[],
  started: number,
): QueryResult {
  const executionMs = Math.round(performance.now() - started);
  // a multi-statement query makes `pg` return an ARRAY of results, one per
  // statement — report the last one (matches psql's behavior)
  const res = Array.isArray(raw) ? raw[raw.length - 1]! : raw;
  return {
    columns: (res.fields ?? []).map((f) => ({
      name: f.name,
      dataType: String(f.dataTypeID),
    })),
    rows: res.rows as Array<Record<string, unknown>>,
    rowCount: res.rowCount ?? res.rows.length,
    affectedRows: /^(INSERT|UPDATE|DELETE)/i.test(res.command)
      ? (res.rowCount ?? 0)
      : undefined,
    executionMs,
    command: res.command,
  };
}

function buildSchema(
  database: string,
  data: {
    cols: Row[];
    relkind: Row[];
    pks: Row[];
    fks: Row[];
    indexes: Row[];
    /** `schema.table.column` → the column's precise type, where known */
    fullTypeOf?: Map<string, string>;
  },
): DatabaseSchema {
  const kindMap = new Map<string, string>();
  for (const r of data.relkind) {
    kindMap.set(`${r.schema}.${r.name}`, String(r.relkind));
  }

  const pkSet = new Set<string>();
  for (const r of data.pks) {
    pkSet.add(`${r.table_schema}.${r.table_name}.${r.column_name}`);
  }

  const fkByTable = new Map<string, ForeignKeySchema[]>();
  const fkColTarget = new Map<string, { table: string; column: string; schema?: string }>();
  for (const r of data.fks) {
    const key = `${r.table_schema}.${r.table_name}`;
    const list = fkByTable.get(key) ?? [];
    list.push({
      name: String(r.constraint_name),
      columns: [String(r.column_name)],
      referencedSchema: String(r.ref_schema),
      referencedTable: String(r.ref_table),
      referencedColumns: [String(r.ref_column)],
    });
    fkByTable.set(key, list);
    fkColTarget.set(`${key}.${r.column_name}`, {
      schema: String(r.ref_schema),
      table: String(r.ref_table),
      column: String(r.ref_column),
    });
  }

  const idxByTable = new Map<string, IndexSchema[]>();
  for (const r of data.indexes) {
    const key = `${r.schema}.${r.table}`;
    const def = String(r.indexdef);
    const colMatch = def.match(/\(([^)]+)\)/);
    const columns = colMatch
      ? colMatch[1]!.split(',').map((c) => c.trim().replace(/"/g, ''))
      : [];
    const list = idxByTable.get(key) ?? [];
    list.push({
      name: String(r.name),
      columns,
      unique: /UNIQUE/i.test(def),
      primary: false,
    });
    idxByTable.set(key, list);
  }

  const tableMap = new Map<string, TableSchema>();
  for (const r of data.cols) {
    const schema = String(r.table_schema);
    const name = String(r.table_name);
    const key = `${schema}.${name}`;
    let table = tableMap.get(key);
    if (!table) {
      const relkind = kindMap.get(key);
      table = {
        name,
        schema,
        kind:
          relkind === 'v'
            ? 'view'
            : relkind === 'm'
              ? 'materialized_view'
              : 'table',
        columns: [],
        indexes: idxByTable.get(key) ?? [],
        foreignKeys: fkByTable.get(key) ?? [],
        primaryKey: [],
        estimatedRows: null,
        comment: null,
      };
      tableMap.set(key, table);
    }
    const isPk = pkSet.has(`${key}.${r.column_name}`);
    const column: ColumnSchema = {
      name: String(r.column_name),
      dataType: String(r.data_type),
      nativeType: data.fullTypeOf?.get(`${key}.${r.column_name}`),
      nullable: r.is_nullable === 'YES',
      isPrimaryKey: isPk,
      isUnique: false,
      isAutoIncrement: /nextval/.test(String(r.column_default ?? '')),
      defaultValue: r.column_default != null ? String(r.column_default) : null,
      comment: null,
      references: fkColTarget.get(`${key}.${r.column_name}`) ?? null,
    };
    table.columns.push(column);
    if (isPk) table.primaryKey.push(column.name);
  }

  const namespaces = new Map<string, SchemaNamespace>();
  for (const table of tableMap.values()) {
    const ns = table.schema ?? 'public';
    const bucket = namespaces.get(ns) ?? { name: ns, tables: [] };
    bucket.tables.push(table);
    namespaces.set(ns, bucket);
  }

  return {
    database: String(database),
    namespaces: [...namespaces.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}

/**
 * a row as JSON that `json_populate_recordset` can cast back to the column's
 * type. JSON has no word for bytes or for integers past 2^53, so those travel
 * as the text form Postgres itself reads: `\x…` hex for bytea, plain digits for
 * bigint/numeric. a Date is an instant and goes as ISO-8601 with its `Z`.
 */
function toJsonRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = toJsonValue(v);
  return out;
}

function toJsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v); // NaN, ±Infinity
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`;
  if (Array.isArray(v)) return v.map(toJsonValue);
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJsonValue(x);
    return out;
  }
  return v; // a wrapper with its own toJSON
}
