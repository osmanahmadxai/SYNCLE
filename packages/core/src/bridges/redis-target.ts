/**
 * a row, as a Redis key.
 *
 * A Redis destination used to have one shape: a column mapped onto `key`, a
 * column mapped onto `value`, `SET key value`. A table row is not one value,
 * so in practice that meant "pick one column to keep". What people put rows in
 * Redis FOR is a hash per row (`HGETALL user:42`), or the row as a JSON
 * document, under a key their application already knows how to build — often
 * with an expiry. That is what a target's `redis` block says:
 *
 *   keyTemplate  `user:{{id}}`, `tenant:{{tenant_id}}:user:{{id}}`
 *   type         hash  one field per column (NULL = no such field)
 *                json  the whole row, one JSON document in a string
 *                string one column's value
 *   ttlSeconds   the key expires this long after its LAST write
 *
 * The columns the key is built from ARE the target's key columns: a delete has
 * to carry them, and an UPDATE that changes one is the row moving (the old key
 * is removed). That is derived here, once, so that everything which reasons
 * about keys keeps reasoning about columns.
 *
 * Without a `redis` block a Redis target works as it always did.
 */
import { z } from 'zod';

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** the columns a key template is built from, in the order they first appear */
export function redisKeyColumns(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const name = m[1]!;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export const redisTargetSchema = z
  .object({
    keyTemplate: z.string().trim().min(1).max(512),
    type: z.enum(['hash', 'json', 'string']).default('hash'),
    /** `string` only: the (target) column whose value is stored */
    valueColumn: z.string().trim().min(1).max(200).optional(),
    /** seconds after its last write at which the key expires; absent = it does not */
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(10 * 365 * 24 * 3600)
      .optional(),
  })
  .superRefine((redis, ctx) => {
    const columns = redisKeyColumns(redis.keyTemplate);
    if (columns.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyTemplate'],
        message:
          'The key has to be built from at least one column — user:{{id}} — or every row would be written to the same key.',
      });
    }
    // `{{$now}}`, `{{$row}}`: a key has to be the same every time the row is written
    const special = columns.find((c) => c.startsWith('$'));
    if (special) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyTemplate'],
        message: `{{${special}}} cannot be part of a key: a key is built from the row's columns only, so that the same row is always the same key.`,
      });
    }
    if (/\{\{\s*\}\}/.test(redis.keyTemplate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyTemplate'],
        message: 'An empty {{ }} in the key: name a column inside it.',
      });
    }
    if (redis.type === 'string' && !redis.valueColumn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueColumn'],
        message:
          'A string key holds one value: say which column. (A hash or a JSON document holds the whole row.)',
      });
    }
    if (redis.type !== 'string' && redis.valueColumn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueColumn'],
        message: `A ${redis.type} holds every column; "value column" only applies to a string key.`,
      });
    }
  });

export type RedisTargetConfig = z.infer<typeof redisTargetSchema>;

type Row = Record<string, unknown>;

/** a row as the Redis adapter writes it */
export interface RedisRow {
  key: string;
  type: 'hash' | 'string';
  /** hash: field → text (null = the field is removed). string: the text */
  value: Record<string, string | Uint8Array | null> | string | Uint8Array;
  /** seconds; 0 = the key does not expire */
  ttl: number;
  /**
   * a hash written field by field into the one that is there (null = remove the
   * field), not replaced: replacing is a DEL first, which anything following the
   * keyspace would report as the row being deleted on every update
   */
  fields?: true;
}

/** a key could not be built: the row has no value for these columns */
export class RedisKeyError extends Error {
  constructor(
    readonly template: string,
    readonly missing: string[],
  ) {
    super(
      `the row has no value for ${missing.map((c) => `"${c}"`).join(', ')}, which the key ${template} is built from`,
    );
    this.name = 'RedisKeyError';
  }
}

/** one value as the text Redis keeps; null stays null (there is no NULL in Redis) */
export function redisText(value: unknown): string | Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return value; // binary-safe, as Redis strings are
  if (typeof value === 'symbol') return null; // "the source did not send this": nothing to keep
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return redisText((value as { toJSON(): unknown }).toJSON());
  return JSON.stringify(value, jsonSafe);
}

// (no Buffer here: this file is also part of what the browser loads)
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** what JSON has no spelling for, spelled: a bigint as its digits, bytes as base64 */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return base64(value);
  // (a Buffer reaches a replacer already turned into { type: 'Buffer', data })
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  )
    return base64(Uint8Array.from((value as { data: number[] }).data));
  return value;
}

/** the key of a row, or the columns it has no value for */
export function renderRedisKey(template: string, row: Row): string {
  const missing: string[] = [];
  const key = template.replace(TOKEN, (_all, name: string) => {
    const text = redisText(row[name]);
    if (text === null || text === '') {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return typeof text === 'string' ? text : hex(text);
  });
  if (missing.length > 0) throw new RedisKeyError(template, missing);
  return key;
}

/**
 * a row (already mapped onto the target's column names) as the key it becomes.
 * `json` is a string as far as Redis is concerned.
 */
export function toRedisRow(config: RedisTargetConfig, row: Row): RedisRow {
  const key = renderRedisKey(config.keyTemplate, row);
  const ttl = config.ttlSeconds ?? 0;
  if (config.type === 'hash') {
    const value: Record<string, string | Uint8Array | null> = {};
    for (const [column, v] of Object.entries(row)) value[column] = redisText(v);
    return { key, type: 'hash', value, ttl, fields: true };
  }
  if (config.type === 'json') {
    const document: Row = {};
    for (const [column, v] of Object.entries(row))
      document[column] = typeof v === 'symbol' || v === undefined ? null : v;
    return {
      key,
      type: 'string',
      value: JSON.stringify(document, jsonSafe),
      ttl,
    };
  }
  return {
    key,
    type: 'string',
    value: redisText(row[config.valueColumn as string]) ?? '',
    ttl,
  };
}
