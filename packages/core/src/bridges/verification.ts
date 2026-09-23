/**
 * verify: is the destination the copy of the source this bridge says it is?
 * reconcile: make it so, touching only the rows that are not.
 *
 * A bridge that has streamed for a month has delivered millions of changes, each
 * of them green. That is evidence the pipe works, not that the two ends agree:
 * a row edited by hand at the destination, a delete that happened while the
 * bridge was paused past its log, a target restored from last week's backup —
 * none of those is a failed delivery. The only way to know is to look.
 */
import { z } from 'zod';
import type { ColumnDifference } from './row-compare';

export const verifyStartSchema = z.object({
  /** `verify` only looks. `reconcile` also writes the rows that are missing or different, from the source as it is now */
  mode: z.enum(['verify', 'reconcile']).default('verify'),
  /**
   * reconcile only: also remove rows the destination has and the source does
   * not — as the target's delete policy says (deleted, or marked). off by
   * default: it is the one thing a reconcile can do that cannot be re-read
   */
  deleteExtra: z.boolean().default(false),
});
export type VerifyStartDTO = z.infer<typeof verifyStartSchema>;

export type VerificationStatus =
  | 'queued'
  | 'running'
  | 'canceling'
  | 'completed'
  | 'failed'
  | 'canceled';

/** how many examples of each kind of difference are kept with a verification */
export const VERIFICATION_SAMPLES = 25;

export interface VerificationTargetResult {
  /** `schema.table` of the target, for people */
  target: string;
  connectionId: string;
  /** null = compared. otherwise why this target cannot be (no key columns, a Redis destination, …) */
  unsupported: string | null;
  /** things worth knowing that are not differences: "rows this target keeps after a delete were not looked for" */
  notes: string[];
  /** source rows compared with this target */
  checked: number;
  /** in the source, not in the destination */
  missing: number;
  /** in both, and not the same */
  different: number;
  /** in the destination, not in the source (as this bridge filters it). null = not looked for */
  extra: number | null;
  /** reconcile: rows written (missing + different) */
  fixed: number;
  /** reconcile with deleteExtra: rows removed or marked */
  removed: number;
  /** the first few of each, to look at. keys are the TARGET's key column values, in key order */
  samples: {
    missing: unknown[][];
    extra: unknown[][];
    different: Array<{ key: unknown[]; columns: ColumnDifference[] }>;
  };
}

export interface BridgeVerification {
  id: string;
  bridgeId: string;
  mode: 'verify' | 'reconcile';
  deleteExtra: boolean;
  status: VerificationStatus;
  /** source rows read so far */
  sourceRows: number;
  /** best-effort total of the source, for a progress bar; null when it cannot be counted cheaply */
  sourceTotal: number | null;
  targets: VerificationTargetResult[];
  /**
   * completed only: true when nothing is left that differs — nothing was found,
   * or everything found was fixed. null while it runs, and when no target could be compared
   */
  inSync: boolean | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** what is left over on one target after whatever was fixed */
export function remainingDifferences(t: VerificationTargetResult): number {
  return (
    Math.max(0, t.missing + t.different - t.fixed) +
    Math.max(0, (t.extra ?? 0) - t.removed)
  );
}
