/**
 * shared Zod schemas + types for bridges. used by the API (validation,
 * persistence) and the web client (forms, preview), so the contract lives in
 * one place, like `validation.ts`
 */
import { z } from 'zod';
import { filterSchema, sortSchema } from '../validation';

/* -------------------------------------------------------------------------- */
/* Source, where rows are read from                                           */
/* -------------------------------------------------------------------------- */

const tableSourceSchema = z.object({
  kind: z.literal('table'),
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().min(1),
  filters: z.array(filterSchema).optional(),
  sort: z.array(sortSchema).optional(),
});

const querySourceSchema = z.object({
  kind: z.literal('query'),
  connectionId: z.string().min(1),
  database: z.string().optional(),
  statement: z.string().min(1),
});

export const bridgeSourceSchema = z.discriminatedUnion('kind', [
  tableSourceSchema,
  querySourceSchema,
]);

/* -------------------------------------------------------------------------- */
/* Destination, where rows are sent                                           */
/* -------------------------------------------------------------------------- */

export const bridgeAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('header'), name: z.string().min(1), value: z.string() }),
]);

/* ---- HTTP destination: POST/PUT/PATCH each batch to an endpoint ---- */
export const httpDestinationSchema = z.object({
  kind: z.literal('http'),
  url: z.string().url('Enter a valid http(s) URL'),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  auth: bridgeAuthSchema.default({ type: 'none' }),
  /**
   * adds an `Idempotency-Key` header derived from `(jobId, sequence)` so the
   * receiver can dedupe at-least-once redeliveries (see runner docs)
   */
  idempotency: z.boolean().default(false),
});

/* ---- Database destination: write each row into one or more databases ---- */

/** map one source column onto a (possibly differently-named) target column */
export const columnMappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});

/** a single database/table a bridge writes into (a bridge can have several) */
export const databaseTargetSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  /** target table / collection */
  table: z.string().min(1),
  /**
   * `upsert` (default) writes idempotently keyed by `keyColumns`, so replays
   * and at-least-once redeliveries never duplicate. `insert` always appends.
   */
  writeMode: z.enum(['upsert', 'insert']).default('upsert'),
  /** target columns that uniquely identify a row (required for upsert) */
  keyColumns: z.array(z.string().min(1)).default([]),
  /** explicit source→target column mapping. empty = identity (same names) */
  mapping: z.array(columnMappingSchema).default([]),
  /** create the target table from the source schema when it doesn't exist */
  createMissingTable: z.boolean().default(true),
});

export const databaseDestinationSchema = z.object({
  kind: z.literal('database'),
  targets: z.array(databaseTargetSchema).min(1, 'Add at least one target database'),
});

/**
 * a bridge's destination is either an HTTP endpoint or one/more databases.
 * older bridges were stored without a `kind`, so normalize those to `http` to
 * stay backward compatible with persisted configs and job snapshots.
 */
export const bridgeDestinationSchema = z.preprocess(
  (val) => {
    if (val && typeof val === 'object' && !('kind' in (val as object))) {
      return { ...(val as object), kind: 'http' };
    }
    return val;
  },
  z.discriminatedUnion('kind', [httpDestinationSchema, databaseDestinationSchema]),
);

/* -------------------------------------------------------------------------- */
/* Transform, how each row becomes a body                                     */
/* -------------------------------------------------------------------------- */

