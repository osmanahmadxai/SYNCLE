/**
 * server-internal bridge types. the fully *resolved* config carries the decrypted
 * auth secret and is only used inside the runner, it's never serialized back to
 * a client (the API surface returns the redacted {@link Bridge} from core).
 */
import type {
  CdcOperation,
  BridgeDeliveryConfig,
  BridgeDestination,
  BridgeSource,
  BridgeTransformConfig,
  BridgeTrigger,
} from '@syncle/core';

/** a bridge with its auth secret decrypted, server-internal use only */
export interface ResolvedBridge {
  id: string;
  name: string;
  source: BridgeSource;
  destination: BridgeDestination; // auth carries the real secret here
  transform: BridgeTransformConfig;
  delivery: BridgeDeliveryConfig;
  trigger: BridgeTrigger;
  enabled: boolean;
}

/** outcome of a single delivery attempt sequence (HTTP or database sink) */
export interface DeliveryOutcome {
  status: 'success' | 'failed';
  httpStatus: number | null;
  attempts: number;
  error: string | null;
  requestBody: string | null;
  responseBody: string | null;
  durationMs: number;
  /**
   * the CDC operation behind these rows (null = plain replay/watch write). a
   * resend must know a delete was a delete, so it's persisted per delivery.
   * `undefined` leaves the stored value untouched when re-recording.
   */
  op?: CdcOperation | null;
  /**
   * `requestBody` was cut at the storage cap and can no longer be replayed
   * faithfully; the resend path refuses such deliveries instead of re-sending
   * truncated garbage. `undefined` preserves the stored flag on re-record.
   */
  bodyTruncated?: boolean;
  /**
   * database sink only: target keys that committed. persisted on a failed
   * fan-out delivery so a retry skips the targets that already wrote instead
   * of double-applying them. `undefined` preserves the stored value.
   */
  succeededTargets?: string[] | null;
}

/**
 * the last keyset value a replay job delivered, persisted (as
 * `cursorJson: {"keyset": ...}`) alongside `cursorOffset` at every batch
 * checkpoint. resuming from the stored key is exact even when rows were added
 * or removed under the job, where an OFFSET re-seek would land on the wrong
 * row. `column` guards against resuming a value against a changed sort.
 */
export interface KeysetCheckpoint {
  column: string;
  value: unknown;
}

/** the BullMQ job payload for the `bridge-jobs` queue */
export interface BridgeJobPayload {
  jobId: string;
  bridgeId: string;
  /**
   * 'resend' re-POSTs the captured request bodies of the job's failed
   * deliveries (no source access); absent = a normal job that streams rows
   * from the source.
   */
  mode?: 'resend';
}

/** the BullMQ job payload for a `bridge-watch` poll cycle */
export interface BridgeWatchPayload {
  bridgeId: string;
}

export const BRIDGE_JOBS_QUEUE = 'bridge-jobs';
export const BRIDGE_WATCH_QUEUE = 'bridge-watch';
