/**
 * Column transforms: what happens to a row between being read and being
 * delivered — to a database table or to an HTTP payload alike.
 *
 *   mask      hide a value: redact it, keep its ends, replace it with a hash
 *   cast      make it a string / number / integer / boolean / date / json
 *   text      trim, lower-case, upper-case
 *   default   a value for when the source has none
 *   set       a column computed from a template over the other columns
 *
 * Declarative on purpose. A bridge's configuration is data that anyone with the
 * UI can write, and it runs inside the process that holds every stored
 * credential: there is no expression language here, and nothing is evaluated.
 *
 * They run in the order written, each seeing what the ones before it did, so
 * "lower-case the e-mail, then hash it" is two steps.
 */
import { z } from 'zod';

const column = z.string().min(1).max(200);

export const columnTransformSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mask'),
    column,
    /**
     * redact  the whole value becomes `fill` repeated (length is not revealed)
     * partial keep `keepStart` / `keepEnd` characters, fill the middle
     * hash    SHA-256 of the value (hex): stable, so it still joins and dedupes
     * null    drop the value, keep the column
     */
    mode: z.enum(['redact', 'partial', 'hash', 'null']),
    keepStart: z.coerce.number().int().min(0).max(64).default(0),
    keepEnd: z.coerce.number().int().min(0).max(64).default(4),
    fill: z.string().min(1).max(8).default('*'),
    /** mixed into the hash, so a table of common values cannot be reversed by guessing */
    salt: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('cast'),
    column,
    to: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'json']),
    /**
     * a value that cannot be cast ("n/a" to a number):
     *   fail  the delivery fails and says which column and value (the default —
     *         a bridge set to `continue` then sets that one row aside)
     *   null  the value becomes NULL
     *   keep  the value is left as it was; whether the destination takes it is
     *         the destination's business
     * nothing is decided quietly: the other two are there to be chosen
     */
    onError: z.enum(['fail', 'null', 'keep']).default('fail'),
  }),
  z.object({
    kind: z.literal('text'),
    column,
    op: z.enum(['trim', 'lower', 'upper']),
  }),
  z.object({
    kind: z.literal('default'),
    column,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    kind: z.literal('set'),
    /** the column to write: a new one, or an existing one to replace */
    column,
    /** text with {{column}} tokens; {{$now}} and {{$table}} are available too */
    template: z.string().max(2000),
  }),
]);

export type ColumnTransform = z.infer<typeof columnTransformSchema>;

export interface ColumnTransformContext {
  table: string;
  now: string;
  /** SHA-256 hex of a string. passed in: this package has no crypto (it also runs in the browser) */
  hash(input: string): string;
  /**
   * a DELETE's row is often only its key. a computed column or a default has
   * nothing to work from there, and must not be invented for a row that is
   * being removed — but a mask on the key still applies, or the delete would
   * look for a value the destination never held.
   */
  keysOnly?: boolean;
}

type Row = Record<string, unknown>;

const TOKEN = /\{\{\s*([\w$]+)\s*\}\}/g;

/** a marker the source uses for "this column was not sent" — not a value to transform */
const isMarker = (v: unknown): boolean => typeof v === 'symbol';

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function mask(
  value: unknown,
  t: Extract<ColumnTransform, { kind: 'mask' }>,
  ctx: ColumnTransformContext,
): unknown {
  if (value === null || value === undefined) return value;
  if (t.mode === 'null') return null;
  const s = text(value);
  if (t.mode === 'hash') return ctx.hash(`${t.salt ?? ''}${s}`);
  // a fixed width: the length of a secret is information too
  if (t.mode === 'redact') return t.fill.repeat(8).slice(0, 8);
  const chars = [...s];
  const keep = t.keepStart + t.keepEnd;
  // too short to keep anything of without giving most of it away
  if (chars.length <= keep)
    return t.fill
      .repeat(Math.max(1, chars.length))
      .slice(0, Math.max(1, chars.length));
  const middle = t.fill
    .repeat(chars.length - keep)
    .slice(0, chars.length - keep);
  return (
    chars.slice(0, t.keepStart).join('') +
    middle +
    (t.keepEnd ? chars.slice(-t.keepEnd).join('') : '')
  );
}

