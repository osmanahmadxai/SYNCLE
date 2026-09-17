/**
 * MongoDB adapter. collections map to "tables", documents map to rows. schema
 * is inferred by sampling documents (Mongo is schemaless). the query editor
 * speaks a small JSON dialect, see {@link MongodbAdapter.query}
 */
import { mongoTlsOptions } from '../tls-options';
import {
  BSON,
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
  UUID,
  type Collection,
  type Db,
} from 'mongodb';
import type {
  AdapterCapabilities,
  BackupDocument,
  BackupFormat,
  BackupOptions,
  BrowseParams,
  BrowseResult,
  ColumnSchema,
  ConnectionConfig,
  CreateTableSpec,
  DatabaseAdapter,
  DatabaseSchema,
  DeleteRowParams,
  DeleteRowsParams,
  EnsureKeyIndexParams,
  FilterSpec,
  InsertRowParams,
  InsertRowsParams,
  QueryResult,
  RestoreResult,
  TableSchema,
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

export const MONGODB_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'mongo',
  schemas: false,
  multipleDatabases: true,
  foreignKeys: false,
  rowEditing: true,
  transactions: false,
  // collections behave like tables (create/drop/empty); databases get created
  // implicitly when you add a collection, so we don't expose explicit DB creation
  ddl: true,
  manageDatabases: false,
  backupFormats: ['json'],
  // see browseFrom: a read of EVERY document pages by the typed `_id`
  cursorPaging: true,
};

const SAMPLE_SIZE = 50;
const DEFAULT_LIMIT = 100;
/** documents fetched per cursor round-trip when streaming a backup */
const BACKUP_FETCH_BATCH = 1000;

/**
 * Build the filter and update document for one upsert.
 *
 * Key columns live only in the (coerced) filter: `_id` is immutable and mongo
 * rejects any $set that touches it, even with the same value, and on insert the
 * equality-filter fields are copied into the new document anyway — so they never
 * belong in the update payload.
 *
 * Shared by upsertRow and upsertRows so the batched path cannot drift from the
 * single-row one.
 */
function buildUpsert(
  values: Record<string, unknown>,
  keyColumns: string[],
): { filter: Record<string, unknown>; update: Record<string, unknown> } {
  const rawFilter: Record<string, unknown> = {};
  for (const k of keyColumns) rawFilter[k] = values[k];
  const filter = coerceId(rawFilter);

  const updates: Record<string, unknown> = {};
  const onInsert: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k in rawFilter) continue;
    if (k === '_id') {
      // `_id` supplied but not a key column: only settable at insert time
      onInsert._id = coerceId({ _id: v })._id;
      continue;
    }
    updates[k] = v;
  }
  const update: Record<string, unknown> = {};
  if (Object.keys(updates).length > 0) update.$set = updates;
  if (Object.keys(onInsert).length > 0) update.$setOnInsert = onInsert;
  // an empty update document is invalid; a no-op $setOnInsert keeps the
  // upsert idempotent when every value is a key column
  if (Object.keys(update).length === 0) update.$setOnInsert = { ...filter };
  return { filter, update };
}

/**
 * drop whole-line `//` comments from a query document. the query editor's own
 * starter text for MongoDB opens with one ("// Write a JSON command…"), and
 * JSON has no comments — so pressing Run on the untouched starter answered
 * "must be a JSON command document". (the Redis dialect has always skipped its
 * `#` lines.) only a line that STARTS with `//` goes: JSON strings cannot span
 * lines, so such a line is never inside one, and a `//` within a value — a URL
 * — is left alone.
 */
