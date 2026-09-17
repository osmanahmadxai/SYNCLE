/**
 * is the row in the destination the row the source has?
 *
 * Two drivers reading the same value do not hand over the same JavaScript: a
 * numeric is '1.50' here and 1.5 there, a timestamp is text in one engine and
 * a Date in another, jsonb comes back with its keys in another order. Comparing
 * with `===` would call every row of a healthy copy different; comparing as
 * text would miss a real difference behind a lucky spelling.
 *
 * So values are compared BY KIND — what the source column is — and only after
 * both readings are brought to one spelling of that kind. Where the kind is not
 * known (a document store has no column types) the value itself says what it is.
 *
 * What this deliberately does NOT forgive: a destination column that is
 * narrower than the source — fewer decimals, no fractional seconds, a shorter
 * varchar. Those rows ARE different, and saying so is the point.
 * What it cannot see: a JSON `null` inside a json column and a SQL NULL are the
 * same JavaScript value on every driver.
 */
import type { ColumnTransform } from './column-transforms';
import { templateColumns } from './transform';
import type { PortableKind } from './type-map';
import { JsonColumnValue } from './value-map';

export type CompareKind = PortableKind | 'unknown';

type Row = Record<string, unknown>;

const isNil = (v: unknown): v is null | undefined =>
  v === null || v === undefined;

/* ----- bytes ----- */

function bytesOf(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  // a Buffer that went through JSON
  if (
    v &&
    typeof v === 'object' &&
    (v as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((v as { data?: unknown }).data)
  ) {
    return Uint8Array.from((v as { data: number[] }).data);
  }
  return null;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/* ----- numbers ----- */

/** a plain decimal in one spelling: no sign on zero, no leading or trailing zeros. null = not a plain decimal */
function decimalText(v: unknown): string | null {
  let text: string;
  if (typeof v === 'bigint') text = v.toString();
  else if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    text = String(v);
  } else if (typeof v === 'string') text = v.trim();
  else return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const whole = m[2]!.replace(/^0+(?=\d)/, '') || '0';
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  const magnitude = fraction ? `${whole}.${fraction}` : whole;
  return m[1] === '-' && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const text = v.trim().toLowerCase();
    if (text === 'nan') return NaN;
    if (text === 'infinity' || text === '+infinity' || text === 'inf')
      return Infinity;
    if (text === '-infinity' || text === '-inf') return -Infinity;
    const n = Number(text);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** floating point: the same to the digits the narrower of the two types can hold */
function sameFloat(a: unknown, b: unknown, digits: number): boolean | null {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x === null || y === null) return null;
  if (Number.isNaN(x) || Number.isNaN(y))
    return Number.isNaN(x) && Number.isNaN(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return x === y;
  if (x === y) return true;
  return Math.abs(x - y) <= Math.max(Math.abs(x), Math.abs(y)) * 10 ** -digits;
}

/* ----- booleans ----- */

function booleanOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 1n) return true;
  if (v === 0 || v === 0n) return false;
  if (typeof v === 'string') {
    const text = v.trim().toLowerCase();
    if (['1', 't', 'true', 'y', 'yes', 'on'].includes(text)) return true;
    if (['0', 'f', 'false', 'n', 'no', 'off'].includes(text)) return false;
  }
  const bytes = bytesOf(v); // MySQL bit(1)
  if (bytes && bytes.length === 1)
    return bytes[0] === 1 ? true : bytes[0] === 0 ? false : null;
  return null;
}

/* ----- time ----- */

const STAMP =
  /^(\d{4,})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/i;

interface Moment {
  /** milliseconds since the epoch of the whole second, the reading taken as UTC unless it carries a zone */
  seconds: number;
  /** the fraction of the second, without trailing zeros */
  fraction: string;
  /** could only ever hold milliseconds (a JavaScript Date) */
  millisOnly: boolean;
}

function momentOf(v: unknown): Moment | null {
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) return null;
    const whole = Math.floor(ms / 1000) * 1000;
    return {
      seconds: whole,
      fraction: String(ms - whole)
        .padStart(3, '0')
        .replace(/0+$/, ''),
      millisOnly: true,
    };
  }
  if (typeof v !== 'string') return null;
  const m = STAMP.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  let offsetMin = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d\d)(?::?(\d\d))?/.exec(zone)!;
    offsetMin =
      (Number(z[2]) * 60 + Number(z[3] ?? 0)) * (z[1] === '-' ? -1 : 1);
  }
  const seconds =
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
    ) -
    offsetMin * 60_000;
  if (!Number.isFinite(seconds)) return null;
  return {
    seconds,
    fraction: (frac ?? '').replace(/0+$/, ''),
    millisOnly: false,
  };
}

