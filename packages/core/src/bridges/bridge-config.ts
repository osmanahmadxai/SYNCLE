/**
 * shared Zod schemas + types for bridges. used by the API (validation,
 * persistence) and the web client (forms, preview), so the contract lives in
 * one place, like `validation.ts`
 */
import { z } from 'zod';
import { filterSchema, sortSchema } from '../validation';
import { columnTransformSchema } from './column-transforms';

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
/**
 * what a DELETE at the source does to a target.
 *
 *   delete  (default) the row is removed
 *   soft    the row stays and is MARKED: `softDelete.column` is set to the time
 *           of the delete (or to `true`). a row that comes back at the source —
 *           inserted again under the same key — is unmarked by the write that
 *           brings it back
 *   ignore  nothing. the target keeps every row it was ever sent: an archive, a
 *           warehouse, an audit copy
 */
export const deletePolicySchema = z.enum(['delete', 'soft', 'ignore']);
export type DeletePolicy = z.infer<typeof deletePolicySchema>;

const databaseTargetObject = z.object({
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
  /** see {@link deletePolicySchema}. has no effect on a target with no key columns: there is nothing to find the row by */
  onDelete: deletePolicySchema.default('delete'),
  /** required by `onDelete: soft` */
  softDelete: z
    .object({
      /** the TARGET column that marks a row as deleted. created with the table when Syncle creates it */
      column: z.string().trim().min(1).max(200),
      /** `timestamp`: when it was deleted (NULL = not deleted). `boolean`: true / false */
      value: z.enum(['timestamp', 'boolean']).default('timestamp'),
    })
    .optional(),
});

export const databaseTargetSchema = databaseTargetObject.superRefine((target, ctx) => {
  if (target.onDelete !== 'soft') return;
  const column = target.softDelete?.column;
  if (!column) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['softDelete', 'column'],
      message: 'A soft delete needs a column to mark the row with.',
    });
    return;
  }
  // the marker is Syncle's to write. a column that also receives source data
  // would be overwritten by every delete, and a key cannot change at all
  if (target.keyColumns.includes(column)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['softDelete', 'column'],
      message: `"${column}" is a key column; the soft-delete marker has to be a column of its own.`,
    });
  }
  if (target.mapping.some((m) => m.target === column)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['softDelete', 'column'],
      message: `"${column}" already receives a source column; the soft-delete marker has to be a column of its own.`,
    });
  }
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
  /**
   * what happens to a row's VALUES on the way — masking, casts, computed
   * columns. applied in order, before the row is mapped onto a database target
   * or rendered into an HTTP payload, so both kinds of destination see the same
   * row. (`fields` / `rename` / `template` shape the HTTP payload only; a
   * database target's own `mapping` does that job there.)
   */
  columns: z.array(columnTransformSchema).max(100).optional(),
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
  /**
   * what a failed delivery does to the bridge.
   *
   * `abort` (default) stops at the failure WITHOUT moving past it, so nothing
   * is skipped: fix the cause, start again, and the same rows are retried.
   *
   * `continue` keeps going. on a live bridge (CDC / watch) the rows that failed
   * are first set aside, in full, in the bridge's dead-letter queue — only then
   * does the cursor move on — so they can be retried once the cause is fixed
   * instead of being lost when the source's change log advances.
   */
  onError: z.enum(['continue', 'abort']).default('abort'),
  /**
   * what happens when the SOURCE TABLE is found to have changed since the
   * bridge was set up (see schema-drift.ts).
   *
   *   stop      (default) a column the bridge USES is gone — dropped, renamed:
   *             the bridge stops, saying which, before it writes NULL over what
   *             the destination holds. anything else (a column added, a type
   *             changed) is noted on the timeline and the bridge carries on
   *   continue  never stops; everything is noted. what a bridge did before
   *   evolve    like `stop`, and a column ADDED to the source is added to every
   *             target that takes the row as it comes (no explicit mapping) and
   *             that Syncle may create tables on. nothing is ever dropped or
   *             retyped at a destination
   */
  onSchemaChange: z.enum(['stop', 'continue', 'evolve']).default('stop'),
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

/**
 * `truncate` is a change of its own kind: it carries no row, and applying it
 * empties the destination. it is never among the defaults — a bridge mirrors a
 * TRUNCATE only when it was asked to — but it is never silent either: a
 * truncate that is not applied leaves a notice on the bridge's timeline.
 */
