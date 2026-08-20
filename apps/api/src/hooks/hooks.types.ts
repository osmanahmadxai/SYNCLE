/**
 * server-internal hook types. the fully *resolved* config carries the decrypted
 * auth secret and is only used inside the runner, it's never serialized back to
 * a client (the API surface returns the redacted {@link Hook} from core).
 */
import type {
  CdcOperation,
  HookDeliveryConfig,
  HookDestination,
  HookSource,
  HookTransformConfig,
  HookTrigger,
} from '@syncle/core';

/** a hook with its auth secret decrypted, server-internal use only */
export interface ResolvedHook {
  id: string;
  name: string;
  source: HookSource;
  destination: HookDestination; // auth carries the real secret here
  transform: HookTransformConfig;
  delivery: HookDeliveryConfig;
  trigger: HookTrigger;
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

/** the BullMQ job payload for the `hook-runs` queue */
export interface HookRunJob {
  runId: string;
  hookId: string;
  /**
   * 'resend' re-POSTs the captured request bodies of the run's failed
   * deliveries (no source access); absent = a normal run that streams rows
   * from the source.
   */
  mode?: 'resend';
}

/** the BullMQ job payload for a `hook-watch` poll cycle */
export interface HookWatchJob {
  hookId: string;
}

export const HOOK_RUNS_QUEUE = 'hook-runs';
export const HOOK_WATCH_QUEUE = 'hook-watch';
