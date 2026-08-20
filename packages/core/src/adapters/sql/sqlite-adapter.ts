/** SQLite adapter backed by `better-sqlite3` (synchronous, single file) */
import { isAbsolute, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AdapterCapabilities,
  ColumnSchema,
  CreateTableSpec,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  QueryResult,
  TableSchema,
} from '../types';
import {
  BadRequestError,
  ConnectionError,
  QueryError,
  UnsupportedError,
} from '../../errors';
import {
  assertSafeDefaultValue,
  assertSafeIdentifier,
  BaseSqlAdapter,
  type SqlTransactionConnection,
} from './base-sql-adapter';

/**
 * better-sqlite3 only binds numbers, strings, bigints, buffers and null. coerce
 * the richer values that flow in from other engines (booleans, Dates, JSON
 * objects) into a storable scalar so a cross-engine bridge into SQLite works.
 */
function coerceSqliteParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export const SQLITE_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'sql',
  schemas: false,
  multipleDatabases: false,
  foreignKeys: true,
  rowEditing: true,
  transactions: true,
  ddl: true,
  manageDatabases: false,
  backupFormats: ['json', 'sql'],
};

export class SqliteAdapter extends BaseSqlAdapter {
  readonly engine = 'sqlite' as const;
  readonly capabilities = SQLITE_CAPABILITIES;

  private db: Database.Database | null = null;

  private getDb(): Database.Database {
    if (this.db) return this.db;
    let file = this.config.database ?? this.config.connectionString;
    if (!file) {
      throw new ConnectionError('SQLite requires a database file path');
    }
    // honor the server-configured jail: resolve relative paths under it and
    // refuse anything (including ../ traversal) that escapes it
    if (this.config.fileBaseDir) {
      const base = resolve(this.config.fileBaseDir);
      const resolved = isAbsolute(file) ? resolve(file) : resolve(base, file);
      if (resolved !== base && !resolved.startsWith(base + sep)) {
        throw new ConnectionError(
          `SQLite files are restricted to ${base} on this server`,
        );
      }
      file = resolved;
    }
    try {
      this.db = new Database(file, { fileMustExist: false });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      return this.db;
    } catch (err) {
      throw new ConnectionError(
        `Could not open SQLite database: ${(err as Error).message}`,
      );
    }
  }

  async connect(): Promise<void> {
    this.getDb();
  }