export function stripLineComments(statement: string): string {
  return statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * through an SSH tunnel the driver must talk ONLY to the address it was given.
 *
 * left to itself it treats that address as a seed: it asks the server which
 * members the replica set has, and then connects to THOSE — by the names the
 * set knows them by, `mongo-1.internal:27017`, which is exactly what cannot be
 * reached from this side of the tunnel. the first query then times out in
 * server selection, on a connection that "tested" fine. a connection string
 * says what it means and is left alone.
 */
export function mongoTunnelOptions(config: ConnectionConfig): { directConnection?: boolean } {
  return config.tlsHostOverride !== undefined && !config.connectionString ? { directConnection: true } : {};
}

export class MongodbAdapter implements DatabaseAdapter {
  readonly engine = 'mongodb' as const;
  readonly capabilities = MONGODB_CAPABILITIES;

  private readonly config: ConnectionConfig;
  private client: MongoClient | null = null;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  private uri(): string {
    if (this.config.connectionString) return this.config.connectionString;
    const auth =
      this.config.user && this.config.password
        ? `${encodeURIComponent(this.config.user)}:${encodeURIComponent(
            this.config.password,
          )}@`
        : '';
    const host = this.config.host ?? 'localhost';
    const port = this.config.port ?? 27017;
    return `mongodb://${auth}${host}:${port}`;
  }

  private async getClient(): Promise<MongoClient> {
    if (this.client) return this.client;
    try {
      this.client = new MongoClient(this.uri(), {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 5,
        ...mongoTunnelOptions(this.config),
        // with host/port fields the driver was never told about TLS: the
        // "Use TLS" switch did nothing here and the connection was plaintext
        ...mongoTlsOptions(this.config),
      });
      await this.client.connect();
      return this.client;
    } catch (err) {
      this.client = null;
      throw new ConnectionError(
        `Could not connect to MongoDB: ${(err as Error).message}`,
      );
    }
  }

  private async getDb(name?: string): Promise<Db> {
    const client = await this.getClient();
    const dbName = name ?? this.config.database ?? 'test';
    return client.db(dbName);
  }

  async connect(): Promise<void> {
    await this.getClient();
  }

  async ping(): Promise<void> {
    const db = await this.getDb();
    await db.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.getClient();
    const res = await client.db().admin().listDatabases();
    return res.databases.map((d) => d.name);
  }

  async getSchema(database?: string): Promise<DatabaseSchema> {
    const db = await this.getDb(database);
    const collections = await db.listCollections().toArray();
    const tables: TableSchema[] = [];

    for (const coll of collections) {
      const sample = await db
        .collection(coll.name)
        .find({}, { limit: SAMPLE_SIZE })
        .toArray();
      const fields = inferColumns(sample);
      const estimated = await db
        .collection(coll.name)
        .estimatedDocumentCount()
        .catch(() => null);
      tables.push({
        name: coll.name,
        kind: 'collection',
        columns: fields,
        indexes: [],
        foreignKeys: [],
        primaryKey: ['_id'],
        estimatedRows: estimated,
        comment: null,
      });
    }

    return {
      database: db.databaseName,
      namespaces: [{ name: '', tables }],
    };
  }

  async browse(params: BrowseParams): Promise<BrowseResult> {
    const db = await this.getDb(params.schema);
    const coll = db.collection(params.table);
    const limit = Math.min(Math.max(params.limit, 1), 1000);
    const filter = buildMongoFilter(params.filters);
    if (params.cursor !== undefined) return this.browseFrom(coll, params.cursor, filter, limit);
    const sort: Record<string, 1 | -1> = {};
    for (const s of params.sort ?? []) {
      sort[s.column] = s.direction === 'desc' ? -1 : 1;
    }

    const hasFilters = Object.keys(filter).length > 0;
    const started = performance.now();
    // probe one extra doc to detect a next page without a full count
    const cursor = coll.find(filter).skip(params.offset).limit(limit + 1);
    if (Object.keys(sort).length > 0) cursor.sort(sort);
    const probed = await cursor.toArray();
    const hasMore = probed.length > limit;
    const docs = hasMore ? probed.slice(0, limit) : probed;

    // estimatedDocumentCount is O(1) on the collection metadata; we only fall
    // back to the exact countDocuments when a filter is applied
    const total = hasFilters
      ? await coll.countDocuments(filter).catch(() => null)
      : await coll.estimatedDocumentCount().catch(() => null);

    const rows = docs.map(normalizeDoc);
    return {
      columns: inferColumns(docs).map((c) => ({ name: c.name })),
      rows,
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      command: 'find',
      total,
      estimated: !hasFilters,
      hasMore,
      primaryKey: ['_id'],
    };
  }

  /**
   * one page of a read that means to see every document, in `_id` order, after
   * the `_id` the cursor holds.
   *
   * the cursor is that `_id` AS BSON (canonical extended JSON), not as the text
   * a row shows it as. rows carry an ObjectId as its 24 hex characters, and a
   * reader that paged by "`_id` greater than the last row's" was asking MongoDB
   * to compare ObjectIds with a string: nothing is greater than a value of
   * another type, page two was empty, and a replay of any collection ended —
   * `completed` — 200 documents in.
   *
   * a comparison only matches its own BSON type, so the documents whose `_id`
   * is of a type that sorts LATER are asked for by type: a collection that
   * mixes kinds of `_id` is still read to the end.
   */
  private async browseFrom(
    coll: Collection,
    cursor: string,
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<BrowseResult> {
    const started = performance.now();
    let after: unknown;
    if (cursor && cursor !== '0') {
      try {
        after = (BSON.EJSON.parse(cursor, { relaxed: false }) as { id: unknown }).id;
      } catch {
        throw new BadRequestError('That is not a cursor this collection handed out.');
      }
    }
    const clauses = [filter, after === undefined ? {} : afterId(after)].filter((c) => Object.keys(c).length > 0);
    const query = clauses.length > 1 ? { $and: clauses } : (clauses[0] ?? {});
    const probed = await coll.find(query).sort({ _id: 1 }).limit(limit + 1).toArray();
    const hasMore = probed.length > limit;
    const docs = hasMore ? probed.slice(0, limit) : probed;
    const hasFilters = Object.keys(filter).length > 0;
    const total = hasFilters
      ? await coll.countDocuments(filter).catch(() => null)
      : await coll.estimatedDocumentCount().catch(() => null);
    const rows = docs.map(normalizeDoc);
    return {
      columns: inferColumns(docs).map((c) => ({ name: c.name })),
      rows,
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      command: 'find',
      total,
      estimated: !hasFilters,
      hasMore,
      primaryKey: ['_id'],
      nextCursor: hasMore
        ? BSON.EJSON.stringify({ id: docs[docs.length - 1]!._id }, { relaxed: false })
        : null,
    };
  }

  /**
   * runs a JSON command document:
   *   { "collection": "users", "find": { "active": true },
   *     "sort": { "createdAt": -1 }, "limit": 20 }
   *   { "collection": "orders", "aggregate": [ { "$group": ... } ] }
   *   { "collection": "users", "countDocuments": { } }
   */
  async query(statement: string): Promise<QueryResult> {
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(stripLineComments(statement));
    } catch {
      throw new BadRequestError(
        'MongoDB query must be a JSON command document, e.g. ' +
          '{ "collection": "users", "find": {} }',
      );
    }
    const collName = spec.collection;
    if (typeof collName !== 'string') {
      throw new BadRequestError('Query document requires a "collection" field');
    }
    const db = await this.getDb();
    const coll = db.collection(collName);
    const started = performance.now();

    try {
      if (spec.aggregate) {
        const pipeline = spec.aggregate as Record<string, unknown>[];
        const docs = await coll.aggregate(pipeline).limit(1000).toArray();
        return finalize(docs, started, 'aggregate');
      }
      if ('countDocuments' in spec) {
        const count = await coll.countDocuments(
          (spec.countDocuments as Record<string, unknown>) ?? {},
        );
        return {
          columns: [{ name: 'count' }],
          rows: [{ count }],
          rowCount: 1,
          executionMs: Math.round(performance.now() - started),
          command: 'countDocuments',
        };
      }
      const filter = (spec.find as Record<string, unknown>) ?? {};
      const cursor = coll
        .find(filter)
        .limit(Number(spec.limit ?? DEFAULT_LIMIT));
      if (spec.sort) cursor.sort(spec.sort as Record<string, 1 | -1>);
      const docs = await cursor.toArray();
      return finalize(docs, started, 'find');
    } catch (err) {
      throw new QueryError((err as Error).message);
    }
  }

  async insertRow(p: InsertRowParams): Promise<QueryResult> {
    const db = await this.getDb(p.schema);
    const res = await db.collection(p.table).insertOne(p.values);
    return writeResult(res.acknowledged ? 1 : 0, 'insertOne');
  }

  async updateRow(p: UpdateRowParams): Promise<QueryResult> {
    const db = await this.getDb(p.schema);
    const res = await db
      .collection(p.table)
      .updateOne(coerceId(p.identity), { $set: p.changes });
    return writeResult(res.modifiedCount, 'updateOne');
  }

  async deleteRow(p: DeleteRowParams): Promise<QueryResult> {
    const db = await this.getDb(p.schema);
    const res = await db.collection(p.table).deleteOne(coerceId(p.identity));
    return writeResult(res.deletedCount, 'deleteOne');
  }

  async upsertRow(p: UpsertRowParams): Promise<QueryResult> {
    if (p.keyColumns.length === 0) {
      throw new QueryError('Cannot upsert without key columns to match on');
    }
    const db = await this.getDb(p.schema);
    const { filter, update } = buildUpsert(p.values, p.keyColumns);
    const res = await db
      .collection(p.table)
      .updateOne(filter, update, { upsert: true });
    return writeResult(res.modifiedCount + (res.upsertedCount ?? 0), 'upsertOne');
  }

  /**
   * Index the columns a bridge upserts on. Without this every upsert scans the
   * collection, which is quadratic as it grows and makes a large sync
   * effectively never finish. createIndex is idempotent, so this is safe to
   * call on every job start.
   *
   * Not declared unique: a bridge may legitimately key on a non-unique column,
   * and a uniqueness violation at write time is a worse failure than a
   * duplicate row.
   */
  async ensureKeyIndex(p: EnsureKeyIndexParams): Promise<void> {
    const columns = p.columns.filter((c) => c !== '_id');
    if (columns.length === 0) return; // `_id` is already unique and indexed
    const db = await this.getDb(p.schema);
    const spec: Record<string, 1> = {};
    for (const c of columns) spec[c] = 1;
    await db
      .collection(p.table)
      .createIndex(spec, { name: `syncle_key_${columns.join('_')}` });
  }

  /* ----- set-based writes -------------------------------------------------
   * Without these the sink falls back to one round trip per row, which on a
   * change stream is what sets the ceiling. bulkWrite sends the whole batch as
   * one command while applying the same per-document semantics as above.
   */

  async insertRows(p: InsertRowsParams): Promise<QueryResult> {
    if (p.rows.length === 0) return writeResult(0, 'insertMany');
    const db = await this.getDb(p.schema);
    const res = await db.collection(p.table).insertMany(p.rows, { ordered: true });
    return writeResult(res.insertedCount, 'insertMany');
  }

  async upsertRows(p: UpsertRowsParams): Promise<QueryResult> {
    if (p.rows.length === 0) return writeResult(0, 'bulkWrite');
    if (p.keyColumns.length === 0) {
      throw new QueryError('Cannot upsert without key columns to match on');
    }
    const db = await this.getDb(p.schema);
    const ops = p.rows.map((values) => {
      const { filter, update } = buildUpsert(values, p.keyColumns);
      return { updateOne: { filter, update, upsert: true } };
    });
    // ordered: a change stream's rows must be applied in the order they occurred
    const res = await db.collection(p.table).bulkWrite(ops, { ordered: true });
    return writeResult(
      (res.modifiedCount ?? 0) + (res.upsertedCount ?? 0) + (res.insertedCount ?? 0),
      'bulkWrite',
    );
  }

  async deleteRows(p: DeleteRowsParams): Promise<QueryResult> {
    if (p.identities.length === 0) return writeResult(0, 'bulkWrite');
    const db = await this.getDb(p.schema);
    const ops = p.identities.map((identity) => ({
      deleteOne: { filter: coerceId(identity) },
    }));
    const res = await db.collection(p.table).bulkWrite(ops, { ordered: true });
    return writeResult(res.deletedCount ?? 0, 'bulkWrite');
  }

  /* ----- schema management ----- */

  async createTable(spec: CreateTableSpec): Promise<void> {
    const db = await this.getDb(spec.schema);
    await db.createCollection(spec.table);

    // Index the key columns. A collection has an index on `_id` and nothing
    // else, so an upsert keyed on any other field is a collection scan — which
    // degrades quadratically as the collection grows and makes a large sync
    // effectively never finish. `_id` is already unique and indexed, so it is
    // skipped. The index is not declared unique: a bridge may legitimately key
    // on a non-unique column, and a uniqueness violation at write time would be
    // a worse failure than a duplicate.
    const keys = spec.columns.filter((c) => c.primaryKey && c.name !== '_id');
    if (keys.length === 0) return;
    const index: Record<string, 1> = {};
    for (const c of keys) index[c.name] = 1;
    await db
      .collection(spec.table)
      .createIndex(index, { name: `syncle_key_${keys.map((c) => c.name).join('_')}` })
      .catch(() => undefined); // an index we cannot create must not fail the sync
  }

  async dropTable(table: string, schema?: string): Promise<void> {
    const db = await this.getDb(schema);
    await db.collection(table).drop();
  }

  async truncateTable(table: string, schema?: string): Promise<void> {
    const db = await this.getDb(schema);
    await db.collection(table).deleteMany({});
  }

  async createDatabase(): Promise<void> {
    throw new UnsupportedError(
      'MongoDB creates databases automatically when the first collection is added.',
    );
  }

  async dropDatabase(name: string): Promise<void> {
    const client = await this.getClient();
    await client.db(name).dropDatabase();
  }

  /**
   * no multi-document ACID transaction is applied here: each row is written via
   * an idempotent upsert/delete, which is what makes a retry safe on MongoDB.
   * so `withTransaction` is a pass-through that just runs `fn` — it does NOT
   * promise atomicity across the batch (capabilities.transactions is false).
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /* ----- backup & restore ----- */

  /**
   * dump collections to a portable JSON document. memory is bounded to
   * {@link BACKUP_FETCH_BATCH} documents per round-trip: each collection is
   * streamed by iterating its cursor in batches instead of `find({}).toArray()`
   * pulling the whole collection into RAM at once (which OOMs on large
   * collections and takes down live bridges). the assembled document still
   * holds every encoded row before stringify, but each fetched batch is freed
   * after it is normalized, so the working set is the batch, not the collection.
   */
  async backup(opts: BackupOptions): Promise<string> {
    if (opts.format !== 'json') {
      throw new UnsupportedError('MongoDB supports JSON backups only.');
    }
    const db = await this.getDb();
    let names = (await db.listCollections().toArray()).map((c) => c.name);
    if (opts.tables?.length) {
      const wanted = new Set(opts.tables);
      names = names.filter((n) => wanted.has(n));
    }

    const doc: BackupDocument = {
      syncle: 'backup',
      version: 1,
      engine: this.engine,
      database: db.databaseName,
      createdAt: new Date().toISOString(),
      tables: [],
    };
    for (const name of names) {
      const rows: Array<Record<string, unknown>> = [];
      const columns = new Map<string, string>();
      const cursor = db
        .collection(name)
        .find({})
        .batchSize(BACKUP_FETCH_BATCH);
      // stream the cursor one document at a time; the driver fetches in
      // batchSize chunks under the hood, so only one batch is buffered
      for await (const raw of cursor) {
        const asRow = raw as Record<string, unknown>;
        for (const [k, v] of Object.entries(asRow)) {
          if (!columns.has(k)) columns.set(k, jsType(v));
        }
        rows.push(normalizeDoc(asRow));
      }
      doc.tables.push({
        name,
        primaryKey: ['_id'],
        columns: [...columns.keys()],
        rows,
      });
    }
    return JSON.stringify(doc, null, 2);
  }

  async restore(content: string, format: BackupFormat): Promise<RestoreResult> {
    if (format !== 'json') {
      throw new UnsupportedError('MongoDB supports JSON restores only.');
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
    const db = await this.getDb();
    let rows = 0;
    for (const table of doc.tables) {
      await db.createCollection(table.name).catch(() => undefined);
      if (table.rows.length > 0) {
        const docs = table.rows.map((r) => coerceId({ ...r }));
        await db
          .collection(table.name)
          .insertMany(docs, { ordered: false })
          .catch(() => undefined);
        rows += table.rows.length;
      }
    }
    return { tables: doc.tables.length, rows };
  }
}

/* ----- helpers ----- */

function coerceId(identity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...identity };
  if (typeof out._id === 'string' && ObjectId.isValid(out._id)) {
    out._id = new ObjectId(out._id);
  }
  return out;
}

/**
 * turn a BSON value into a plain JavaScript one that every other engine's
 * driver can bind. the driver hands back wrapper objects for the types JSON has
 * no word for, and a SQL driver that meets one either stringifies its internals
 * (`{"$numberDecimal":…}`, an ObjectId wrapped in quotes) or rejects it:
 *
 *   ObjectId    → its 24-character hex string
 *   Decimal128  → its decimal string, exact (a JS number would round it)
 *   Long        → a number when that is exact, otherwise its decimal string
 *   Int32/Double→ a number
 *   Binary      → a Buffer; a UUID-subtype Binary → the canonical UUID string
 *   Timestamp   → its decimal string (an internal replication value)
 *
 * applied at every depth, because a nested document lands in ONE json column
 * and its members need the same treatment as top-level fields.
 */
export function normalizeMongoValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Decimal128) return v.toString();
  // a Timestamp IS a Long underneath, so it has to be tested first
  if (v instanceof Timestamp) return v.toString();
  if (v instanceof Long) {
    const n = v.toNumber();
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (v instanceof Int32 || v instanceof Double) return v.valueOf();
  if (v instanceof UUID) return v.toString();
  if (v instanceof Binary) {
    if (v.sub_type === Binary.SUBTYPE_UUID) {
      try {
        return v.toUUID().toString();
      } catch {
        /* not 16 bytes after all: fall through to raw bytes */
      }
    }
    return Buffer.from(v.buffer);
  }
  if (Array.isArray(v)) return v.map(normalizeMongoValue);
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalizeMongoValue(x);
    return out;
  }
  return v; // an unknown wrapper: leave it for the target's own coercion
}

