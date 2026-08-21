/** MySQL / MariaDB adapter backed by `mysql2` with a per-connection pool */
import mysql, {
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';
import type {
  AdapterCapabilities,
  ColumnSchema,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  QueryResult,
  TableSchema,
} from '../types';
import { ConnectionError, QueryError } from '../../errors';
import { quoteIdent } from '../../sql';
import {
  BaseSqlAdapter,
  type SqlTransactionConnection,
} from './base-sql-adapter';

/**
 * mysql2 escapes plain objects into `key = 'value'` pairs and arrays into
 * comma lists, which silently corrupts statements when structured values flow
 * in from other engines (e.g. Postgres jsonb rows crossing a bridge). coerce
 * them to portable scalars, mirroring the SQLite adapter's approach.
 */
function coerceMysqlParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export const MYSQL_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'sql',
  schemas: false,
  multipleDatabases: true,
  foreignKeys: true,
  rowEditing: true,
  transactions: true,
  ddl: true,
  manageDatabases: true,
  backupFormats: ['json', 'sql'],
};

export class MysqlAdapter extends BaseSqlAdapter {
  readonly engine = 'mysql' as const;
  readonly capabilities = MYSQL_CAPABILITIES;

  private pool: Pool | null = null;

  private getPool(): Pool {
    if (this.pool) return this.pool;
    // shared driver options applied to BOTH config styles, so a
    // connection-string setup gets the same date semantics, pool sizing and
    // timeouts as a field-by-field one
    const shared = {
      connectionLimit: 5,
      connectTimeout: 10_000,
      namedPlaceholders: false,
      dateStrings: true,
      // BIGINT/DECIMAL beyond 2^53 would otherwise be silently rounded as
      // JS numbers
      supportBigNumbers: true,
      bigNumberStrings: true,
    } as const;
    this.pool = this.config.connectionString
      ? mysql.createPool({ uri: this.config.connectionString, ...shared })
      : mysql.createPool({
          host: this.config.host,
          port: this.config.port ?? 3306,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
          ...shared,
        });
    return this.pool;
  }

  async connect(): Promise<void> {
    await this.ping();
  }