  async ping(): Promise<void> {
    this.getDb().prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  protected override quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  protected override placeholder(): string {
    return '?';
  }

  /** run one statement on a given db handle (shared by pooled + tx paths) */
  private runOnDb(
    db: Database.Database,
    sql: string,
    params: unknown[],
  ): QueryResult {
    const started = performance.now();
    const bound = params.map(coerceSqliteParam);
    try {
      const stmt = db.prepare(sql);
      const isSelect = stmt.reader;
      if (isSelect) {
        const rows = stmt.all(...(bound as never[])) as Array<
          Record<string, unknown>
        >;
        const columns = (stmt.columns?.() ?? []).map((c) => ({
          name: c.name,
          dataType: c.type ?? undefined,
        }));
        return {
          columns:
            columns.length > 0
              ? columns
              : rows[0]
                ? Object.keys(rows[0]).map((name) => ({ name }))
                : [],
          rows,
          rowCount: rows.length,
          executionMs: Math.round(performance.now() - started),
          command: 'SELECT',
        };
      }
      const info = stmt.run(...(bound as never[]));
      return {
        columns: [],
        rows: [],
        rowCount: info.changes,
        affectedRows: info.changes,
        executionMs: Math.round(performance.now() - started),
        command: sql.trim().split(/\s+/)[0]?.toUpperCase(),
      };
    } catch (err) {
      throw new QueryError((err as Error).message, { sql });
    }
  }

  protected override async execPooled(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    return this.runOnDb(this.getDb(), sql, params);
  }

  /**
   * SQLite is a single synchronous connection, so the "borrowed connection" is
   * just the same db handle guarded by explicit BEGIN/COMMIT/ROLLBACK. this is
   * a real transaction (better-sqlite3 executes statements synchronously, so no
   * other statement interleaves between BEGIN and COMMIT within this process).
   */
  protected override async acquireTransactionConnection(): Promise<SqlTransactionConnection> {
    const db = this.getDb();
    return {
      run: async (sql, params) => this.runOnDb(db, sql, params),
      begin: async () => {
        db.prepare('BEGIN').run();
      },
      commit: async () => {
        db.prepare('COMMIT').run();
      },
      rollback: async () => {
        if (db.inTransaction) db.prepare('ROLLBACK').run();
      },
      release: () => undefined,
    };
  }

  async listDatabases(): Promise<string[]> {
    return [this.config.database ?? 'main'];
  }

  async getSchema(): Promise<DatabaseSchema> {
    const db = this.getDb();
    const objects = db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string }>;

    const tables: TableSchema[] = [];
    for (const obj of objects) {
      const cols = db
        .prepare(`PRAGMA table_info(${this.quoteIdent(obj.name)})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      const fkRows = db
        .prepare(`PRAGMA foreign_key_list(${this.quoteIdent(obj.name)})`)
        .all() as Array<{ from: string; to: string; table: string }>;

      const fkByCol = new Map<string, { table: string; column: string }>();
      const foreignKeys: ForeignKeySchema[] = fkRows.map((r, i) => {
        fkByCol.set(r.from, { table: r.table, column: r.to });
        return {
          name: `fk_${obj.name}_${i}`,
          columns: [r.from],
          referencedTable: r.table,
          referencedColumns: [r.to],
        };
      });

      const idxRows = db
        .prepare(`PRAGMA index_list(${this.quoteIdent(obj.name)})`)
        .all() as Array<{ name: string; unique: number; origin: string }>;
      const indexes: IndexSchema[] = idxRows.map((ix) => {
        const info = db
          .prepare(`PRAGMA index_info(${this.quoteIdent(ix.name)})`)
          .all() as Array<{ name: string }>;
        return {
          name: ix.name,
          columns: info.map((c) => c.name),
          unique: ix.unique === 1,
          primary: ix.origin === 'pk',
        };
      });

      const columns: ColumnSchema[] = cols.map((c) => ({
        name: c.name,
        dataType: c.type || 'BLOB',
        nullable: c.notnull === 0,
        isPrimaryKey: c.pk > 0,
        isUnique: false,
        isAutoIncrement:
          c.pk > 0 && /INTEGER/i.test(c.type) && cols.filter((x) => x.pk > 0).length === 1,
        defaultValue: c.dflt_value != null ? String(c.dflt_value) : null,
        comment: null,
        references: fkByCol.get(c.name) ?? null,
      }));

      tables.push({
        name: obj.name,
        kind: obj.type === 'view' ? 'view' : 'table',
        columns,
        indexes,
        foreignKeys,
        primaryKey: cols.filter((c) => c.pk > 0).map((c) => c.name),
        estimatedRows: null,
        comment: null,
      });
    }

    return {
      database: this.config.database ?? 'main',
      namespaces: [{ name: '', tables }],
    };
  }

  /** SQLite caps bound placeholders at SQLITE_MAX_VARIABLE_NUMBER (32766) */
  protected override maxBindParams(): number {
    return 32_766;
  }

  /** SQLite needs the auto-increment PK declared inline */
  override async createTable(spec: CreateTableSpec): Promise<void> {
    if (!spec.columns.length) {
      throw new QueryError('A table needs at least one column');
    }
    const aiPk = spec.columns.find((c) => c.autoIncrement && c.primaryKey);
    const otherPk = spec.columns.filter((c) => c.primaryKey && c !== aiPk);
    // an inline `INTEGER PRIMARY KEY AUTOINCREMENT` plus a table-level
    // `PRIMARY KEY (...)` would emit two PRIMARY KEY clauses, which SQLite
    // rejects — and AUTOINCREMENT is only valid on a sole INTEGER PK anyway
    if (aiPk && otherPk.length > 0) {
      throw new BadRequestError(
        'SQLite AUTOINCREMENT requires the column to be the only primary-key ' +
          'column. Remove the other primary-key columns or the ' +
          'auto-increment flag.',
      );
    }
    const parts = spec.columns.map((c) => {
      const name = this.quoteIdent(assertSafeIdentifier(c.name));
      if (c === aiPk) return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
      let sql = `${name} ${this.validateType(c.type)}`;
      if (!c.nullable) sql += ' NOT NULL';
      if (c.unique && !c.primaryKey) sql += ' UNIQUE';
      if (c.defaultValue && c.defaultValue.trim()) {
        sql += ` DEFAULT ${assertSafeDefaultValue(c.defaultValue)}`;
      }
      return sql;
    });
    const pk = otherPk.map((c) => this.quoteIdent(c.name));
    if (pk.length) parts.push(`PRIMARY KEY (${pk.join(', ')})`);
    await this.runSql(
      `CREATE TABLE ${this.quoteIdent(assertSafeIdentifier(spec.table))} (${parts.join(', ')})`,
      [],
    );
  }

  override async truncateTable(table: string): Promise<void> {
    // SQLite has no TRUNCATE; DELETE is the equivalent
    await this.runSql(`DELETE FROM ${this.quoteIdent(table)}`, []);
  }

  override async createDatabase(): Promise<void> {
    throw new UnsupportedError(
      'SQLite is a single-file database; create a new connection instead.',
    );
  }

  override async dropDatabase(): Promise<void> {
    throw new UnsupportedError('SQLite does not support dropping databases.');
  }
}