/** {@link normalizeMongoValue} over a whole document */
export function normalizeMongoDocument(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) out[k] = normalizeMongoValue(v);
  return out;
}

const normalizeDoc = normalizeMongoDocument;

/** numeric labels, narrowest first: a field seen as both takes the wider one */
const NUMERIC_WIDENING = ['int', 'long', 'number', 'decimal128'];

/**
 * fold one more sampled value's type into what a field has been seen as so far.
 * the first document alone used to decide — so a field whose first value was
 * null stayed "null" however many real values followed, and a bridge then
 * created a text column for what was really a number or a date.
 */
export function mergeSampledType(seen: string | undefined, next: string): string {
  if (seen === undefined || seen === 'null' || seen === 'undefined') return next;
  if (next === 'null' || next === 'undefined' || next === seen) return seen;
  const a = NUMERIC_WIDENING.indexOf(seen);
  const b = NUMERIC_WIDENING.indexOf(next);
  if (a >= 0 && b >= 0) return NUMERIC_WIDENING[Math.max(a, b)]!;
  // genuinely different kinds in one field (a number here, a string there)
  return 'mixed';
}

function inferColumns(docs: Record<string, unknown>[]): ColumnSchema[] {
  const seen = new Map<string, string>();
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc)) {
      seen.set(k, mergeSampledType(seen.get(k), jsType(v)));
    }
  }
  return [...seen.entries()].map(([name, dataType]) => ({
    name,
    dataType,
    nullable: true,
    isPrimaryKey: name === '_id',
    isUnique: name === '_id',
    isAutoIncrement: false,
    defaultValue: null,
    comment: null,
    references: null,
  }));
}