export const bridgeTransformSchema = z.object({
  template: z.string().min(1).default('{{$row}}'),
  fields: z.array(z.string()).optional(),
  rename: z.record(z.string(), z.string()).optional(),
  wrapKey: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Delivery, pacing, retries, batching                                        */
/* -------------------------------------------------------------------------- */

export const bridgeDeliverySchema = z.object({
  /** rows per HTTP request. 1 = strictly one-by-one */
  batchSize: z.coerce.number().int().min(1).max(1000).default(1),
  /** total attempts per request (1 = no retry) */
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  /** base backoff in ms, doubles each retry up to `backoffMaxMs` */
  backoffMs: z.coerce.number().int().min(0).max(60_000).default(500),
  backoffMaxMs: z.coerce.number().int().min(0).max(300_000).default(30_000),
  /** minimum delay between requests (rate limit) */
  minDelayMs: z.coerce.number().int().min(0).max(600_000).default(0),
  /** per-request timeout */
  timeoutMs: z.coerce.number().int().min(100).max(120_000).default(15_000),
  /** rows fetched per page from a table source */
  pageSize: z.coerce.number().int().min(1).max(1000).default(200),
  /** whether a failed delivery aborts the job, or is logged and skipped */
  onError: z.enum(['continue', 'abort']).default('continue'),
});

/* -------------------------------------------------------------------------- */
/* Bridge                                                                       */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Trigger, when the bridge runs                                                */
/* -------------------------------------------------------------------------- */

export const watchStrategySchema = z.discriminatedUnion('strategy', [
  // track a strictly-increasing column (auto-increment id / sequence)
  z.object({ strategy: z.literal('increment'), column: z.string().min(1) }),
  // track a created_at / updated_at column
  z.object({
    strategy: z.literal('timestamp'),
    column: z.string().min(1),
    /**
     * re-scan this many ms behind the cursor each poll so late-committing
     * transactions aren't lost (overlap rows are deduped by the cursor's
     * boundary keys). 0 disables the window.
     */
    lookbackMs: z.coerce.number().int().min(0).max(600_000).default(3000),
  }),
  // diff the set of seen primary keys (for UUID / non-monotonic keys)
  z.object({
    strategy: z.literal('snapshot'),
    maxTracked: z.coerce.number().int().min(100).max(200_000).default(50_000),
  }),
]);

export const cdcOperationSchema = z.enum(['insert', 'update', 'delete']);

export const bridgeTriggerSchema = z.discriminatedUnion('kind', [
  // run on demand (replay the source when you press Run job)
  z.object({ kind: z.literal('replay') }),
  // continuously poll the source for new rows and deliver them live
  z.object({
    kind: z.literal('watch'),
    strategy: watchStrategySchema,
    pollIntervalMs: z.coerce.number().int().min(1000).max(3_600_000).default(5000),
    /** `now` ignores existing rows, only delivers ones added after start */
    startFrom: z.enum(['beginning', 'now']).default('now'),
    /** max rows delivered per poll cycle (backpressure) */
    maxPerPoll: z.coerce.number().int().min(1).max(5000).default(500),
  }),
  // event-based: stream changes from the database's change log (CDC).
  // real-time, no polling. mechanism depends on the engine: Postgres logical
  // replication, MySQL binlog, MongoDB change streams, or Redis keyspace
  // notifications. requirements (and a readiness probe) are surfaced per engine,
  // any server-side objects (e.g. Postgres publication/slot) are auto-provisioned.
  z.object({
    kind: z.literal('cdc'),
    operations: z.array(cdcOperationSchema).min(1).default(['insert', 'update', 'delete']),
  }),
]);

export const bridgeInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  // which workspace this bridge lives in; server defaults it when omitted
  workspaceId: z.string().optional(),
  source: bridgeSourceSchema,
  destination: bridgeDestinationSchema,
  transform: bridgeTransformSchema,
  delivery: bridgeDeliverySchema.default({}),
  trigger: bridgeTriggerSchema.default({ kind: 'replay' }),
  enabled: z.boolean().default(true),
});

export const bridgePreviewSchema = z.object({
  /** render against this row instead of fetching from the source */
  sampleRow: z.record(z.string(), z.unknown()).optional(),
  /** when no sampleRow is given, fetch this many rows from the source */
  limit: z.coerce.number().int().min(1).max(10).default(3),
});

export const startJobSchema = z.object({
  /** resume a previously interrupted job instead of starting fresh */
  resumeJobId: z.string().optional(),
  /** start a specific prepared (draft) job */
  jobId: z.string().optional(),
  /** create a new job that re-sends only the failed rows of this job */
  retryFailedOf: z.string().optional(),
});

export const skipSchema = z.object({
  /** delivery sequence numbers to skip (only effective while still queued) */
  sequences: z.array(z.coerce.number().int().min(0)).min(1).max(10_000),
});