export const cdcOperationSchema = z.enum(['insert', 'update', 'delete', 'truncate']);

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
    /**
     * `now` follows changes made from the moment the bridge first starts; what
     * is already in the table stays where it is.
     *
     * `beginning` copies the table as it is FIRST, then follows changes — in one
     * bridge, with nothing lost in between: the place in the change log is
     * taken before the first row is read, and the changes made while the copy
     * runs are delivered after it. applies when the bridge has no position yet
     * (its first start, or a start over); a bridge that has one resumes from it.
     */
    startFrom: z.enum(['now', 'beginning']).default('now'),
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

/**
 * a dry run of a bridge that has not been saved (or of unsaved edits to one):
 * what the builder shows before anything is created
 */
export const bridgeDraftPreviewSchema = z.object({
  bridge: z.lazy(() => bridgeInputSchema),
  sampleRow: z.record(z.string(), z.unknown()).optional(),
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

/** which dead letters an action applies to; omitted ids = every pending one */
const deadLetterIdsSchema = z.array(z.string().min(1)).min(1).max(500).optional();

export const deadLetterRetrySchema = z.object({
  ids: deadLetterIdsSchema,
  /**
   * apply the recorded row even where Syncle could not confirm it is still the
   * newest version (the source row is gone and the bridge does not propagate
   * deletes). off by default: never overwrite on a guess.
   */
  force: z.boolean().default(false),
});

export const deadLetterDiscardSchema = z.object({
  ids: deadLetterIdsSchema,
});

/** check whether a connection+table can do event-based (CDC) delivery */
export const cdcReadinessSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().min(1),
  /**
   * the bridge being checked, when it already exists. a source has a fixed
   * number of replication slots; a bridge that already owns one does not need
   * another, so "no free slot" must not fail its own readiness check
   */
  bridgeId: z.string().optional(),
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

/* -------------------------------------------------------------------------- */
/* Export / import                                                            */
/* -------------------------------------------------------------------------- */

export const BRIDGE_EXPORT_FORMAT = 'syncle.bridges';

/**
 * bridges as a file: to keep in version control, to move from staging to
 * production, to hand to a colleague.
 *
 * NO SECRET is ever in it. an HTTP destination's token or header value is
 * exported empty (the bridge is then imported switched off, and says why), and
 * a connection is referred to by id — with its name and engine beside it, which
 * is what lets ANOTHER instance find its own connection for it. a connection's
 * host, user and password are not part of a bridge and are not exported.
 */
export const bridgeExportSchema = z.object({
  format: z.literal(BRIDGE_EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  syncleVersion: z.string().optional(),
  connections: z.record(z.string(), z.object({ name: z.string(), engine: z.string() })),
  bridges: z.array(z.lazy(() => bridgeInputSchema)).min(1).max(500),
});
export type BridgeExportDocument = z.infer<typeof bridgeExportSchema>;

export const bridgeImportSchema = z.object({
  document: bridgeExportSchema,
  /** a connection id of the document → a connection id of THIS instance */
  connectionMap: z.record(z.string(), z.string().min(1)).optional(),
  workspaceId: z.string().optional(),
});
export type BridgeImportDTO = z.infer<typeof bridgeImportSchema>;

/** a connection of the document that this instance has no obvious counterpart for */
export interface UnresolvedConnection {
  id: string;
  name: string;
  engine: string;
  /** this instance's connections of the same engine: what it could be mapped to */
  candidates: Array<{ id: string; name: string }>;
}

export interface BridgeImportResult {
  created: Array<{ id: string; name: string }>;
  /** what whoever imported has to do before the bridges are what they were */
  warnings: string[];
}

/** body of `POST /bridges/:id/watch/start`; every field optional, as is the body */
export const liveStartSchema = z
  .object({
    /**
     * the bridge's place in the source's change log is gone (its replication
     * slot was dropped or invalidated, the binlog was purged). start anyway,
     * from the current position, accepting that what happened in between was
     * not captured. without this such a bridge refuses to start
     */
    fromNow: z.boolean().optional(),
    /**
     * with `fromNow`, on a bridge that starts from the `beginning`: copy the
     * table again before following changes. that closes the gap for every row
     * that still exists (what was DELETED at the source in between stays at the
     * destination). without it, `fromNow` means exactly that: no copy
     */
    recopy: z.boolean().optional(),
  })
  .default({});
export type LiveStartDTO = z.infer<typeof liveStartSchema>;
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
  /**
   * things that do not stop the bridge from starting but that whoever runs the
   * source should know first (PostgreSQL: nothing caps the WAL a stopped bridge
   * can pin)
   */
  advisories?: string[];
}

/** something a removed or edited bridge left on a source, still to be removed */
export interface PendingSourceCleanup {
  id: string;
  bridgeId: string;
  bridgeName: string | null;
  connectionId: string;
  database: string | null;
  engine: string;
  /** e.g. `replication slot syncle_slot_…` */
  resource: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** what a CDC bridge is holding on its source; see the API's CdcSourceHold */
export interface BridgeSourceHold {
  engine: string;
  kind: 'replication-slot' | 'log-position';
  name: string;
  exists: boolean;
  active: boolean | null;
  retainedBytes: number | null;
  limitBytes: number | null;
  status: 'ok' | 'at-risk' | 'lost';
  detail?: string;
  /** 'ok' | 'warn' (past SYNCLE_SLOT_WARN_BYTES) | 'critical' (at-risk, lost, or near a limit) */
  level: 'ok' | 'warn' | 'critical';
  /** what to tell the person looking at the bridge, already worded */
  message: string | null;
  /** is the bridge streaming right now */
  running: boolean;
  checkedAt: string;
}
export type BridgePreviewDTO = z.infer<typeof bridgePreviewSchema>;
export type BridgeDraftPreviewDTO = z.infer<typeof bridgeDraftPreviewSchema>;
export type StartJobDTO = z.infer<typeof startJobSchema>;
export type SkipDTO = z.infer<typeof skipSchema>;
export type DeadLetterRetryDTO = z.infer<typeof deadLetterRetrySchema>;
export type DeadLetterDiscardDTO = z.infer<typeof deadLetterDiscardSchema>;

export type DeadLetterStatus = 'pending' | 'resolved' | 'discarded';

/**
 * rows a live bridge could not deliver, kept in full so they can be retried.
 * one entry is one failed unit: a single row for a database destination (bad
 * rows are isolated from the rest of their batch), a whole request for HTTP.
 */
export interface BridgeDeadLetter {
  id: string;
  bridgeId: string;
  jobId: string;
  /** the failed delivery (timeline cell) these rows belong to */
  sequence: number;
  /** the change operation, or null for rows found by a polling bridge */
  op: CdcOperation | null;
  rowCount: number;
  /** the source rows exactly as they were read — never truncated */
  rows: Record<string, unknown>[];
  error: string | null;
  /** retry attempts made so far */
  attempts: number;
  /**
   * a plain retry left this entry alone: the source row is gone and the bridge
   * does not propagate deletes, so only a forced retry (write the recorded row
   * anyway) or a discard can settle it
   */
  needsForce: boolean;
  status: DeadLetterStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DeadLetterPage {
  items: BridgeDeadLetter[];
  /** pending entries / rows across the whole bridge, not just this page */
  pendingEntries: number;
  pendingRows: number;
}

/** what a retry did, entry by entry */
export interface DeadLetterRetryResult {
  /** delivered (or confirmed no longer needed) and closed */
  resolved: number;
  /** tried again and still failing; the entry keeps its new error */
  stillFailing: number;
  /** left untouched because applying them needs `force` */
  needsForce: number;
}

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
  /** delivery details removed by retention (the counters above still include them) */
  prunedDeliveries: number;
  /**
   * a delivery with a sequence below this that is no longer listed was
   * delivered and has had its details removed — it is not "still queued"
   */
  prunedBelowSequence: number | null;
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
  /** what kind of change a live bridge delivered here; null for a replay's rows */
  op?: CdcOperation | null;
}

/** one column of a table a bridge is about to create */
export interface BridgePreviewColumn {
  name: string;
  /** the source column's native type */
  sourceType: string;
  /** the type it will be created as on the target */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

/** a database target as summarized for the preview panel */
export interface BridgePreviewTarget {
  label: string;
  writeMode: string;
  keyColumns: string[];
  createMissingTable: boolean;
  /** whether the target table is there already (null = could not be checked) */
  exists: boolean | null;
  /**
   * the table that WILL be created, column by column — present only when the
   * table is missing and `createMissingTable` is on. this is the DDL a run
   * would execute, shown before it does.
   */
  plannedColumns?: BridgePreviewColumn[];
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