const TRUE = new Set(['true', 't', 'yes', 'y', '1', 'on']);
const FALSE = new Set(['false', 'f', 'no', 'n', '0', 'off', '']);

function cast(
  value: unknown,
  to: Extract<ColumnTransform, { kind: 'cast' }>['to'],
): { ok: true; value: unknown } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value };
  switch (to) {
    case 'string':
      return { ok: true, value: text(value) };
    case 'number':
    case 'integer': {
      if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
      if (typeof value === 'bigint') return { ok: true, value };
      const s = typeof value === 'number' ? value : Number(text(value).trim());
      if (text(value).trim() === '' || !Number.isFinite(s))
        return { ok: false };
      return { ok: true, value: to === 'integer' ? Math.trunc(s) : s };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'number') return { ok: true, value: value !== 0 };
      const s = text(value).trim().toLowerCase();
      if (TRUE.has(s)) return { ok: true, value: true };
      if (FALSE.has(s)) return { ok: true, value: false };
      return { ok: false };
    }
    case 'date': {
      if (value instanceof Date)
        return Number.isNaN(value.getTime())
          ? { ok: false }
          : { ok: true, value: value.toISOString() };
      // seconds or milliseconds since the epoch, or anything Date understands
      const raw =
        typeof value === 'number'
          ? Math.abs(value) < 1e11
            ? value * 1000
            : value
          : text(value).trim();
      const d = new Date(raw);
      return Number.isNaN(d.getTime())
        ? { ok: false }
        : { ok: true, value: d.toISOString() };
    }
    case 'json': {
      if (typeof value !== 'string') return { ok: true, value };
      try {
        return { ok: true, value: JSON.parse(value) };
      } catch {
        return { ok: false };
      }
    }
  }
}

export interface ColumnTransformResult {
  row: Row;
  /** what was worked around, e.g. a cast that fell back to NULL. never fatal */
  warnings: string[];
  /** what must fail the delivery: a cast with `onError: fail` that could not be done */
  errors: string[];
}

/** apply `transforms`, in order, to one row. the input row is not modified */
export function applyColumnTransforms(
  row: Row,
  transforms: readonly ColumnTransform[] | undefined,
  ctx: ColumnTransformContext,
): ColumnTransformResult {
  if (!transforms || transforms.length === 0)
    return { row, warnings: [], errors: [] };
  const out: Row = { ...row };
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const t of transforms) {
    // own properties only: `constructor` and friends are not columns
    const has = Object.hasOwn(out, t.column);
    if (has && isMarker(out[t.column])) continue;

    switch (t.kind) {
      case 'mask':
        if (has) out[t.column] = mask(out[t.column], t, ctx);
        break;
      case 'text': {
        const v = out[t.column];
        if (has && typeof v === 'string') {
          out[t.column] =
            t.op === 'trim'
              ? v.trim()
              : t.op === 'lower'
                ? v.toLowerCase()
                : v.toUpperCase();
        }
        break;
      }
      case 'cast': {
        if (!has) break;
        const result = cast(out[t.column], t.to);
        if (result.ok) {
          out[t.column] = result.value;
          break;
        }
        const problem = `cast ${t.column}: ${JSON.stringify(text(out[t.column]).slice(0, 40))} is not a ${t.to}`;
        if (t.onError === 'fail') errors.push(problem);
        else {
          warnings.push(
            `${problem}${t.onError === 'null' ? '; written as NULL' : '; left as it was'}`,
          );
          if (t.onError === 'null') out[t.column] = null;
        }
        break;
      }
      case 'default':
        if (ctx.keysOnly) break;
        if (!has || out[t.column] === null || out[t.column] === undefined)
          out[t.column] = t.value;
        break;
      case 'set': {
        if (ctx.keysOnly) break;
        if (FORBIDDEN.has(t.column)) break;
        const scope: Row = { ...out, $now: ctx.now, $table: ctx.table };
        const whole = t.template.match(/^\{\{\s*([\w$]+)\s*\}\}$/);
        if (
          whole &&
          Object.hasOwn(scope, whole[1]!) &&
          !isMarker(scope[whole[1]!])
        ) {
          // a template that IS one token keeps the value's type (a copy of a column)
          out[t.column] = scope[whole[1]!];
          break;
        }
        out[t.column] = t.template.replace(TOKEN, (_m, name: string) => {
          if (Object.hasOwn(scope, name) && !isMarker(scope[name]))
            return text(scope[name]);
          warnings.push(`set ${t.column}: no column "${name}"`);
          return '';
        });
        break;
      }
    }
  }
  return { row: out, warnings, errors };
}