/** check whether a connection+table can do event-based (CDC) delivery */
export const cdcReadinessSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* inferred types + DTOs surfaced to the web client                           */
/* -------------------------------------------------------------------------- */

export type BridgeSource = z.infer<typeof bridgeSourceSchema>;
export type BridgeAuth = z.infer<typeof bridgeAuthSchema>;
export type HttpDestination = z.infer<typeof httpDestinationSchema>;
export type ColumnMapping = z.infer<typeof columnMappingSchema>;
export type DatabaseTarget = z.infer<typeof databaseTargetSchema>;
export type DatabaseDestination = z.infer<typeof databaseDestinationSchema>;
export type BridgeDestination = z.infer<typeof bridgeDestinationSchema>;
export type BridgeTransformConfig = z.infer<typeof bridgeTransformSchema>;
export type BridgeDeliveryConfig = z.infer<typeof bridgeDeliverySchema>;
export type BridgeTrigger = z.infer<typeof bridgeTriggerSchema>;
export type WatchStrategyConfig = z.infer<typeof watchStrategySchema>;
export type CdcOperation = z.infer<typeof cdcOperationSchema>;
export type CdcReadinessDTO = z.infer<typeof cdcReadinessSchema>;
export type BridgeInputDTO = z.infer<typeof bridgeInputSchema>;

/** result of a CDC readiness probe, drives the builder's setup panel */
export interface CdcReadiness {
  engine: string;
  /** whether this engine has an event-based path implemented at all */
  supported: boolean;
  /** whether the DB is configured and ready to stream right now */
  ready: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
  /** manual steps the user must do (e.g. set wal_level=logical + restart) */
  instructions: string[];
}
export type BridgePreviewDTO = z.infer<typeof bridgePreviewSchema>;
export type StartJobDTO = z.infer<typeof startJobSchema>;
export type SkipDTO = z.infer<typeof skipSchema>;

export type BridgeJobStatus =
  | 'draft' // prepared & queued in the UI, not sending yet
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceling'
  | 'canceled'
  | 'paused' // stopped by the user, resumable in place (same job)
  | 'interrupted';

export type DeliveryStatus = 'success' | 'failed' | 'skipped';

/** the bridge as returned by the API (secret redacted) */
export interface Bridge {
  id: string;
  name: string;
  /** the workspace this bridge belongs to */
  workspaceId: string;
  source: BridgeSource;
  destination: BridgeDestination;
  transform: BridgeTransformConfig;
  delivery: BridgeDeliveryConfig;
  trigger: BridgeTrigger;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeJob {
  id: string;
  bridgeId: string;
  status: BridgeJobStatus;
  cursorOffset: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  totalCount: number | null;
  /** batch size from the config snapshot used to create this job */
  batchSize: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BridgeDelivery {
  id: string;
  jobId: string;
  sequence: number;
  rowIndex: number;
  rowCount: number;
  status: DeliveryStatus;
  httpStatus: number | null;
  attempts: number;
  error: string | null;
  /** the exact JSON body sent for this delivery (capped) */
  requestBody: string | null;
  /** the full response text returned by the endpoint (capped) */
  responseBody: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** a database target as summarized for the preview panel */
export interface BridgePreviewTarget {
  label: string;
  writeMode: string;
  keyColumns: string[];
  createMissingTable: boolean;
}

/** result of the preview endpoint: rendered bodies + resolved request shape */
export interface BridgePreview {
  /** which kind of destination this preview is for */
  destinationKind: 'http' | 'database';
  /* HTTP destinations only */
  method?: string;
  url?: string;
  /** headers with any auth secret redacted */
  headers?: Record<string, string>;
  /* database destinations only: where each row is written */
  targets?: BridgePreviewTarget[];
  /**
   * one rendered body per sample row. for HTTP this is the request payload, for
   * a database it's the row as it will be written to the (first) target.
   */
  bodies: unknown[];
  warnings: string[];
  /** true when the rows came from the live source rather than a sample */
  fromSource: boolean;
}
