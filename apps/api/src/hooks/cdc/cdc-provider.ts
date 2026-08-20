/**
 * CDC provider abstraction.
 *
 * every engine captures changes a different way (Postgres logical replication,
 * MySQL binlog, MongoDB change streams, Redis keyspace notifications) but they
 * all feed the SAME downstream pipeline: render the row, deliver it over HTTP,
 * record the delivery, persist a resume cursor.
 *
 * a `CdcProvider` hides the engine-specific "how do I get a stream of changes"
 * behind a small interface. {@link HookCdcService} is the engine-agnostic
 * orchestrator: picks a provider, owns the run lifecycle, and runs the shared
 * per-change handler (dedupe, render, send, record, persist cursor). providers
 * never touch the metadata store or the delivery service, they only emit
 * normalized {@link CdcChange}s.
 */
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@syncle/core';
import type { ResolvedHook } from '../hooks.types';

/** one decoded change, normalized across every engine */
export interface CdcChange {
  /** insert | update | delete */
  op: CdcOperation;
  /** row/document/value after the change (before-image for deletes) */
  row: Record<string, unknown>;
  /**
   * opaque engine-specific position string, used BOTH as the resume cursor and
   * the idempotency seed. Postgres: LSN "H/L"; MySQL: "file:pos:row[:s]";
   * MongoDB: serialized resumeToken; Redis: synthetic, non-durable.
   * orchestrator persists it verbatim and hands it back on resume.
   */
  cursor: string;
}

/** callbacks the orchestrator hands to a provider's live stream */
export interface CdcStreamHandlers {
  /**
   * deliver one change. orchestrator dedupes, renders, sends, records and
   * persists the cursor. providers MUST `await` this before reading the next
   * event so backpressure flows all the way to the source.
   */
  onChange(change: CdcChange): Promise<void>;
  /** a non-fatal transport error. logged, the provider keeps/reconnects */
  onError(err: Error): void;
}

/** everything a provider needs to open a stream */
export interface CdcStreamContext {
  hookId: string;
  hook: ResolvedHook;
  conn: ConnectionConfig;
  /** last persisted cursor (resume point), or null to start from "now" */
  fromCursor: string | null;
  handlers: CdcStreamHandlers;
}

/** handle to a running stream so the orchestrator can stop it cleanly */
export interface CdcStreamHandle {
  stop(): Promise<void>;
  /**
   * confirm to the SOURCE that everything up to and including `cursor` is
   * durably checkpointed on our side. the orchestrator calls this only AFTER
   * persisting the cursor, so engines with a server-side ack point (the
   * Postgres slot's confirmed LSN) never advance it past unpersisted changes.
   * best-effort: a missed ack just widens the at-least-once replay window,
   * which the orchestrator's watermark dedupe absorbs. must not throw.
   */
  ack?(cursor: string): Promise<void>;
}

export interface CdcProvider {
  readonly engine: DatabaseEngine;

  /**
   * true when the provider applies the hook's source filters itself, with
   * engine-native semantics (Redis: the `key` filter value is a glob applied
   * at the subscription). the orchestrator then skips its own generic
   * in-process filter evaluation for changes from this provider.
   */
  readonly handlesSourceFilters?: boolean;

  /**
   * can this engine/connection stream changes right now? drives the builder's
   * setup panel. MUST NOT throw, fold connection failures into a failing check.
   * engines with no event path (sqlite) return `supported: false`.
   */
  readiness(dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness>;

  /**
   * create any durable server-side objects needed to capture changes
   * (Postgres: publication + replication slot). idempotent, safe on resume.
   * most engines have nothing to provision (the binlog/oplog/keyspace stream
   * already exists) so they just no-op.
   */
  provision(hookId: string, hook: ResolvedHook, conn: ConnectionConfig): Promise<void>;

  /**
   * drop everything {@link provision} created. only called on hook delete.
   * must never throw fatally.
   */
  deprovision(hookId: string, hook: ResolvedHook, conn: ConnectionConfig): Promise<void>;

  /** open the long-lived connection and start emitting changes */
  startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle>;

  /**
   * true if cursor `a` is strictly after watermark `b`. orchestrator uses this
   * to drop replays after a reconnect. engines whose driver resumes exactly
   * (Mongo resumeToken, Redis fire-and-forget) return `true`.
   */
  cursorAfter(a: string, b: string | null): boolean;
}

/** DI token for the set of registered providers */
export const CDC_PROVIDERS = Symbol('CDC_PROVIDERS');

/* -------------------------------------------------------------------------- */
/* small shared helpers usable by any provider                                */
/* -------------------------------------------------------------------------- */

/** sleep that resolves after `ms`, used by reconnect backoff loops */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * exponential backoff with a cap, for stream reconnect loops.
 * attempt 0 is base, doubles each time, clamped to `cap`.
 */
export function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt));
}

/** per-engine `op` set check, shared by row-event providers */
export function opEnabled(op: CdcOperation, enabled: Set<CdcOperation>): boolean {
  return enabled.has(op);
}
