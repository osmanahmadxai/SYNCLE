/**
 * positions in a PostgreSQL change stream, and the small things every reader of
 * one needs: shared by the provider (a bridge with a slot of its own) and the
 * shared-slot reader, which must agree on them to the byte — a cursor means the
 * same whichever of the two handed it out.
 */
import { UNCHANGED } from '@syncle/core';

/**
 * Where a Postgres change sits in the stream.
 *
 * It is NOT the change's own LSN, which is what this used to be. Two things are
 * wrong with that, and both lost rows with nothing erroring:
 *
 *  1. Postgres tags every change with the WAL position it was written at, but
 *     streams whole transactions in COMMIT order. A transaction that started
 *     early and committed late arrives after ones with HIGHER positions, and a
 *     "highest position seen" watermark discards its rows as already processed.
 *     Measured with two overlapping transactions: rows [1, 2, 3] written,
 *     [2, 3] delivered.
 *  2. Positions are not unique. COPY writes a couple of hundred rows per WAL
 *     record and every one of them carries that record's LSN, so as soon as a
 *     batch boundary fell inside a record the rest of it compared as "not after
 *     the watermark". Measured: COPY of 3000 rows, 1412 delivered.
 *
 * What IS ordered and unique: the transaction's commit position, then the
 * change's position within it, then its ordinal among changes sharing that
 * position. So a cursor is
 *
 *     <commitLsn>#<changeLsn>.<n>      a change
 *     <commitLsn>#c:<commitEndLsn>     the end of a transaction
 *
 * The commit LSN comes from the transaction's BEGIN message. The end marker
 * sorts after every change of its transaction and carries the position that may
 * be confirmed to the server. All three parts are read off the WAL, so a
 * transaction the server sends again (after a restart) gets the same cursors
 * whatever the publication or the bridge's settings have become since.
 *
 * A bare `H/L` is a cursor saved before this existed: "everything that was sent
 * before this position". Any transaction committing at or after it is accepted
 * whole, which can re-deliver a few rows once after an upgrade (upserts absorb
 * that) and can never skip one.
 */
export interface PgPosition {
  /** the transaction's commit LSN (or the bare LSN of a legacy cursor) */
  commit: bigint;
  /** the change's own LSN; -1 for a legacy cursor, END for a transaction's end */
  change: bigint;
  /** ordinal among the changes sharing `change` */
  ordinal: number;
  /** the position that may be confirmed to the server once this one is durable */
  ack: string | null;
}

const END = 1n << 64n;

function lsnValue(text: string): bigint {
  const [h, lo, ...rest] = text.split('/');
  if (
    !h ||
    !lo ||
    rest.length ||
    !/^[0-9a-f]{1,8}$/i.test(h) ||
    !/^[0-9a-f]{1,8}$/i.test(lo)
  ) {
    throw new Error('invalid LSN');
  }
  return (BigInt('0x' + h) << 32n) | BigInt('0x' + lo);
}

/** the form Postgres prints: `16/B374D848` */
export function formatLsn(value: bigint): string {
  return `${(value >> 32n).toString(16).toUpperCase()}/${(value & 0xffffffffn).toString(16).toUpperCase()}`;
}

export function parsePgCursor(cursor: string): PgPosition | null {
  try {
    const hash = cursor.indexOf('#');
    if (hash < 0)
      return { commit: lsnValue(cursor), change: -1n, ordinal: 0, ack: cursor };
    const commit = lsnValue(cursor.slice(0, hash));
    const rest = cursor.slice(hash + 1);
    if (rest.startsWith('c:')) {
      const end = rest.slice(2);
      lsnValue(end); // validates
      return { commit, change: END, ordinal: 0, ack: end };
    }
    const dot = rest.lastIndexOf('.');
    if (dot < 0) return null;
    const ordinal = Number(rest.slice(dot + 1));
    if (!Number.isInteger(ordinal) || ordinal < 0) return null;
    return { commit, change: lsnValue(rest.slice(0, dot)), ordinal, ack: null };
  } catch {
    return null;
  }
}

/** true if position `a` is strictly after `b` (either cursor format) */
export function lsnAfter(a: string, b: string | null): boolean {
  if (!b) return true;
  const pa = parsePgCursor(a);
  const pb = parsePgCursor(b);
  // be conservative: treat a parse failure as "not after" to avoid dupes
  if (!pa || !pb) return false;
  if (pa.commit !== pb.commit) return pa.commit > pb.commit;
  if (pa.change !== pb.change) return pa.change > pb.change;
  return pa.ordinal > pb.ordinal;
}

/** `00000001/BD940508` (as the protocol messages print it) -> `1/BD940508` */
export function normalizeLsn(lsn: string): string {
  try {
    return formatLsn(lsnValue(lsn));
  } catch {
    return lsn;
  }
}

/**
 * the LSN to hand the replication client so that the server is told exactly
 * `lsn`. the client sends `lsn + 1` ("last byte + 1"), but the positions
 * Postgres reports are ALREADY one past the last byte: a commit's end is where
 * the next record starts. one byte further is inside that next record — and
 * when that is another transaction's commit, Postgres treats the transaction
 * as confirmed and never sends it again. measured with two transactions
 * committing back to back and a restart between them: the second was gone.
 */
export function lsnForClient(lsn: string): string | null {
  try {
    const value = lsnValue(lsn);
    return value > 0n ? formatLsn(value - 1n) : null;
  } catch {
    return null;
  }
}

/**
 * a value the message did not include comes out of the decoder as `undefined`:
 * a large column an UPDATE did not touch. mark it, so it is left alone at the
 * destination instead of being written as NULL (see UNCHANGED in @syncle/core).
 * under REPLICA IDENTITY FULL the decoder fills these from the old row, so there
 * is nothing to mark.
 */
export function withUnchanged(
  row: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) (out ??= { ...row })[k] = UNCHANGED;
  }
  return out ?? row;
}

/** an old-row image, minus the columns it does not actually carry */
export function present(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}

/** decoded values compare by content: two Dates or Buffers are never `===` */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return Buffer.compare(a, b) === 0;
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object'
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