/**
 * the type label for a sampled value. these are the names the bridge type map
 * knows MongoDB by (`packages/core/src/bridges/type-map.ts`), so a new label
 * here needs an entry there.
 */
function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof ObjectId) return 'objectId';
  if (v instanceof Decimal128) return 'decimal128';
  if (v instanceof Timestamp) return 'string';
  if (v instanceof Long) return 'long';
  if (v instanceof Int32) return 'int';
  if (v instanceof Double) return 'number';
  if (v instanceof UUID) return 'uuid';
  if (v instanceof Binary) {
    return v.sub_type === Binary.SUBTYPE_UUID ? 'uuid' : 'binary';
  }
  if (Buffer.isBuffer(v)) return 'binary';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  return typeof v;
}

/** escape regex metacharacters so user input matches literally */
function escapeRegex(value: unknown): string {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * comparison operands must be scalars: passing an object through verbatim
 * would let a crafted value like `{"$gt": ""}` inject mongo operators into
 * the filter. Dates are fine (they're BSON scalars).
 */
function scalarValue(f: FilterSpec): unknown {
  const v = f.value;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    throw new BadRequestError(
      `Filter value for "${f.column}" must be a scalar`,
    );
  }
  return v;
}

/**
 * BSON types in the order MongoDB sorts them, as far as an `_id` can be one.
 * numbers compare with each other whatever their width, so they are one group
 */
const ID_TYPE_ORDER: string[][] = [
  ['null'],
  ['int', 'long', 'double', 'decimal'],
  ['string', 'symbol'],
  ['object'],
  ['binData'],
  ['objectId'],
  ['bool'],
  ['date'],
  ['timestamp'],
];

function idTypeGroup(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' || typeof v === 'bigint') return 1;
  if (v instanceof Int32 || v instanceof Long || v instanceof Double || v instanceof Decimal128) return 1;
  if (typeof v === 'string') return 2;
  if (v instanceof Binary) return 4;
  if (v instanceof ObjectId) return 5;
  if (typeof v === 'boolean') return 6;
  if (v instanceof Date) return 7;
  if (v instanceof Timestamp) return 8;
  return 3;
}

/** every document that sorts after `_id: last`, whatever type its own `_id` is */
export function afterId(last: unknown): Record<string, unknown> {
  const later = ID_TYPE_ORDER.slice(idTypeGroup(last) + 1).flat();
  const greater = { _id: { $gt: last } };
  return later.length ? { $or: [greater, { _id: { $type: later } }] } : greater;
}

/**
 * the forms an `_id` written as text may have in the collection. a row shows an
 * ObjectId as its 24 hex characters, and that text comes back in filters — the
 * keys of the rows picked in the builder, the keys a dead-letter retry re-reads
 * its rows by. compared as the string it looks like, it matches nothing: an
 * ObjectId is not a string. (a collection MAY key its documents by such a
 * string, so that form is kept beside the ObjectId rather than replaced by it.)
 */
function idForms(column: string, v: unknown): unknown[] {
  return column === '_id' && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)
    ? [new ObjectId(v), v]
    : [v];
}

