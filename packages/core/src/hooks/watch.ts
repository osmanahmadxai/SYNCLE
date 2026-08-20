/**
 * pure change-detection engine for "watch" hooks. given a strategy and the
 * cursor persisted from the last poll, it builds the browse query for the next
 * poll and, from the rows that came back, the new rows plus the advanced
 * cursor. does no I/O, so it's fully unit-testable.
 *
 * three polling strategies, each suited to a different table shape:
 *
 *  - `increment` a strictly-increasing column (auto-increment id, sequence).
 *    `col > cursor`, ordered ascending. exact: never misses or duplicates a
 *    row. detects inserts only.
 *  - `timestamp` a `created_at`/`updated_at` column. `col >= cursor` with
 *    boundary-key dedupe so rows sharing the cursor's timestamp are emitted
 *    once. detects inserts and (for `updated_at`) updates.
 *  - `snapshot` diff the set of seen primary keys (bounded). works when there's
 *    no monotonic cursor (e.g. UUID keys). best for small/medium tables.
 */
import type { FilterSpec, SortSpec } from '../adapters/types';

export type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* strategy + cursor shapes                                                   */
/* -------------------------------------------------------------------------- */

export interface IncrementStrategy {
  strategy: 'increment';
  column: string;
}
export interface TimestampStrategy {
  strategy: 'timestamp';
  column: string;
  /**
   * re-scan this many ms behind the cursor each poll. covers transactions that
   * set their timestamp early but commit late (their rows would otherwise land
   * behind an already-advanced cursor and never be seen). the window's rows are
   * deduped via `boundaryKeys`, so the overlap re-fetch never re-emits.
   */
  lookbackMs?: number;
}
export interface SnapshotStrategy {
  strategy: 'snapshot';
  /** cap on tracked primary keys (bounds memory/state) */
  maxTracked: number;
}
export type WatchStrategy =
  | IncrementStrategy
  | TimestampStrategy
  | SnapshotStrategy;

export interface IncrementCursor {
  strategy: 'increment';
  value: unknown;
  /** the column this cursor value belongs to (guards against editing the strategy) */
  column?: string;
}
export interface TimestampCursor {
  strategy: 'timestamp';
  ts: unknown;
  /**
   * row keys already emitted at `ts` — and, when a lookback window is
   * configured, within the window behind it (dedupe on the `>=` re-fetch)
   */
  boundaryKeys: string[];
  /** the column this cursor value belongs to (guards against editing the strategy) */
  column?: string;
}
export interface SnapshotCursor {
  strategy: 'snapshot';
  seen: string[];
}
export type WatchCursor = IncrementCursor | TimestampCursor | SnapshotCursor;

export interface AdvanceResult {
  newRows: Row[];
  cursor: WatchCursor;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** stable identity for a row from its primary key (falls back to all values) */
export function rowKey(row: Row, pk: string[]): string {
  const cols = pk.length > 0 ? pk : Object.keys(row).sort();
  return JSON.stringify(cols.map((c) => row[c] ?? null));
}

/** normalize a timestamp-ish value (Date | ISO string | epoch number) */
function tsNorm(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? v : t;
  }
  return String(v);
}

/** compare two timestamp-ish values (Date | ISO string | epoch number) */
function tsEquals(a: unknown, b: unknown): boolean {
  return tsNorm(a) === tsNorm(b);
}

/** true when `a` sorts after `b` (mixed types fall back to string order) */
function tsGreater(a: unknown, b: unknown): boolean {
  const na = tsNorm(a);
  const nb = tsNorm(b);
  if (typeof na === 'number' && typeof nb === 'number') return na > nb;
  return String(na) > String(nb);
}

