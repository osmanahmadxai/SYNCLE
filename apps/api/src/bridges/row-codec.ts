/**
 * Lossless JSON encoding for source rows that have to be parked and written
 * later (the dead-letter queue).
 *
 * Plain `JSON.stringify` quietly changes what a row is: a `Buffer` becomes
 * `{type:'Buffer',data:[…]}`, a `Date` becomes a string the destination may not
 * parse as a timestamp, and a `bigint` throws outright. A row that is retried
 * hours later must reach the destination as the value it was read as, so those
 * three are tagged on the way in and rebuilt on the way out.
 *
 * Tags are single-key objects — `{ "$bytes": … }`, `{ "$date": … }`,
 * `{ "$bigint": … }` — the same convention the backup format uses for bytes. A
 * genuine source object that happens to look like a tag is escaped under
 * `$literal`, so decoding can never mistake data for a tag.
 */

import { UNCHANGED } from '@syncle/core';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const TAGS = new Set(['$bytes', '$date', '$bigint', '$literal', '$unchanged']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function looksLikeTag(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  return keys.length === 1 && TAGS.has(keys[0]!);
}

function encodeValue(value: unknown): Json {
  // "this change did not carry the column" is not NULL, and a symbol would
  // simply vanish from JSON — after which it WOULD be written as NULL
  if (value === UNCHANGED) return { $unchanged: true };
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value === 'number') {
    // NaN/Infinity are not JSON; they would silently become null
    return Number.isFinite(value) ? value : { $literal: String(value) };
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { $date: value.toISOString() };
  }
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (value instanceof Uint8Array)
    return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (isPlainObject(value)) {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeValue(v);
    return looksLikeTag(value) ? { $literal: out } : out;
  }
  // driver wrapper types (Mongo ObjectId / Decimal128, pg intervals…): keep
  // whatever JSON form they define, which is what a plain stringify would give
  const viaJson = (value as { toJSON?: () => unknown }).toJSON?.();
  if (viaJson !== undefined && viaJson !== value) return encodeValue(viaJson);
  return String(value);
}

function decodeValue(value: Json): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (looksLikeTag(value)) {
    const [tag, payload] = Object.entries(value)[0]!;
    if (tag === '$unchanged') return UNCHANGED;
    if (tag === '$bytes' && typeof payload === 'string')
      return Buffer.from(payload, 'base64');
    if (tag === '$date' && typeof payload === 'string')
      return new Date(payload);
    if (tag === '$bigint' && typeof payload === 'string')
      return BigInt(payload);
    if (tag === '$literal') {
      if (payload === 'NaN') return Number.NaN;
      if (payload === 'Infinity') return Number.POSITIVE_INFINITY;
      if (payload === '-Infinity') return Number.NEGATIVE_INFINITY;
      // an escaped look-alike: its own keys are data, not tags
      if (
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload)
      ) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) out[k] = decodeValue(v);
        return out;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v);
  return out;
}

/** serialize rows for durable storage, preserving bytes, dates and bigints */
export function encodeRows(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((r) => encodeValue(r)));
}

/** the inverse of {@link encodeRows}; throws on anything that is not a row list */
export function decodeRows(json: string): Record<string, unknown>[] {
  const parsed = JSON.parse(json) as Json;
  if (!Array.isArray(parsed)) throw new Error('stored rows are not a list');
  return parsed.map((r) => {
    const row = decodeValue(r);
    if (!isPlainObject(row)) throw new Error('stored row is not an object');
    return row;
  });
}

/**
 * rows as plain JSON for the API: bytes shown as a short description rather
 * than a megabyte of base64, dates as ISO strings, bigints as strings
 */
export function rowsForDisplay(json: string): Record<string, unknown>[] {
  const show = (v: unknown): unknown => {
    if (v === UNCHANGED) return '<unchanged>';
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (Array.isArray(v)) return v.map(show);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = show(x);
      return out;
    }
    return v;
  };
  return decodeRows(json).map((r) => show(r) as Record<string, unknown>);
}
