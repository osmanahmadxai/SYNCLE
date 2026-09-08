/**
 * Redis adapter. Redis has no tables, so we model the keyspace as a single
 * virtual relation ("keys") whose rows are { key, type, ttl, value }. the query
 * editor takes raw Redis commands, one per line
 */
import Redis from 'ioredis';
import type {
  AdapterCapabilities,
  BackupDocument,
  BackupFormat,
  BackupOptions,
  BrowseParams,
  BrowseResult,
  ConnectionConfig,
  DatabaseAdapter,
  DatabaseSchema,
  DeleteRowParams,
  DeleteRowsParams,
  InsertRowParams,
  InsertRowsParams,
  QueryResult,
  RestoreResult,
  UpdateRowParams,
  UpsertRowParams,
  UpsertRowsParams,
} from '../types';
import {
  BadRequestError,
  ConnectionError,
  QueryError,
  UnsupportedError,
} from '../../errors';

export const REDIS_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'redis',
  schemas: false,
  multipleDatabases: true,
  foreignKeys: false,
  rowEditing: true,
  transactions: false,
  ddl: false,
  manageDatabases: false,
  backupFormats: ['json'],
};

const KEYSPACE = 'keys';

export class RedisAdapter implements DatabaseAdapter {
  readonly engine = 'redis' as const;
  readonly capabilities = REDIS_CAPABILITIES;

  private readonly config: ConnectionConfig;
  private client: Redis | null = null;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  private getClient(): Redis {
    if (this.client) return this.client;
    const dbIndex = Number(
      this.config.options?.db ?? this.config.database ?? 0,
    );
    this.client = this.config.connectionString
      ? new Redis(this.config.connectionString, {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
        })
      : new Redis({
          host: this.config.host ?? 'localhost',
          port: this.config.port ?? 6379,
          username: this.config.user || undefined,
          password: this.config.password || undefined,
          db: Number.isFinite(dbIndex) ? dbIndex : 0,
          tls: this.config.ssl ? {} : undefined,
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          connectTimeout: 8000,
        });
    // ioredis emits 'error' for socket-level failures (e.g. the server going
    // away between commands); with no listener Node treats it as an unhandled
    // 'error' event and crashes the process. individual commands still reject
    // with their own errors, so swallowing here loses nothing
    this.client.on('error', () => {});
    return this.client;
  }

  async connect(): Promise<void> {
    try {
      await this.getClient().connect();
    } catch (err) {
      throw new ConnectionError(
        `Could not connect to Redis: ${(err as Error).message}`,
      );
    }
  }