/** a serializable form of a timestamp value for persisting in the cursor */
function serializeTs(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * `ts` shifted `ms` into the past, in a form comparable against the column
 * (ISO string stays ISO, epoch number stays a number). values that don't
 * normalize to a number are returned unchanged — no lookback is possible.
 */
function tsMinus(ts: unknown, ms: number): unknown {
  const n = tsNorm(ts);
  if (typeof n !== 'number') return ts;
  if (typeof ts === 'number') return n - ms;
  return new Date(n - ms).toISOString();
}

/* -------------------------------------------------------------------------- */
/* engine                                                                     */
/* -------------------------------------------------------------------------- */

/** the cursor for a brand-new watch run that should emit from the beginning */
export function emptyCursor(strategy: WatchStrategy): WatchCursor {
  switch (strategy.strategy) {
    case 'increment':
      return { strategy: 'increment', value: null, column: strategy.column };
    case 'timestamp':
      return { strategy: 'timestamp', ts: null, boundaryKeys: [], column: strategy.column };
    case 'snapshot':
      return { strategy: 'snapshot', seen: [] };
  }
}

/**
 * the browse filters + sort for the next poll, given the current cursor.
 * `pk` (when known) makes paging deterministic: the timestamp strategy uses it
 * as a secondary sort so rows sharing a timestamp always come back in the same
 * order, and the snapshot strategy orders its scan by it so the scanned page
 * is stable across polls (an unordered LIMIT scan can return a different
 * subset each time and silently miss rows).
 */
export function watchQuery(
  strategy: WatchStrategy,
  cursor: WatchCursor,
  pk: string[] = [],
): { filters: FilterSpec[]; sort: SortSpec[] } {
  if (strategy.strategy === 'increment' && cursor.strategy === 'increment') {
    return {
      filters:
        cursor.value != null
          ? [{ column: strategy.column, operator: 'gt', value: cursor.value }]
          : [],
      sort: [{ column: strategy.column, direction: 'asc' }],
    };
  }
  if (strategy.strategy === 'timestamp' && cursor.strategy === 'timestamp') {
    const tiebreakers: SortSpec[] = pk
      .filter((c) => c !== strategy.column)
      .map((c) => ({ column: c, direction: 'asc' }));
    // re-scan the lookback window behind the cursor so late-committing
    // transactions (timestamp set early, commit after the cursor moved past
    // it) are still picked up; boundaryKeys dedupes the overlap
    const lookback = strategy.lookbackMs ?? 0;
    const bound =
      cursor.ts != null && lookback > 0 ? tsMinus(cursor.ts, lookback) : cursor.ts;
    return {
      filters:
        cursor.ts != null
          ? [{ column: strategy.column, operator: 'gte', value: bound }]
          : [],
      sort: [{ column: strategy.column, direction: 'asc' }, ...tiebreakers],
    };
  }
  // snapshot: scan the table (caller bounds the page size)
  return {
    filters: [],
    sort: pk.map((c) => ({ column: c, direction: 'asc' })),
  };
}

/**
 * from the candidate rows returned by {@link watchQuery} (already filtered and
 * sorted ascending), return the genuinely-new rows and the advanced cursor.
 */
export function advanceCursor(
  strategy: WatchStrategy,
  cursor: WatchCursor,
  rows: Row[],
  pk: string[],
): AdvanceResult {
  if (strategy.strategy === 'increment' && cursor.strategy === 'increment') {
    // every row is strictly greater than the cursor by query construction.
    // skip NULLs when advancing — a null cursor value would make the next
    // poll a fresh watch and re-deliver the whole table
    let value = cursor.value;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i]![strategy.column];
      if (v != null) {
        value = v;
        break;
      }
    }
    return {
      newRows: rows,
      cursor: { strategy: 'increment', value, column: strategy.column },
    };
  }

  if (strategy.strategy === 'timestamp' && cursor.strategy === 'timestamp') {
    const alreadyEmitted = new Set(cursor.boundaryKeys);
    const newRows = rows.filter((r) => !alreadyEmitted.has(rowKey(r, pk)));
    if (rows.length === 0) {
      return { newRows, cursor };
    }
    // max NON-NULL timestamp of the page. NULLs must never advance (or reset)
    // the cursor — a null ts looks like a fresh watch on the next poll and
    // would re-deliver the whole table forever
    let maxTs: unknown = null;
    for (const r of rows) {
      const v = r[strategy.column];
      if (v == null) continue;
      if (maxTs == null || tsGreater(v, maxTs)) maxTs = v;
    }
    if (maxTs == null) {
      return { newRows, cursor };
    }
    // the lookback window can hand back a page consisting purely of older,
    // already-emitted rows — the cursor must never move backwards through them
    const nextTs =
      cursor.ts != null && !tsGreater(maxTs, cursor.ts) ? cursor.ts : maxTs;
    // remember all rows at the boundary timestamp — and, with a lookback
    // window, every row inside the window behind it — so the next `>=` poll
    // can dedupe the re-fetched overlap
    const lookback = strategy.lookbackMs ?? 0;
    const nNext = tsNorm(nextTs);
    const inWindow = (v: unknown): boolean => {
      if (v == null) return false;
      if (tsEquals(v, nextTs)) return true;
      if (lookback <= 0) return false;
      const n = tsNorm(v);
      return (
        typeof n === 'number' && typeof nNext === 'number' && nNext - n <= lookback
      );
    };
    const boundaryKeys = rows
      .filter((r) => inWindow(r[strategy.column]))
      .map((r) => rowKey(r, pk));
    // keys remembered by earlier polls stay live for as long as their rows can
    // still be re-fetched, i.e. until the cursor moves a full window past them.
    // this poll may only have seen a subset of those rows (same-ts paging, a
    // truncated page), so union — replacing would shed keys for overlap rows
    // this page didn't contain and re-deliver them next poll
    const carry = cursor.ts != null && inWindow(cursor.ts);
    return {
      newRows,
      cursor: {
        strategy: 'timestamp',
        ts: serializeTs(nextTs),
        boundaryKeys: carry
          ? [...new Set([...cursor.boundaryKeys, ...boundaryKeys])]
          : boundaryKeys,
        column: strategy.column,
      },
    };
  }

  // snapshot
  const seen = new Set(cursor.strategy === 'snapshot' ? cursor.seen : []);
  const newRows: Row[] = [];
  for (const r of rows) {
    const k = rowKey(r, pk);
    if (!seen.has(k)) {
      seen.add(k);
      newRows.push(r);
    }
  }
  const max = strategy.strategy === 'snapshot' ? strategy.maxTracked : 50_000;
  let kept = [...seen];
  if (kept.length > max) kept = kept.slice(kept.length - max);
  return { newRows, cursor: { strategy: 'snapshot', seen: kept } };
}