function sameMoment(a: unknown, b: unknown): boolean | null {
  const x = momentOf(a);
  const y = momentOf(b);
  if (!x || !y) return null;
  if (x.seconds !== y.seconds) return false;
  // a Date never held more than milliseconds: the rest was not lost in THIS copy, it cannot exist there
  if (x.millisOnly || y.millisOnly)
    return (
      x.fraction.slice(0, 3).replace(/0+$/, '') ===
      y.fraction.slice(0, 3).replace(/0+$/, '')
    );
  return x.fraction === y.fraction;
}

const TIME = /^(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?$/;

function timeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = TIME.exec(v.trim());
  if (!m) return null;
  const fraction = (m[4] ?? '').replace(/0+$/, '');
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}${fraction ? `.${fraction}` : ''}`;
}

function dateText(v: unknown): string | null {
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const m = STAMP.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/* ----- structure ----- */

function unwrap(v: unknown): unknown {
  return v instanceof JsonColumnValue ? v.value : v;
}

/** JSON in one spelling: keys in order, and text that IS json read as json */
function canonicalJson(v: unknown, parseText: boolean): string {
  let value = unwrap(v);
  if (parseText && typeof value === 'string') {
    const text = value.trim();
    if (/^[[{"]|^(true|false|null|-?\d)/.test(text)) {
      try {
        value = JSON.parse(text);
      } catch {
        /* a string that only looks like JSON is a string */
      }
    }
  }
  const order = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(order);
    if (x instanceof Date) return x.toISOString();
    if (typeof x === 'bigint') return x.toString();
    const bytes = bytesOf(x);
    if (bytes) return `\\x${hex(bytes)}`;
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x as Row)
          .sort()
          .map((k) => [k, order((x as Row)[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(order(value)) ?? 'undefined';
}

/**
 * one engine hands a json column over parsed, another as its text — and which
 * is which cannot be told from the value: the text `"abc"` is the JSON string
 * abc from SQLite and a six-character string from PostgreSQL. the same if ANY
 * reading of the one matches any reading of the other; what that can miss is a
 * JSON string "123" against the number 123, which is not drift anyone has
 */
function sameJson(a: unknown, b: unknown): boolean {
  const readings = (v: unknown) =>
    new Set([canonicalJson(v, true), canonicalJson(v, false)]);
  const left = readings(a);
  for (const reading of readings(b)) if (left.has(reading)) return true;
  return false;
}

/* ----- the comparison ----- */

/** no kind to go by: what the two values are decides how they are compared */
function sameUnknown(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = booleanOf(a);
    const y = booleanOf(b);
    if (x !== null && y !== null) return x === y;
  }
  if (a instanceof Date || b instanceof Date) {
    const same = sameMoment(a, b);
    if (same !== null) return same;
  }
  const bytesA = bytesOf(a);
  const bytesB = bytesOf(b);
  if (bytesA || bytesB)
    return !!bytesA && !!bytesB && hex(bytesA) === hex(bytesB);
  if (
    typeof a === 'number' ||
    typeof b === 'number' ||
    typeof a === 'bigint' ||
    typeof b === 'bigint'
  ) {
    const x = decimalText(a);
    const y = decimalText(b);
    if (x !== null && y !== null) return x === y;
    const same = sameFloat(a, b, 12);
    if (same !== null) return same;
  }
  if ((a && typeof a === 'object') || (b && typeof b === 'object'))
    return sameJson(a, b);
  return String(a) === String(b);
}

/**
 * are these two readings the same value? `kind` is what the SOURCE column is
 * ('unknown' when the source has no column types).
 */
export function sameValue(
  kind: CompareKind,
  expected: unknown,
  actual: unknown,
): boolean {
  const a = unwrap(expected);
  const b = unwrap(actual);
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);

  switch (kind) {
    case 'boolean': {
      const x = booleanOf(a);
      const y = booleanOf(b);
      return x !== null && y !== null ? x === y : sameUnknown(a, b);
    }
    case 'smallint':
    case 'integer':
    case 'bigint':
    case 'decimal': {
      const x = decimalText(a);
      const y = decimalText(b);
      if (x !== null && y !== null) return x === y;
      // 1e-7, NaN, Infinity: not plain decimals, still numbers
      return sameFloat(a, b, 15) ?? sameUnknown(a, b);
    }
    case 'float':
      return sameFloat(a, b, 6) ?? sameUnknown(a, b);
    case 'double':
      return sameFloat(a, b, 14) ?? sameUnknown(a, b);
    case 'timestamp':
    case 'timestamptz':
      return sameMoment(a, b) ?? sameUnknown(a, b);
    case 'date': {
      const x = dateText(a);
      const y = dateText(b);
      return x !== null && y !== null ? x === y : sameUnknown(a, b);
    }
    case 'time': {
      const x = timeText(a);
      const y = timeText(b);
      return x !== null && y !== null ? x === y : sameUnknown(a, b);
    }
    case 'json':
    case 'array':
      return sameJson(a, b);
    case 'bytes': {
      const x = bytesOf(a);
      const y = bytesOf(b);
      return x && y ? hex(x) === hex(y) : sameUnknown(a, b);
    }
    case 'uuid':
      return String(a).toLowerCase() === String(b).toLowerCase();
    case 'char':
      // blank-padded to its length by some engines, and handed back trimmed by others
      return String(a).trimEnd() === String(b).trimEnd();
    case 'objectid':
    case 'varchar':
    case 'text':
    case 'interval':
    case 'opaque':
      return typeof a === 'object' || typeof b === 'object'
        ? sameUnknown(a, b)
        : String(a) === String(b);
    default:
      return sameUnknown(a, b);
  }
}

const NUMERIC: ReadonlySet<CompareKind> = new Set([
  'smallint',
  'integer',
  'bigint',
  'decimal',
  'float',
  'double',
]);

/**
 * one spelling of a key, so that the 5 one engine reads and the '5' another
 * does are the same row — and so that '007' and '7' in a TEXT key never are.
 * `kinds` are the key columns' kinds, in order; composite keys keep their order.
 *
 * with no kind to go by (a document store), a string counts as a number only
 * when it is spelled exactly the way that number is written: '5' is 5, '007'
 * and '5.0' are text.
 */
export function keyText(
  values: readonly unknown[],
  kinds: readonly CompareKind[] = [],
): string {
  return JSON.stringify(
    values.map((v, i) => {
      const value = unwrap(v);
      const kind = kinds[i] ?? 'unknown';
      if (isNil(value)) return null;
      if (NUMERIC.has(kind)) {
        const decimal = decimalText(value);
        if (decimal !== null) return `n:${decimal}`;
      }
      if (kind === 'boolean') {
        const flag = booleanOf(value);
        if (flag !== null) return `n:${flag ? 1 : 0}`;
      }
      if (kind === 'uuid') return `s:${String(value).toLowerCase()}`;
      if (kind === 'char') return `s:${String(value).trimEnd()}`;
      if (kind === 'timestamp' || kind === 'timestamptz') {
        const moment = momentOf(value);
        if (moment) return `t:${moment.seconds}.${moment.fraction}`;
      }
      if (kind === 'date') {
        const date = dateText(value);
        if (date) return `d:${date}`;
      }
      if (kind === 'unknown') {
        if (typeof value === 'number' || typeof value === 'bigint') {
          const decimal = decimalText(value);
          if (decimal !== null) return `n:${decimal}`;
        }
        if (typeof value === 'string' && decimalText(value) === value)
          return `n:${value}`;
        if (typeof value === 'boolean') return `n:${value ? 1 : 0}`;
      }
      if (value instanceof Date)
        return `t:${Math.floor(value.getTime() / 1000) * 1000}.${String(
          value.getTime() % 1000,
        )
          .padStart(3, '0')
          .replace(/0+$/, '')}`;
      const bytes = bytesOf(value);
      if (bytes) return `x:${hex(bytes)}`;
      if (typeof value === 'object') return `j:${canonicalJson(value, false)}`;
      return `s:${String(value)}`;
    }),
  );
}

export interface ColumnDifference {
  column: string;
  expected: unknown;
  actual: unknown;
}

/**
 * the columns of `expected` (the source's row, as it would be written) that the
 * destination's row does not hold the same value for. columns the destination
 * has and the bridge does not write are none of its business.
 */
export function diffRow(
  expected: Row,
  actual: Row,
  kinds: Readonly<Record<string, CompareKind>>,
): ColumnDifference[] {
  const out: ColumnDifference[] = [];
  for (const [column, value] of Object.entries(expected)) {
    if (typeof value === 'symbol') continue; // "the source did not send this": nothing to compare
    if (!sameValue(kinds[column] ?? 'unknown', value, actual[column])) {
      out.push({ column, expected: unwrap(value), actual: actual[column] });
    }
  }
  return out;
}

/**
 * columns whose value depends on WHEN the row was delivered — a computed column
 * that uses `{{$now}}`, and anything computed from one. they can never be the
 * same twice, so they are not compared: a loaded_at that differs is not drift.
 */
export function volatileColumns(
  transforms: readonly ColumnTransform[] | undefined,
): Set<string> {
  const volatile = new Set<string>();
  for (const step of transforms ?? []) {
    if (step.kind !== 'set') continue;
    const usesNow = /\{\{\s*\$now\s*\}\}/.test(step.template);
    const usesVolatile = templateColumns(step.template).some((name) =>
      volatile.has(name),
    );
    if (usesNow || usesVolatile) volatile.add(step.column);
    // computed afresh from things that do not move: no longer volatile
    else volatile.delete(step.column);
  }
  return volatile;
}