function comparison(column: string, op: '$lt' | '$lte' | '$gt' | '$gte', v: unknown): Record<string, unknown> {
  const forms = idForms(column, v);
  if (forms.length === 1) return { [column]: { [op]: v } };
  // a comparison matches its own BSON type only: ask once per form
  return { $or: forms.map((form) => ({ [column]: { [op]: form } })) };
}

export function buildMongoFilter(
  filters: FilterSpec[] | undefined,
): Record<string, unknown> {
  if (!filters || filters.length === 0) return {};
  // one clause per filter, ANDed. they used to be assigned into ONE object by
  // column, so of "age >= 18" and "age < 65" only the last survived
  const clauses: Record<string, unknown>[] = [];
  for (const f of filters) {
    switch (f.operator) {
      case 'eq': {
        const forms = idForms(f.column, scalarValue(f));
        clauses.push({ [f.column]: forms.length === 1 ? forms[0] : { $in: forms } });
        break;
      }
      case 'neq': {
        const forms = idForms(f.column, scalarValue(f));
        clauses.push({ [f.column]: forms.length === 1 ? { $ne: forms[0] } : { $nin: forms } });
        break;
      }
      case 'lt':
        clauses.push(comparison(f.column, '$lt', scalarValue(f)));
        break;
      case 'lte':
        clauses.push(comparison(f.column, '$lte', scalarValue(f)));
        break;
      case 'gt':
        clauses.push(comparison(f.column, '$gt', scalarValue(f)));
        break;
      case 'gte':
        clauses.push(comparison(f.column, '$gte', scalarValue(f)));
        break;
      case 'contains':
        clauses.push({ [f.column]: { $regex: escapeRegex(f.value), $options: 'i' } });
        break;
      case 'startsWith':
        clauses.push({ [f.column]: { $regex: `^${escapeRegex(f.value)}`, $options: 'i' } });
        break;
      case 'endsWith':
        clauses.push({ [f.column]: { $regex: `${escapeRegex(f.value)}$`, $options: 'i' } });
        break;
      case 'isNull':
        clauses.push({ [f.column]: null });
        break;
      case 'notNull':
        clauses.push({ [f.column]: { $ne: null } });
        break;
      case 'in':
        clauses.push({
          [f.column]: { $in: (Array.isArray(f.value) ? f.value : []).flatMap((v) => idForms(f.column, v)) },
        });
        break;
      default:
        throw new BadRequestError(
          `Unsupported filter operator: ${String(f.operator)}`,
        );
    }
  }
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function finalize(
  docs: Record<string, unknown>[],
  started: number,
  command: string,
): QueryResult {
  const rows = docs.map(normalizeDoc);
  return {
    columns: inferColumns(docs).map((c) => ({ name: c.name })),
    rows,
    rowCount: rows.length,
    executionMs: Math.round(performance.now() - started),
    command,
  };
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
