/**
 * in-process evaluation of a hook's source filters against one change row.
 *
 * replay and polling push `hook.source.filters` into the engine (SQL WHERE /
 * Mongo find), but a CDC stream sees every row of the table, so the same
 * predicates have to run here. semantics mirror the adapters' `buildWhere` /
 * `buildMongoFilter`:
 *  - filters AND together
 *  - comparisons against SQL NULL (a null/undefined row value) never match,
 *    including `neq` — only `isNull` sees them
 *  - contains/startsWith/endsWith are case-insensitive, like ILIKE, MySQL's
 *    default collation, and the Mongo `$options: 'i'` regexes
 *  - `in` with an empty (or non-array) value matches nothing (`1 = 0`)
 *  - numeric-looking values compare numerically, so a pgoutput text value
 *    "42" still matches a numeric filter 42
 */
import type { FilterSpec } from '@syncle/core';

export interface FilterMatchOptions {
  /**
   * pass filters whose column is ABSENT from the row (present-but-null still
   * fails). delete images may carry only the key columns (Postgres REPLICA
   * IDENTITY DEFAULT), and dropping every delete because the filtered column
   * isn't in the image would silently stop deletes from syncing.
   */
  passMissingColumns?: boolean;
}

/** true when `row` satisfies every filter (an empty/missing list matches all) */
export function rowMatchesFilters(
  row: Record<string, unknown>,
  filters: FilterSpec[] | undefined,
  opts: FilterMatchOptions = {},
): boolean {
  if (!filters || filters.length === 0) return true;
  for (const f of filters) {
    if (opts.passMissingColumns && !(f.column in row)) continue;
    if (!matchesOne(row[f.column], f)) return false;
  }
  return true;
}

function matchesOne(value: unknown, f: FilterSpec): boolean {
  switch (f.operator) {
    case 'isNull':
      return value == null;
    case 'notNull':
      return value != null;
    case 'eq':
      return compare(value, f.value) === 0;
    case 'neq': {
      const c = compare(value, f.value);
      return c !== null && c !== 0;
    }
    case 'lt': {
      const c = compare(value, f.value);
      return c !== null && c < 0;
    }
    case 'lte': {
      const c = compare(value, f.value);
      return c !== null && c <= 0;
    }
    case 'gt': {
      const c = compare(value, f.value);
      return c !== null && c > 0;
    }
    case 'gte': {
      const c = compare(value, f.value);
      return c !== null && c >= 0;
    }
    case 'contains':
      return likeHaystack(value)?.includes(likeNeedle(f.value)) ?? false;
    case 'startsWith':
      return likeHaystack(value)?.startsWith(likeNeedle(f.value)) ?? false;
    case 'endsWith':
      return likeHaystack(value)?.endsWith(likeNeedle(f.value)) ?? false;
    case 'in':
      return Array.isArray(f.value) && f.value.some((v) => compare(value, v) === 0);
    default:
      // configs are zod-validated, so an unknown operator can only mean a
      // schema drift — fail closed rather than stream unfiltered rows
      return false;
  }
}

/** three-way compare with light cross-type coercion. null = incomparable */
function compare(row: unknown, filter: unknown): -1 | 0 | 1 | null {
  if (row == null || filter == null) return null;
  const nr = toNumber(row);
  const nf = toNumber(filter);
  if (nr !== null && nf !== null) return nr === nf ? 0 : nr < nf ? -1 : 1;
  // Date row values (Mongo) compare by instant against ISO-ish filter strings
  if (row instanceof Date || filter instanceof Date) {
    const tr = toTime(row);
    const tf = toTime(filter);
    if (tr !== null && tf !== null) return tr === tf ? 0 : tr < tf ? -1 : 1;
  }
  const sr = asString(row);
  const sf = asString(filter);
  return sr === sf ? 0 : sr < sf ? -1 : 1;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function toTime(v: unknown): number | null {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
}

function asString(v: unknown): string {
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** the row side of a LIKE-style match, lowercased; null when SQL NULL */
function likeHaystack(v: unknown): string | null {
  if (v == null) return null;
  return asString(v).toLowerCase();
}

/** the pattern side of a LIKE-style match (`buildWhere` stringifies it too) */
function likeNeedle(v: unknown): string {
  return String(v ?? '').toLowerCase();
}
