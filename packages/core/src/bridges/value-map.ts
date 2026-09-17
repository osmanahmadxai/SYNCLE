/**
 * Cross-engine VALUE translation — the other half of `type-map.ts`.
 *
 * Picking the right column type is not enough: each driver also has its own
 * idea of what a value of that type looks like in JavaScript, and another
 * engine's driver does not share it. A row is translated here, once, between
 * being read and being written, using what is known about the SOURCE column:
 *
 *   timestamptz  Postgres sends '2026-03-04 05:06:07.891234+00'. MySQL rejects
 *                the offset and SQLite just stores the string, so both get the
 *                same instant as a UTC wall-clock value, microseconds intact.
 *   timestamp    a MySQL zero date ('0000-00-00 …') is MySQL's "no date"; no
 *                other engine accepts it, so it becomes NULL.
 *   boolean      MySQL has none: tinyint(1) reads as 0/1 and bit(1) as a
 *                one-byte Buffer. Both become real booleans elsewhere.
 *   json         an engine that stores JSON as text (SQLite) hands over a
 *                string; a json column elsewhere would store that as a JSON
 *                STRING — double-encoded — so it is parsed back to structure.
 *   integers     arrive as digit strings where they may exceed 2^53. MongoDB
 *                has real numbers, so it gets one whenever that is exact.
 *
 * Everything else is already a plain value every driver binds the same way,
 * and is passed through untouched: this layer converts only what it must.
 *
 * Same-engine bridges are not converted — what the driver read, it can write —
 * with one exception, a JSON column on its way into Postgres (JsonColumnValue).
 */
import type { DatabaseEngine } from '../adapters/types';
import { parseColumnType, type PortableKind } from './type-map';

type Row = Record<string, unknown>;
export type ValueConverter = (value: unknown) => unknown;

/* ----- timestamps ----- */

const TS =
  /^(\d{4,})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?\s*(Z|[+-]\d\d(?::?\d\d)?(?::\d\d)?)?$/i;

interface Instant {
  /** UTC milliseconds of the whole second */
  ms: number;
  /** the fractional second as exactly six digits */
  micros: string;
}

/** read a timestamp WITH zone; null when it is not one (infinity, BC, junk) */
function parseInstant(text: string): Instant | null {
  const m = TS.exec(text.trim());
  if (!m || !m[8]) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  let offsetMin = 0;
  if (zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d\d)(?::?(\d\d))?/.exec(zone)!;
    offsetMin =
      (Number(z[2]) * 60 + Number(z[3] ?? 0)) * (z[1] === '-' ? -1 : 1);
  }
  const ms =
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ) -
    offsetMin * 60_000;
  if (!Number.isFinite(ms)) return null;
  return { ms, micros: (frac ?? '').padEnd(6, '0').slice(0, 6) };
}

const two = (n: number): string => String(n).padStart(2, '0');

/** the UTC wall-clock reading of an instant, to the microsecond */
function utcWallClock(i: Instant, sep: ' ' | 'T'): string {
  const d = new Date(i.ms);
  return (
    `${String(d.getUTCFullYear()).padStart(4, '0')}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}` +
    `${sep}${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${i.micros}`
  );
}

function instantOf(v: unknown): Instant | null {
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isNaN(t)) return null;
    const whole = Math.floor(t / 1000) * 1000;
    return { ms: whole, micros: String(t - whole).padStart(3, '0') + '000' };
  }
  return typeof v === 'string' ? parseInstant(v) : null;
}

/** MySQL's "no date": a zero year, month or day that no other engine accepts */
function isZeroDate(v: unknown): boolean {
  return (
    typeof v === 'string' &&
    /^(0000-\d\d-\d\d|\d{4}-00-\d\d|\d{4}-\d\d-00)/.test(v)
  );
}

/** hex without `Buffer`, which this browser-safe package cannot assume */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/* ----- per-kind converters ----- */

const isInteger = (k: PortableKind): boolean =>
  k === 'smallint' || k === 'integer' || k === 'bigint';

function timestamptzTo(target: DatabaseEngine): ValueConverter | null {
  switch (target) {
    case 'mysql':
      // DATETIME has no zone and MySQL refuses '+00': store the UTC reading
      return (v) => {
        const i = instantOf(v);
        return i ? utcWallClock(i, ' ') : v;
      };
    case 'sqlite':
      // ISO-8601 with Z: what SQLite's own date functions read as UTC
      return (v) => {
        const i = instantOf(v);
        return i ? `${utcWallClock(i, 'T')}Z` : v;
      };
    case 'mongodb':
      return (v) => {
        if (v instanceof Date) return v;
        const i = instantOf(v);
        return i ? new Date(i.ms + Number(i.micros.slice(0, 3))) : v;
      };
    default:
      return null; // Postgres reads its own text; Redis stores the string
  }
}

function booleanTo(target: DatabaseEngine): ValueConverter | null {
  // MySQL and SQLite store a boolean as 0/1 themselves
  if (target === 'mysql' || target === 'sqlite') {
    return (v) => (v instanceof Uint8Array ? (v[v.length - 1] ? 1 : 0) : v);
  }
  return (v) => {
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (v instanceof Uint8Array) return v.length > 0 && v[v.length - 1] !== 0;
    if (typeof v === 'number') return v !== 0;
    if (v === '0' || v === '1') return v === '1';
    return v;
  };
}