/** keys that would reparent or pollute the row object if assigned */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** the source columns a set of transforms reads, to know what a partial row is missing */
export function columnsRead(
  transforms: readonly ColumnTransform[] | undefined,
): Set<string> {
  const read = new Set<string>();
  for (const t of transforms ?? []) {
    if (t.kind === 'set') {
      for (const m of t.template.matchAll(TOKEN))
        if (!m[1]!.startsWith('$')) read.add(m[1]!);
    } else {
      read.add(t.column);
    }
  }
  return read;
}

/** columns a set of transforms ADDS: a `set` or `default` on a name the source does not have */
export function columnsAdded(
  transforms: readonly ColumnTransform[] | undefined,
  sourceColumns: readonly string[],
): string[] {
  const known = new Set(sourceColumns);
  const added: string[] = [];
  for (const t of transforms ?? []) {
    if ((t.kind === 'set' || t.kind === 'default') && !known.has(t.column)) {
      known.add(t.column);
      added.push(t.column);
    }
  }
  return added;
}

/** what the steps have made of a column so far: a type of their own, or a copy of another column's */
type Planned = { type: string } | { copyOf: string };

const WHOLE_TOKEN = /^\{\{\s*([\w$]+)\s*\}\}$/;

/** walk the steps in order — a copy takes what its origin is AT THAT POINT, not what it becomes later */
function plan(
  transforms: readonly ColumnTransform[] | undefined,
): Map<string, Planned> {
  const planned = new Map<string, Planned>();
  for (const t of transforms ?? []) {
    switch (t.kind) {
      case 'mask':
        if (t.mode !== 'null') planned.set(t.column, { type: 'text' });
        break;
      case 'cast':
        planned.set(t.column, { type: CAST_TYPES[t.to] });
        break;
      case 'set': {
        const origin = t.template.match(WHOLE_TOKEN)?.[1];
        if (!origin || origin.startsWith('$'))
          planned.set(t.column, { type: 'text' });
        else planned.set(t.column, planned.get(origin) ?? { copyOf: origin });
        break;
      }
      case 'default':
      case 'text':
        break;
    }
  }
  return planned;
}

/**
 * what a column's TYPE becomes once the transforms have run, or null when they
 * leave it as the source declares it (see {@link copiedColumn} for a copy).
 *
 * An auto-created target table is typed from the source's schema. A column that
 * is hashed is no longer an integer, and one that is cast to a date is no longer
 * text: created with the source's type, every row would be refused. The answer
 * is in PostgreSQL's spelling and is meant to be read by the type map with NO
 * source engine, whichever engine the rows really come from.
 */
export function transformedType(
  transforms: readonly ColumnTransform[] | undefined,
  columnName: string,
): string | null {
  const planned = plan(transforms).get(columnName);
  return planned && 'type' in planned ? planned.type : null;
}

/**
 * the source column a computed column is a plain copy of (`{{price}}`), or null.
 * such a column is typed like its origin, in the source's own spelling
 */
export function copiedColumn(
  transforms: readonly ColumnTransform[] | undefined,
  columnName: string,
): string | null {
  const planned = plan(transforms).get(columnName);
  return planned && 'copyOf' in planned ? planned.copyOf : null;
}

/**
 * true when a step can turn a value of this column into NULL. a column that is
 * NOT NULL at the source must not be created NOT NULL at the destination then
 */
export function canBecomeNull(
  transforms: readonly ColumnTransform[] | undefined,
  columnName: string,
): boolean {
  return (transforms ?? []).some(
    (t) =>
      t.column === columnName &&
      ((t.kind === 'mask' && t.mode === 'null') ||
        (t.kind === 'cast' && t.onError === 'null')),
  );
}

const CAST_TYPES: Record<
  Extract<ColumnTransform, { kind: 'cast' }>['to'],
  string
> = {
  string: 'text',
  number: 'double precision',
  integer: 'bigint',
  boolean: 'boolean',
  date: 'timestamptz',
  json: 'jsonb',
};