  async ping(): Promise<void> {
    try {
      const conn = await this.getPool().getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }
    } catch (err) {
      throw new ConnectionError(
        `Could not connect to MySQL: ${(err as Error).message}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  protected override quoteIdent(identifier: string): string {
    return quoteIdent('mysql', identifier);
  }

  protected override placeholder(): string {
    return '?';
  }

  protected override autoIncrementKeyword(): string {
    return 'AUTO_INCREMENT';
  }

  /**
   * MySQL treats backslash as an escape character inside string literals;
   * leaving it unescaped corrupts a SQL dump and lets a crafted value break
   * out of the literal when the dump is restored.
   */
  protected override escapeStringLiteral(text: string): string {
    return text.replace(/'/g, "''").replace(/\\/g, '\\\\');
  }

  /**
   * MySQL has no `ON CONFLICT`, it upserts via `ON DUPLICATE KEY UPDATE` which
   * keys off any unique/primary index on the row (the `keyColumns` must be one).
   */
  protected override upsertClause(
    keyColumns: string[],
    allColumns: string[],
  ): string {
    const updates = allColumns
      .filter((c) => !keyColumns.includes(c))
      .map((c) => `${this.quoteIdent(c)} = VALUES(${this.quoteIdent(c)})`);
    // nothing to update → keep the existing row, but make it a no-op upsert by
    // re-assigning a key column to itself (valid + idempotent)
    if (updates.length === 0) {
      const k = this.quoteIdent(keyColumns[0]!);
      return `ON DUPLICATE KEY UPDATE ${k} = ${k}`;
    }
    return `ON DUPLICATE KEY UPDATE ${updates.join(', ')}`;
  }

  protected override async execPooled(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    try {
      const started = performance.now();
      const [rows, fields] = await this.getPool().query(
        sql,
        params.map(coerceMysqlParam),
      );
      return normalizeMysqlResult(sql, rows, fields, started);
    } catch (err) {
      throw new QueryError((err as Error).message, { sql });
    }
  }

  /** borrow a pooled connection and drive its native transaction API */
  protected override async acquireTransactionConnection(): Promise<SqlTransactionConnection> {
    const conn: PoolConnection = await this.getPool().getConnection();
    return {
      run: async (sql, params) => {
        try {
          const started = performance.now();
          const [rows, fields] = await conn.query(
            sql,
            params.map(coerceMysqlParam),
          );
          return normalizeMysqlResult(sql, rows, fields, started);
        } catch (err) {
          throw new QueryError((err as Error).message, { sql });
        }
      },
      begin: () => conn.beginTransaction(),
      commit: () => conn.commit(),
      rollback: () => conn.rollback(),
      release: () => conn.release(),
    };
  }

  protected override async countRows(args: {
    table: string;
    hasFilters: boolean;
  }): Promise<{ total: number | null; estimated: boolean }> {
    if (args.hasFilters) return { total: null, estimated: false };
    // InnoDB exposes a fast row estimate in information_schema
    const res = await this.runSql(
      `SELECT table_rows AS count FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [args.table],
    ).catch(() => null);
    const n = res?.rows[0] ? Number(res.rows[0].count) : null;
    if (n == null || n < 1) return { total: null, estimated: false };
    return { total: n, estimated: true };
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.runSql(
      `SELECT schema_name AS \`schema_name\` FROM information_schema.schemata
       WHERE schema_name NOT IN
         ('information_schema','performance_schema','mysql','sys')
       ORDER BY schema_name`,
      [],
    );
    return res.rows.map((r) => String(r.schema_name ?? r.SCHEMA_NAME));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const database =
      this.config.database ??
      String(
        (await this.runSql('SELECT DATABASE() AS db', [])).rows[0]?.db ?? '',
      );
    if (!database) {
      throw new ConnectionError('No database selected for this connection');
    }

    const pool = this.getPool();
    // Some MySQL servers return information_schema column names upper-cased
    // (e.g. TABLE_NAME), so normalize every result row's keys to lower case
    // before reading them — otherwise table names / primary keys come back empty.
    const [colRaw] = await pool.query<RowDataPacket[]>(
      `SELECT table_name, column_name, column_type, is_nullable,
              column_default, column_key, extra, table_type, ordinal_position
       FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [database],
    );
    const colRows = colRaw.map(lowerKeys);

    const [fkRaw] = await pool.query<RowDataPacket[]>(
      `SELECT table_name, column_name, constraint_name,
              referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
      [database],
    );
    const fkRows = fkRaw.map(lowerKeys);

    const [idxRaw] = await pool.query<RowDataPacket[]>(
      `SELECT table_name, index_name, column_name, non_unique
       FROM information_schema.statistics
       WHERE table_schema = ?
       ORDER BY table_name, index_name, seq_in_index`,
      [database],
    );
    const idxRows = idxRaw.map(lowerKeys);

    const fkByTableCol = new Map<string, { table: string; column: string }>();
    const fkByTable = new Map<string, ForeignKeySchema[]>();
    for (const r of fkRows) {
      const t = String(r.table_name);
      fkByTableCol.set(`${t}.${r.column_name}`, {
        table: String(r.referenced_table_name),
        column: String(r.referenced_column_name),
      });
      const list = fkByTable.get(t) ?? [];
      list.push({
        name: String(r.constraint_name),
        columns: [String(r.column_name)],
        referencedTable: String(r.referenced_table_name),
        referencedColumns: [String(r.referenced_column_name)],
      });
      fkByTable.set(t, list);
    }

    const idxByTable = new Map<string, Map<string, IndexSchema>>();
    for (const r of idxRows) {
      const t = String(r.table_name);
      const map = idxByTable.get(t) ?? new Map<string, IndexSchema>();
      const name = String(r.index_name);
      const existing = map.get(name) ?? {
        name,
        columns: [],
        unique: Number(r.non_unique) === 0,
        primary: name === 'PRIMARY',
      };
      existing.columns.push(String(r.column_name));
      map.set(name, existing);
      idxByTable.set(t, map);
    }

    const tableMap = new Map<string, TableSchema>();
    for (const r of colRows) {
      const name = String(r.table_name);
      let table = tableMap.get(name);
      if (!table) {
        table = {
          name,
          kind: r.table_type === 'VIEW' ? 'view' : 'table',
          columns: [],
          indexes: [...(idxByTable.get(name)?.values() ?? [])],
          foreignKeys: fkByTable.get(name) ?? [],
          primaryKey: [],
          estimatedRows: null,
          comment: null,
        };
        tableMap.set(name, table);
      }
      const isPk = r.column_key === 'PRI';
      const column: ColumnSchema = {
        name: String(r.column_name),
        dataType: String(r.column_type),
        nullable: r.is_nullable === 'YES',
        isPrimaryKey: isPk,
        isUnique: r.column_key === 'UNI',
        isAutoIncrement: String(r.extra).includes('auto_increment'),
        defaultValue:
          r.column_default != null ? String(r.column_default) : null,
        comment: null,
        references: fkByTableCol.get(`${name}.${r.column_name}`) ?? null,
      };
      table.columns.push(column);
      if (isPk) table.primaryKey.push(column.name);
    }

    return {
      database,
      namespaces: [{ name: '', tables: [...tableMap.values()] }],
    };
  }
}

/** shape a raw `mysql2` query response into a normalized QueryResult */
function normalizeMysqlResult(
  sql: string,
  rows: unknown,
  fields: FieldPacket[] | undefined,
  started: number,
): QueryResult {
  const executionMs = Math.round(performance.now() - started);
  if (Array.isArray(rows)) {
    return {
      columns: (fields ?? []).map((f) => ({
        name: f.name,
        dataType: String(f.type),
      })),
      rows: rows as Array<Record<string, unknown>>,
      rowCount: rows.length,
      executionMs,
      command: 'SELECT',
    };
  }
  const result = rows as { affectedRows?: number };
  return {
    columns: [],
    rows: [],
    rowCount: result.affectedRows ?? 0,
    affectedRows: result.affectedRows ?? 0,
    executionMs,
    command: sql.trim().split(/\s+/)[0]?.toUpperCase(),
  };
}

/**
 * return a copy of a result row with all keys lower-cased. MySQL servers differ
 * in whether `information_schema` columns come back lower- or upper-cased, so
 * normalizing keeps the introspection code reading a single, predictable shape.
 */
function lowerKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}
