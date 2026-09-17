/**
 * core adapter contract.
 *
 * every database engine Syncle supports (relational, document, key-value,
 * or anything added later) implements {@link DatabaseAdapter}. the rest of the
 * app (API routes, UI) depends ONLY on these types, never on a concrete driver.
 * so adding a new engine means: implement this interface and register it, that's it.
 *
 * this module is intentionally framework-agnostic: no Next.js, React, or Node
 * server imports. pure domain logic, unit-testable in isolation
 */

export type DatabaseEngine =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mongodb'
  | 'redis';

/** the query dialect an engine exposes to the editor surface */
export type QueryLanguage = 'sql' | 'mongo' | 'redis' | 'none';

/**
 * declarative description of what an engine can do. the UI reads these to
 * enable/disable features (e.g. hide the ER diagram tab for Redis) instead of
 * branching on the engine name all over the place
 */
export interface AdapterCapabilities {
  /** supports arbitrary user-authored queries in the editor */
  query: boolean;
  /** the language the query editor should use */
  queryLanguage: QueryLanguage;
  /** has a schema/namespace layer above tables (e.g. Postgres schemas) */
  schemas: boolean;
  /** supports multiple databases/catalogs on one connection */
  multipleDatabases: boolean;
  /** exposes foreign-key relationships (drives the ER diagram) */
  foreignKeys: boolean;
  /** supports row-level insert/update/delete through the data grid */
  rowEditing: boolean;
  /** whether transactions are available for batched mutations */
  transactions: boolean;
  /** supports creating / dropping / truncating tables (or collections) */
  ddl: boolean;
  /** supports creating / dropping databases on this connection */
  manageDatabases: boolean;
  /** backup/restore formats this engine can produce/consume */
  backupFormats: BackupFormat[];
  /**
   * `browse` can page by an opaque cursor ({@link BrowseParams.cursor}), and a
   * reader that means to see EVERY row must use it: the engine has no order to
   * page by (Redis — its keys come out of SCAN in hash-table order, so neither
   * `key > last` nor an OFFSET into a fresh scan is a stable place)
   */
  cursorPaging?: boolean;
}

/* -------------------------------------------------------------------------- */
/* connection configuration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * optional SSH tunnel in front of a network engine: the server dials the SSH
 * host and port-forwards to the database, so the adapter connects to a local
 * loopback port instead of the (unreachable) database host directly. sqlite is
 * file-based and never tunnels. like `password`, the secret fields
 * (`password` / `privateKey` / `passphrase`) are encrypted at rest and only
 * ever decrypted inside the server process — this module carries the shape
 * only, the tunnel runtime lives in the API server
 */
export interface SshTunnelConfig {
  enabled: boolean;
  /** SSH server (jump host) to dial */
  host: string;
  /** SSH port, default 22 */
  port?: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  /** for authMethod "password" */
  password?: string;
  /** PEM-encoded private key, for authMethod "privateKey" */
  privateKey?: string;
  /** passphrase protecting the private key, if any */
  passphrase?: string;
  /**
   * the jump host's public-key fingerprint, as OpenSSH prints it
   * (`SHA256:…`, from `ssh-keygen -lf` or the first-connect prompt). when set,
   * a host presenting any other key is refused. when empty, the key seen on the
   * first successful connection is recorded here and enforced from then on —
   * the same trust-on-first-use rule `ssh` itself follows with known_hosts.
   */
  hostKey?: string;
}

/**
 * a saved connection. engine-specific validation happens in each adapter; the
 * shared shape keeps the store and UI uniform. `password` is only ever present
 * in decrypted form inside the server process, it's encrypted at rest
 */
/**
 * how far a TLS connection is trusted. the names and meanings are libpq's
 * `sslmode`, because that is the vocabulary people already have:
 *
 *  - `disable`     no TLS
 *  - `require`     encrypted, but the server's certificate is NOT checked — it
 *                  stops a passive eavesdropper and nothing else: anyone who
 *                  can sit in the path can present any certificate
 *  - `verify-ca`   the certificate must chain to a trusted CA (the one given,
 *                  or the system's), whatever name it was issued for
 *  - `verify-full` …and it must have been issued for the host being dialled.
 *                  the only mode that actually authenticates the server
 */
