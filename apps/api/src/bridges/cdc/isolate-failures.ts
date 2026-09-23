/**
 * Poison-row isolation for a batch that failed as a whole.
 *
 * A database batch is one transaction per target, so a single bad row — a value
 * the destination's constraint rejects, a type it cannot take — fails all of
 * them. Under `onError: continue` the rows that are actually at fault must be
 * set aside, not the hundred thousand healthy ones that happened to share their
 * batch. This splits the failed batch in halves, breadth-first, until each
 * failure is pinned to a single row.
 *
 * It is only ever safe because of what a CDC batch is: one operation, and no
 * key more than once (see `accept` in the CDC service). Its rows are therefore
 * independent, and delivering them in smaller groups, in any order, lands the
 * same result as delivering them together.
 *
 * Just as important is knowing when NOT to isolate. If the destination is down,
 * or its table is gone, every row fails and none of them is "bad" — dead-
 * lettering the lot would empty the change stream into the metadata store. So
 * the search gives up and reports `systemic` when a run of attempts fails with
 * nothing succeeding, when the attempt budget runs out, or when too many rows
 * turn out bad. The caller then stops the bridge without moving its cursor, and
 * nothing is lost. (A SMALL batch that fails outright finishes below those
 * thresholds; a broken destination is caught there by the caller counting
 * consecutive batches in which nothing was delivered.)
 */

/** what one delivery attempt reported back */
export interface IsolationAttempt {
  ok: boolean;
  error: string | null;
  /** fan-out targets that committed during this attempt (never re-written) */
  succeededTargets: string[];
}

export interface PoisonedRow<R> {
  row: R;
  error: string;
  /** targets that already hold this row, so a retry only writes the rest */
  succeededTargets: string[];
}

export interface IsolationResult<R> {
  /** rows written by a sub-delivery that succeeded */
  delivered: R[];
  /** rows that failed on their own */
  poisoned: PoisonedRow<R>[];
  /**
   * the failure is not confined to a few rows. `poisoned` must then be ignored
   * (those rows are not proven bad) and the batch retried later as a whole.
   */
  systemic: boolean;
  /** why the search gave up, for the log and the job's error text */
  reason: string | null;
  /** delivery attempts made */
  attempts: number;
}

export interface IsolationOptions {
  /** the error the full batch failed with, used when it is a single row */
  batchError: string | null;
  /** targets the full batch already committed to */
  alreadySucceeded?: readonly string[];
  /** delivery attempts allowed before giving up */
  maxAttempts: number;
  /** bad rows tolerated in one batch before it counts as systemic */
  maxPoisoned: number;
  /**
   * give up once this many attempts have failed and none has succeeded. the
   * search is breadth-first, so a genuinely isolated failure shows a success
   * within the first couple of attempts; an unbroken run of failures means the
   * destination is rejecting everything.
   */
  failuresBeforeSystemic: number;
}

interface Segment<R> {
  rows: R[];
  /** targets that must not be written again for these rows */
  skip: ReadonlySet<string>;
  /** the other half of the group this one was split from */
  sibling: Segment<R> | null;
  /**
   * the sibling succeeded while the parent failed, so this half is known to
   * hold the failure: split it without spending an attempt that must fail
   */
  knownBad: boolean;
}

/** split a group into its two halves, each aware of the other */
function split<R>(
  rows: R[],
  skip: ReadonlySet<string>,
): [Segment<R>, Segment<R>] {
  const mid = Math.ceil(rows.length / 2);
  const a: Segment<R> = {
    rows: rows.slice(0, mid),
    skip,
    sibling: null,
    knownBad: false,
  };
  const b: Segment<R> = {
    rows: rows.slice(mid),
    skip,
    sibling: null,
    knownBad: false,
  };
  a.sibling = b;
  b.sibling = a;
  return [a, b];
}

/**
 * Pin a failed batch's failure down to individual rows. `rows` is the batch
 * that has ALREADY failed; `attempt` delivers a subset, skipping the given
 * targets, and reports how it went.
 */
export async function isolateFailures<R>(
  rows: R[],
  attempt: (
    rows: R[],
    skipTargets: ReadonlySet<string>,
  ) => Promise<IsolationAttempt>,
  opts: IsolationOptions,
): Promise<IsolationResult<R>> {
  const result: IsolationResult<R> = {
    delivered: [],
    poisoned: [],
    systemic: false,
    reason: null,
    attempts: 0,
  };
  const baseSkip: ReadonlySet<string> = new Set(opts.alreadySucceeded ?? []);

  // a lone row cannot be narrowed any further: it is the failure
  if (rows.length <= 1) {
    if (rows.length === 1) {
      result.poisoned.push({
        row: rows[0]!,
        error: opts.batchError ?? 'delivery failed',
        succeededTargets: [...baseSkip],
      });
    }
    return result;
  }

  let successes = 0;
  const giveUp = (reason: string): IsolationResult<R> => {
    result.systemic = true;
    result.reason = reason;
    return result;
  };

  // breadth-first: both halves of a failed group are tried before either is
  // descended into. that is what makes an isolated failure show a success
  // almost at once, and so tells it apart from a destination rejecting it all
  const queue: Segment<R>[] = [...split(rows, baseSkip)];

  while (queue.length > 0) {
    const segment = queue.shift()!;

    if (segment.knownBad && segment.rows.length > 1) {
      queue.push(...split(segment.rows, segment.skip));
      continue;
    }

    if (result.attempts >= opts.maxAttempts) {
      return giveUp(
        `gave up isolating the failing rows after ${result.attempts} attempts`,
      );
    }

    const outcome = await attempt(segment.rows, segment.skip);
    result.attempts++;

    if (outcome.ok) {
      successes++;
      result.delivered.push(...segment.rows);
      // the parent failed and this half is clean, so the failure is in the
      // other half. only a half that has not been tried yet can use that — and
      // never a single row, which must fail on its own before it is set aside
      const sibling = segment.sibling;
      if (sibling && queue.includes(sibling)) sibling.knownBad = true;
      continue;
    }

    const error = outcome.error ?? 'delivery failed';
    if (successes === 0 && result.attempts >= opts.failuresBeforeSystemic) {
      return giveUp(
        `every attempt failed (${result.attempts} in a row): ${error}`,
      );
    }

    const skip = new Set([...segment.skip, ...outcome.succeededTargets]);

    if (segment.rows.length === 1) {
      result.poisoned.push({
        row: segment.rows[0]!,
        error,
        succeededTargets: [...skip],
      });
      if (result.poisoned.length > opts.maxPoisoned) {
        return giveUp(
          `more than ${opts.maxPoisoned} rows in one batch are failing: ${error}`,
        );
      }
      continue;
    }

    queue.push(...split(segment.rows, skip));
  }

  return result;
}