  async ping(): Promise<void> {
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});
    const pong = await client.ping();
    if (pong !== 'PONG') throw new ConnectionError('Redis did not respond');
  }

  async close(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
  }

  async listDatabases(): Promise<string[]> {
    // Redis exposes a fixed set of numbered logical databases
    return Array.from({ length: 16 }, (_, i) => `db${i}`);
  }

  async getSchema(): Promise<DatabaseSchema> {
    return {
      database: `db${this.config.options?.db ?? 0}`,
      namespaces: [
        {
          name: '',
          tables: [
            {
              name: KEYSPACE,
              kind: 'keyspace',
              columns: [
                {
                  name: 'key',
                  dataType: 'string',
                  nullable: false,
                  isPrimaryKey: true,
                  isUnique: true,
                  isAutoIncrement: false,
                  defaultValue: null,
                  comment: null,
                  references: null,
                },
                ...['type', 'ttl', 'value'].map((name) => ({
                  name,
                  dataType: 'string',
                  nullable: true,
                  isPrimaryKey: false,
                  isUnique: false,
                  isAutoIncrement: false,
                  defaultValue: null,
                  comment: null,
                  references: null,
                })),
              ],
              indexes: [],
              foreignKeys: [],
              primaryKey: ['key'],
              estimatedRows: null,
              comment: null,
            },
          ],
        },
      ],
    };
  }

  /**
   * read one key as a { key, type, ttl, value } row. browse previews truncate
   * lists/zsets to 25 elements to keep the grid light; `full` reads everything
   * (backups MUST use it — restore deletes the key before rewriting it, so a
   * truncated read would silently lose data)
   */
  private async readKey(
    client: Redis,
    key: string,
    full = false,
  ): Promise<Record<string, unknown>> {
    const stop = full ? -1 : 24;
    const type = await client.type(key);
    const ttl = await client.ttl(key);
    let value: unknown;
    switch (type) {
      case 'string':
        value = await client.get(key);
        break;
      case 'list':
        value = await client.lrange(key, 0, stop);
        break;
      case 'set':
        value = await client.smembers(key);
        break;
      case 'zset':
        value = await client.zrange(key, 0, stop, 'WITHSCORES');
        break;
      case 'hash':
        value = await client.hgetall(key);
        break;
      default:
        value = null;
    }
    return { key, type, ttl, value };
  }

  async browse(params: BrowseParams): Promise<BrowseResult> {
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});

    const match =
      params.filters?.find((f) => f.column === 'key')?.value ?? '*';
    const pattern =
      typeof match === 'string' && match ? `*${match}*` : '*';

    const limit = Math.min(Math.max(params.limit, 1), 500);
    const started = performance.now();

    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0' && keys.length < params.offset + limit);

    const page = keys.slice(params.offset, params.offset + limit);
    const rows = await Promise.all(page.map((k) => this.readKey(client, k)));
    const dbsize = await client.dbsize().catch(() => null);
    const hasMore = keys.length > params.offset + limit || cursor !== '0';

    return {
      columns: ['key', 'type', 'ttl', 'value'].map((name) => ({ name })),
      rows,
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      command: 'scan',
      total: dbsize,
      estimated: true,
      hasMore,
      primaryKey: ['key'],
    };
  }

  async query(statement: string): Promise<QueryResult> {
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});

    const lines = statement
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const rows: Array<Record<string, unknown>> = [];
    const started = performance.now();
    try {
      for (const line of lines) {
        const parts = tokenizeCommand(line);
        if (parts.length === 0) continue;
        const [cmd, ...args] = parts;
        const reply = await client.call(cmd!, ...args);
        rows.push({ command: line, reply: stringifyReply(reply) });
      }
    } catch (err) {
      throw new QueryError((err as Error).message);
    }

    return {
      columns: [
        { name: 'command' },
        { name: 'reply' },
      ],
      rows,
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      command: 'redis',
    };
  }

  async insertRow(p: InsertRowParams): Promise<QueryResult> {
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});
    const key = String(p.values.key ?? '');
    if (!key) throw new QueryError('A "key" value is required');
    await client.set(key, String(p.values.value ?? ''));
    return writeResult(1, 'set');
  }

  async updateRow(p: UpdateRowParams): Promise<QueryResult> {
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});
    const key = String(p.identity.key ?? '');
    if ('value' in p.changes) await client.set(key, String(p.changes.value));
    if ('ttl' in p.changes) {
      const ttl = Number(p.changes.ttl);
      if (ttl > 0) await client.expire(key, ttl);
      else await client.persist(key);
    }
    return writeResult(1, 'set');
  }

  async deleteRow(p: DeleteRowParams): Promise<QueryResult> {
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});
    const removed = await client.del(String(p.identity.key ?? ''));
    return writeResult(removed, 'del');
  }

  /** a SET is already idempotent, so upsert is just insert by key */
  async upsertRow(p: UpsertRowParams): Promise<QueryResult> {
    return this.insertRow({ table: p.table, schema: p.schema, values: p.values });
  }

  /* ----- set-based writes -------------------------------------------------
   * Without these the sink issues one SET per row, which is a round trip per
   * row — the thing that sets the ceiling on a change stream. A pipeline sends
   * the whole batch as one write and reads one reply, so the cost per row stops
   * being a round trip and becomes a few bytes.
   */

  /** the pipeline shared by every batched write; `SET` is already idempotent */
  private async pipelineWrite(
    rows: Array<Record<string, unknown>>,
  ): Promise<QueryResult> {
    if (rows.length === 0) return writeResult(0, 'pipeline');
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});
    const pipeline = client.pipeline();
    for (const values of rows) {
      const key = String(values.key ?? '');
      if (!key) throw new QueryError('A "key" value is required');
      pipeline.set(key, String(values.value ?? ''));
    }
    const results = await pipeline.exec();
    // a pipeline reports per-command errors rather than throwing; surface the
    // first one instead of silently reporting every row as written
    const failed = results?.find(([err]) => err);
    if (failed?.[0]) throw new QueryError(failed[0].message);
    return writeResult(rows.length, 'pipeline set');
  }

  async insertRows(p: InsertRowsParams): Promise<QueryResult> {
    return this.pipelineWrite(p.rows);
  }

  async upsertRows(p: UpsertRowsParams): Promise<QueryResult> {
    // SET overwrites, so an upsert and an insert are the same operation here
    return this.pipelineWrite(p.rows);
  }

  async deleteRows(p: DeleteRowsParams): Promise<QueryResult> {
    if (p.identities.length === 0) return writeResult(0, 'pipeline');
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});
    const keys = p.identities
      .map((identity) => String(identity.key ?? ''))
      .filter((k) => k.length > 0);
    if (keys.length === 0) return writeResult(0, 'del');
    // DEL takes many keys in one command, so this needs no pipeline at all
    const removed = await client.del(...keys);
    return writeResult(removed, 'del');
  }

  /**
   * Redis has no multi-key ACID transaction we model here: each row is written
   * with an idempotent SET/DEL by key, which is what keeps a retry safe. so
   * `withTransaction` is a pass-through that just runs `fn` — no batch
   * atomicity is implied (capabilities.transactions is false).
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /* ----- schema management: doesn't apply to a key-value store ----- */

  private ddlUnsupported(): never {
    throw new UnsupportedError('Redis does not support tables or databases.');
  }
  async createTable(): Promise<void> {
    this.ddlUnsupported();
  }
  async dropTable(): Promise<void> {
    this.ddlUnsupported();
  }
  async truncateTable(): Promise<void> {
    this.ddlUnsupported();
  }
  async createDatabase(): Promise<void> {
    this.ddlUnsupported();
  }
  async dropDatabase(): Promise<void> {
    this.ddlUnsupported();
  }

  /* ----- backup & restore (every key in the current DB) ----- */

  /**
   * dump every key in the current logical DB to a portable JSON document.
   * value reads are already bounded: keys are enumerated via SCAN and their
   * values fetched in fixed chunks (see `chunkSize` below) rather than one
   * unbounded `Promise.all` over the whole keyspace, so the in-flight working
   * set stays small. (the flat list of key NAMES is still collected up front;
   * that's cheap relative to the values and unchanged here.)
   */
  async backup(opts: BackupOptions): Promise<string> {
    if (opts.format !== 'json') {
      throw new UnsupportedError('Redis supports JSON backups only.');
    }
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});

    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');

    // full (untruncated) reads, in bounded chunks so a large keyspace doesn't
    // fan out into one giant Promise.all
    const rows: Array<Record<string, unknown>> = [];
    const chunkSize = 50;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      rows.push(
        ...(await Promise.all(chunk.map((k) => this.readKey(client, k, true)))),
      );
    }
    const doc: BackupDocument = {
      syncle: 'backup',
      version: 1,
      engine: this.engine,
      database: `db${this.config.options?.db ?? this.config.database ?? 0}`,
      createdAt: new Date().toISOString(),
      tables: [
        {
          name: KEYSPACE,
          primaryKey: ['key'],
          columns: ['key', 'type', 'ttl', 'value'],
          rows,
        },
      ],
    };
    return JSON.stringify(doc, null, 2);
  }

  async restore(content: string, format: BackupFormat): Promise<RestoreResult> {
    if (format !== 'json') {
      throw new UnsupportedError('Redis supports JSON restores only.');
    }
    let doc: BackupDocument;
    try {
      doc = JSON.parse(content) as BackupDocument;
    } catch {
      throw new BadRequestError('Backup file is not valid JSON');
    }
    if (doc.syncle !== 'backup' || !Array.isArray(doc.tables)) {
      throw new BadRequestError('Not a Syncle backup file');
    }
    const client = this.getClient();
    if (client.status !== 'ready') await client.connect().catch(() => {});

    let rows = 0;
    for (const table of doc.tables) {
      for (const row of table.rows) {
        await this.writeKey(client, row);
        rows++;
      }
    }
    return { tables: doc.tables.length, rows };
  }

  private async writeKey(
    client: Redis,
    row: Record<string, unknown>,
  ): Promise<void> {
    const key = String(row.key ?? '');
    if (!key) return;
    const type = String(row.type ?? 'string');
    const value = row.value;
    await client.del(key);
    switch (type) {
      case 'list':
        if (Array.isArray(value) && value.length)
          await client.rpush(key, ...value.map(String));
        break;
      case 'set':
        if (Array.isArray(value) && value.length)
          await client.sadd(key, ...value.map(String));
        break;
      case 'zset':
        if (Array.isArray(value)) {
          // stored as [member, score, member, score, ...]
          for (let i = 0; i + 1 < value.length; i += 2) {
            await client.zadd(key, String(value[i + 1]), String(value[i]));
          }
        }
        break;
      case 'hash':
        if (value && typeof value === 'object')
          await client.hset(key, value as Record<string, string>);
        break;
      default:
        await client.set(key, String(value ?? ''));
    }
    const ttl = Number(row.ttl);
    if (Number.isFinite(ttl) && ttl > 0) await client.expire(key, ttl);
  }
}

/* ----- helpers ----- */

function tokenizeCommand(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

function stringifyReply(reply: unknown): string {
  if (reply === null || reply === undefined) return '(nil)';
  if (Array.isArray(reply)) return JSON.stringify(reply);
  if (Buffer.isBuffer(reply)) return reply.toString('utf8');
  return String(reply);
}

function writeResult(affected: number, command: string): QueryResult {
  return {
    columns: [],
    rows: [],
    rowCount: affected,
    affectedRows: affected,
    executionMs: 0,
    command,
  };
}