/**
 * a value headed for a Postgres json/jsonb column, marked as such.
 *
 * `pg` decides how to send a parameter from its JavaScript type alone: a string
 * goes as text, an array as a Postgres array literal. for a json column both
 * are wrong — the JSON string "abc" must be sent as `"abc"` (quoted), not `abc`
 * (a syntax error) and not `123` for the string "123" (which would silently
 * arrive as a NUMBER). the driver cannot know the column is json; this says so.
 * it serialises itself correctly on both of the adapter's write paths:
 * `toPostgres` for a bound parameter, `toJSON` inside the bulk JSON document.
 */
export class JsonColumnValue {
  constructor(readonly value: unknown) {}
  toPostgres(): string {
    return JSON.stringify(this.value);
  }
  toJSON(): unknown {
    return this.value;
  }
}

/** engines whose driver hands a JSON column over as its serialised text */
const READS_JSON_AS_TEXT: ReadonlySet<DatabaseEngine> = new Set([
  'sqlite',
  'redis',
]);

function jsonTo(
  source: DatabaseEngine,
  target: DatabaseEngine,
): ValueConverter | null {
  // these write JSON as text anyway, so text is exactly right
  if (target === 'mysql' || target === 'sqlite' || target === 'redis')
    return null;

  // a string from SQLite is serialised JSON; a string from Postgres, MySQL or
  // MongoDB is a JSON string VALUE, already parsed by the driver
  const parse = (v: unknown): unknown => {
    if (!READS_JSON_AS_TEXT.has(source) || typeof v !== 'string') return v;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v; // not JSON after all: leave it for the target to reject
    }
  };
  return target === 'postgres' ? (v) => new JsonColumnValue(parse(v)) : parse;
}

function integerTo(target: DatabaseEngine): ValueConverter | null {
  if (target !== 'mongodb') return null;
  return (v) => {
    if (typeof v !== 'string' || !/^-?\d+$/.test(v)) return v;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  };
}

/**
 * the converter for ONE column, or null when its values need nothing done.
 * `source` is the source engine and `dataType` that column's native type.
 */
export function valueConverterFor(
  dataType: string,
  source: DatabaseEngine,
  target: DatabaseEngine,
): ValueConverter | null {
  const { kind } = parseColumnType(dataType, source);
  // the one conversion a same-engine bridge still needs: see JsonColumnValue
  if (kind === 'json' && target === 'postgres') return jsonTo(source, target);
  if (source === target) return null;

  let convert: ValueConverter | null = null;
  if (kind === 'timestamptz') convert = timestamptzTo(target);
  else if (kind === 'boolean') convert = booleanTo(target);
  else if (kind === 'json') convert = jsonTo(source, target);
  else if (isInteger(kind)) convert = integerTo(target);
  else if (kind === 'timestamp' && target === 'mongodb') {
    // MongoDB only has instants. a wall-clock reading carries no zone, so it is
    // taken as UTC — the one reading that does not depend on where this runs
    convert = (v) => {
      if (typeof v !== 'string') return v;
      const i = parseInstant(`${v.trim()}Z`);
      return i ? new Date(i.ms + Number(i.micros.slice(0, 3))) : v;
    };
  } else if (kind === 'opaque') {
    // e.g. a MySQL geometry: raw bytes that are headed for a TEXT column
    convert = (v) => (v instanceof Uint8Array ? toHex(v) : v);
  }

  // a zero date can sit in any MySQL temporal column
  const temporal =
    kind === 'date' || kind === 'timestamp' || kind === 'timestamptz';
  if (source === 'mysql' && temporal) {
    const inner = convert;
    return (v) => (isZeroDate(v) ? null : inner ? inner(v) : v);
  }
  return convert;
}

/**
 * a converter for whole rows, keyed by SOURCE column name — or null when no
 * column of this source needs converting for this target (the common case, and
 * then the rows are not touched at all). columns the row does not carry, such
 * as the ones missing from a delete's key-only image, are simply skipped.
 */
export function rowConverterFor(
  columns: ReadonlyArray<{ name: string; sourceType: string }>,
  source: DatabaseEngine,
  target: DatabaseEngine,
): ((row: Row) => Row) | null {
  const converters: Array<[string, ValueConverter]> = [];
  for (const c of columns) {
    const convert = valueConverterFor(c.sourceType, source, target);
    if (convert) converters.push([c.name, convert]);
  }
  if (converters.length === 0) return null;

  return (row) => {
    let out: Row | null = null;
    for (const [name, convert] of converters) {
      if (!(name in row)) continue;
      const before = row[name];
      // a symbol is a marker (UNCHANGED: "the source did not send this"), not a
      // value: there is nothing to convert, and it must reach the writer intact
      if (before === null || before === undefined || typeof before === 'symbol')
        continue;
      const after = convert(before);
      if (after !== before) (out ??= { ...row })[name] = after;
    }
    return out ?? row;
  };
}