export type TlsMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface TlsConfig {
  mode: TlsMode;
  /** PEM CA certificate(s) to trust instead of the system store */
  ca?: string;
  /** PEM client certificate, for servers that require mutual TLS */
  cert?: string;
  /** PEM private key for `cert` (secret: encrypted at rest, returned redacted) */
  key?: string;
  /**
   * the name the server's certificate must carry, when it is not the host
   * being dialled — an IP address in `host`, say, or a load balancer's name
   */
  servername?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  /** the workspace this connection belongs to */
  workspaceId: string;
  engine: DatabaseEngine;
  /** optional accent color for the UI (hex) */
  color?: string;
  /** nothing is written through this connection (see `connectionInputSchema.readOnly`) */
  readOnly?: boolean;
  /** what this database is: shown wherever the connection is */
  environment?: 'production' | 'staging' | 'development';
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** database name, or file path for SQLite */
  database?: string;
  /**
   * legacy on/off switch, kept in step with `tls` (true = any mode but
   * `disable`). connections saved before `tls` existed carry only this; see
   * `effectiveTls` for what it meant on each engine.
   */
  ssl?: boolean;
  /** TLS settings; takes precedence over `ssl` */
  tls?: TlsConfig;
  /** full connection URI; when present, takes precedence over discrete fields */
  connectionString?: string;
  /** free-form engine-specific options (e.g. Mongo authSource, Redis db index) */
  options?: Record<string, unknown>;
  /**
   * server-set restriction (never user input): when present, file-backed
   * engines (SQLite) may only open paths under this directory
   */
  fileBaseDir?: string;
  /**
   * server-set (never user input): the database's real host when `host` has
   * been rewritten to an SSH tunnel's loopback end. TLS has to verify the
   * certificate against THIS name — the tunnel's 127.0.0.1 is on no certificate.
   */
  tlsHostOverride?: string;
  /** reach the database through an SSH tunnel (network engines only) */
  ssh?: SshTunnelConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * a connection without the assigned id / timestamps (creation payload).
 * workspaceId is optional here — the server falls back to the default workspace.
 */
export type ConnectionInput = Omit<
  ConnectionConfig,
  'id' | 'createdAt' | 'updatedAt' | 'workspaceId'
> & { workspaceId?: string };

/* -------------------------------------------------------------------------- */
/* schema introspection                                                       */
/* -------------------------------------------------------------------------- */

export interface ColumnSchema {
  name: string;
  dataType: string;
  /**
   * the column's type exactly as the engine would need it spelled to recreate
   * it — with length, precision/scale, array element and time-zone wording —
   * where `dataType` is the engine's looser catalog label. Postgres is the case
   * that matters: its catalog says `numeric`, `character varying` and `ARRAY`
   * where the column is really `numeric(38,10)`, `character varying(255)` and
   * `integer[]`. bridges read this when they create a destination table;
   * absent means `dataType` already is the full spelling.
   */
  nativeType?: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  defaultValue: string | null;
  comment: string | null;
  /** outbound foreign-key target, if this column references another table */
  references: {
    schema?: string;
    table: string;
    column: string;
  } | null;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeySchema {
  name: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
}

export type RelationKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'collection'
  | 'keyspace';

export interface TableSchema {
  name: string;
  schema?: string;
  kind: RelationKind;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  primaryKey: string[];
  estimatedRows: number | null;
  comment: string | null;
}

export interface SchemaNamespace {
  /** schema/namespace name. empty string for engines without a schema layer */
  name: string;
  tables: TableSchema[];
}

export interface DatabaseSchema {
  database: string;
  namespaces: SchemaNamespace[];
}

/* -------------------------------------------------------------------------- */
/* query + browse                                                             */
/* -------------------------------------------------------------------------- */

export interface QueryColumn {
  name: string;
  dataType?: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
  /** rows returned for reads; affected rows for writes */
  rowCount: number;
  affectedRows?: number;
  executionMs: number;
  /** true when the result was capped by the configured row limit */
  truncated?: boolean;
  /** statement kind / operation name, e.g. "SELECT" or "find" */
  command?: string;
  /** informational message from the engine (notices, warnings) */
  notice?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'notNull'
  | 'in';

export interface FilterSpec {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface BrowseParams {
  schema?: string;
  table: string;
  limit: number;
  offset: number;
  sort?: SortSpec[];
  filters?: FilterSpec[];
  /**
   * for an engine with {@link AdapterCapabilities.cursorPaging}: read the page
   * that starts at this cursor ('' or '0' = the beginning) instead of at
   * `offset`. values are read IN FULL in this mode — it is what copies data,
   * where the offset mode is what a grid shows a preview with. a page may hold
   * somewhat more than `limit` rows, or none while more are still to come:
   * {@link BrowseResult.nextCursor} alone says when the read is over
   */
  cursor?: string;
}

export interface BrowseResult extends QueryResult {
  /** total rows matching the filter, or null when too expensive to compute */
  total: number | null;
  /** true when `total` is an approximate catalog estimate, not an exact count */
  estimated?: boolean;
  /** true when more rows exist beyond this page (from a `limit + 1` probe) */
  hasMore: boolean;
  primaryKey: string[];
  /**
   * answer to {@link BrowseParams.cursor}: where the next page starts, or null
   * when this was the last one
   */
  nextCursor?: string | null;
}

/* -------------------------------------------------------------------------- */
/* mutations                                                                  */
/* -------------------------------------------------------------------------- */

/** column → value map identifying a single row (its primary key) */
export type RowIdentity = Record<string, unknown>;

export interface InsertRowParams {
  schema?: string;
  table: string;
  values: Record<string, unknown>;
}

export interface UpdateRowParams {
  schema?: string;
  table: string;
  identity: RowIdentity;
  changes: Record<string, unknown>;
}

export interface DeleteRowParams {
  schema?: string;
  table: string;
  identity: RowIdentity;
}

/**
 * insert-or-update a row keyed by `keyColumns`. used by database-to-database
 * bridges so a re-delivered row never duplicates: each engine performs this
 * atomically in its native dialect (Postgres/SQLite `ON CONFLICT`, MySQL
 * `ON DUPLICATE KEY`, Mongo `updateOne({upsert:true})`).
 */
export interface UpsertRowParams {
  schema?: string;
  table: string;
  values: Record<string, unknown>;
  /** columns that uniquely identify the row (must be a unique/primary key) */
  keyColumns: string[];
}

/* -------------------------------------------------------------------------- */
/* batched writes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Batched variants of the single-row writes. A sink handling a stream of
 * changes would otherwise pay a full round trip per row, which dominates
 * throughput once the database is anywhere but localhost.
 *
 * These are OPTIONAL on {@link DatabaseAdapter}: an engine that cannot express
 * a set-based write simply omits them and callers fall back to looping the
 * single-row methods. Callers MUST therefore guard with
 * `adapter.upsertRows?.(...)` rather than assuming availability.
 *
 * Rows are NOT required to share a column set — implementations group by the
 * columns actually present, since a change stream can emit sparse rows.
 */
export interface InsertRowsParams {
  schema?: string;
  table: string;
  rows: Array<Record<string, unknown>>;
}

export interface UpsertRowsParams {
  schema?: string;
  table: string;
  rows: Array<Record<string, unknown>>;
  /** columns that uniquely identify a row (must be a unique/primary key) */
  keyColumns: string[];
}

export interface EnsureKeyIndexParams {
  schema?: string;
  table: string;
  /** the columns a bridge matches on when upserting */
  columns: string[];
}

export interface DeleteRowsParams {
  schema?: string;
  table: string;
  /** one identity per row to remove; all must use the same key columns */
  identities: RowIdentity[];
}

/* -------------------------------------------------------------------------- */
/* schema management (DDL)                                                     */
/* -------------------------------------------------------------------------- */

export interface ColumnDefinition {
  name: string;
  /** raw column type for the engine, e.g. "varchar(255)", "int", "text" */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique?: boolean;
  /** raw default expression, e.g. "0", "now()", "'pending'" */
  defaultValue?: string;
}

export interface CreateTableSpec {
  schema?: string;
  table: string;
  columns: ColumnDefinition[];
}

/* -------------------------------------------------------------------------- */
/* backup & restore                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `json`: portable, engine-agnostic dump (schema + data) that any engine can
 * read back, with parameterized inserts on restore.
 * `sql`: a `.sql` script of DDL + INSERT statements (relational engines only)
 */
export type BackupFormat = 'json' | 'sql';

export interface BackupOptions {
  format: BackupFormat;
  /** restrict to these relations; defaults to every table in the database */
  tables?: string[];
  schema?: string;
}

/** the portable JSON backup shape (also embedded inside `json` dumps) */
export interface BackupDocument {
  syncle: 'backup';
  version: 1;
  engine: DatabaseEngine;
  database: string;
  createdAt: string;
  tables: Array<{
    name: string;
    schema?: string;
    primaryKey: string[];
    columns: string[];
    rows: Array<Record<string, unknown>>;
  }>;
}

export interface RestoreResult {
  tables: number;
  rows: number;
}

/* -------------------------------------------------------------------------- */
/* the adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  readonly capabilities: AdapterCapabilities;

  /** establish the underlying connection/pool. idempotent */
  connect(): Promise<void>;
  /** lightweight liveness check */
  ping(): Promise<void>;
  /** release all resources */
  close(): Promise<void>;

  /** list databases/catalogs reachable on this connection */
  listDatabases(): Promise<string[]>;
  /** introspect the full schema of the active (or given) database */
  getSchema(database?: string): Promise<DatabaseSchema>;

  /** paginated, filtered, sorted read of a single relation */
  browse(params: BrowseParams): Promise<BrowseResult>;
  /** run a user-authored statement in the engine's query language */
  query(statement: string, params?: unknown[]): Promise<QueryResult>;
  /**
   * add columns to a table that exists — nullable, never a key, never with a
   * default: the one alteration Syncle makes to a destination, and only when a
   * bridge opted into `onSchemaChange: evolve`. absent on engines with no
   * columns to add (a MongoDB collection, Redis)
   */
  addColumns?(spec: CreateTableSpec): Promise<void>;
  /**
   * run a statement the ENGINE will refuse if it writes: inside a READ ONLY
   * transaction (PostgreSQL, MySQL), or after asking the prepared statement
   * whether it writes (SQLite). what a read-only connection's editor uses, on
   * top of reading the statement's text — the text can be wrong about a
   * function's side effects; the engine is not. absent where the query dialect
   * has no writes to begin with (MongoDB's, Redis's are filtered by command)
   */
  queryReadOnly?(statement: string, params?: unknown[]): Promise<QueryResult>;

  insertRow(params: InsertRowParams): Promise<QueryResult>;
  updateRow(params: UpdateRowParams): Promise<QueryResult>;
  deleteRow(params: DeleteRowParams): Promise<QueryResult>;
  /** insert-or-update keyed by `keyColumns`, atomic in the engine's dialect */
  upsertRow(params: UpsertRowParams): Promise<QueryResult>;

  /**
   * Make sure the key columns a bridge upserts on are indexed. Optional, and
   * only meaningful where the target's key is NOT already indexed by virtue of
   * being a primary key: relational engines get that for free, a MongoDB
   * collection does not — it indexes `_id` and nothing else, so an upsert keyed
   * on any other field is a collection scan.
   *
   * Must be idempotent: callers invoke it whether or not they created the
   * target, because a collection can come into existence without anyone
   * calling createTable.
   */
  ensureKeyIndex?(params: EnsureKeyIndexParams): Promise<void>;

  /* ----- optional set-based writes; see InsertRowsParams for the contract ----- */
  insertRows?(params: InsertRowsParams): Promise<QueryResult>;
  upsertRows?(params: UpsertRowsParams): Promise<QueryResult>;
  deleteRows?(params: DeleteRowsParams): Promise<QueryResult>;

  /* schema management, guarded by `capabilities.ddl` / `manageDatabases` */
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  createTable(spec: CreateTableSpec): Promise<void>;
  dropTable(table: string, schema?: string): Promise<void>;
  truncateTable(table: string, schema?: string): Promise<void>;

  /* backup & restore, guarded by `capabilities.backupFormats` */
  backup(options: BackupOptions): Promise<string>;
  restore(content: string, format: BackupFormat): Promise<RestoreResult>;

  /**
   * run `fn` inside a single-connection transaction: every adapter mutation
   * issued from within `fn` runs on one dedicated connection, and the whole set
   * commits atomically (or rolls back if `fn` throws). used by the database
   * sink so a batch of rows to one target is all-or-nothing, keeping a retry of
   * a failed batch from double-applying rows that already committed.
   *
   * optional and capability-gated: engines with `capabilities.transactions`
   * (Postgres/MySQL/SQLite) provide real BEGIN/COMMIT/ROLLBACK. engines without
   * multi-statement ACID (Mongo/Redis) run `fn` as a plain pass-through — no
   * atomicity is implied; their retry-safety comes from idempotent upsert/delete
   * per row instead. callers MUST treat this as optional (`adapter.withTransaction?.(...)`)
   * and fall back to running the work directly when it is absent.
   */
  withTransaction?<T>(fn: () => Promise<T>): Promise<T>;
}
