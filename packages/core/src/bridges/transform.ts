/**
 * payload templating for bridges. pure and framework-agnostic so it
 * runs identically in the API runner and the web preview, and is trivially
 * unit-testable.
 *
 * a template is a JSON document with `{{token}}` placeholders. we parse it to a
 * JSON tree once and substitute tokens at the node level:
 *
 *   - a string node that is entirely one token (`"{{email}}"`) is replaced by
 *     the token's real value, keeping its type (number, object, null, …)
 *   - a string node with tokens mixed into other text (`"id-{{id}}"`) has each
 *     token stringified and interpolated, staying a string
 *
 * since substitution happens on the parsed tree (never by splicing raw values
 * into template text and re-parsing), a value with quotes or newlines can't
 * break out of its position or produce invalid JSON. that's the key difference
 * from naive string interpolation, which is an injection bug.
 *
 * tokens:
 *   {{column}}  a column value from the source row (original, pre-rename)
 *   {{$row}}    the projected row object (after `fields` filter + `rename`)
 *   {{$table}}  the source table/relation name
 *   {{$now}}    ISO timestamp captured once per delivery
 *   {{$index}}  0-based row index across the whole job
 */
import { BadRequestError } from '../errors';

export interface TransformContext {
  /** resolves `{{$table}}` */
  table: string;
  /** resolves `{{$now}}`, captured once per delivery */
  now: string;
  /** resolves `{{$index}}`, 0-based row index across the job */
  index: number;
}

export interface TransformConfig {
  /** JSON template with `{{token}}` placeholders */
  template: string;
  /** whitelist of source columns kept in `{{$row}}` (default: all) */
  fields?: string[];
  /** map of source column → output key, applied to `{{$row}}` */
  rename?: Record<string, string>;
  /** when set, the final body is wrapped as `{ [wrapKey]: body }` */
  wrapKey?: string;
}

export interface RenderResult {
  /** the request body value (caller is responsible for JSON.stringify) */
  body: unknown;
  /** tokens that didn't resolve, surfaced for preview, never fatal */
  warnings: string[];
}

type Row = Record<string, unknown>;

const WHOLE_TOKEN = /^\{\{\s*([\w$]+)\s*\}\}$/;
const ANY_TOKEN = /\{\{\s*([\w$]+)\s*\}\}/g;

/** apply the `fields` whitelist and `rename` map to produce `{{$row}}` */
function projectRow(row: Row, cfg: TransformConfig): Row {
  let entries = Object.entries(row);
  if (cfg.fields && cfg.fields.length > 0) {
    const keep = new Set(cfg.fields);
    entries = entries.filter(([k]) => keep.has(k));
  }
  if (cfg.rename) {
    entries = entries.map(([k, v]) => [cfg.rename![k] ?? k, v]);
  }
  return Object.fromEntries(entries);
}

function buildScope(row: Row, cfg: TransformConfig, ctx: TransformContext): Row {
  return {
    ...row,
    $row: projectRow(row, cfg),
    $table: ctx.table,
    $now: ctx.now,
    $index: ctx.index,
  };
}

/** coerce a resolved value to its string form for in-string interpolation */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** keys that would reparent or pollute the output object if assigned */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * recursively substitute tokens in a parsed JSON node. token lookups use
 * `Object.hasOwn` (not `in`) so inherited names like `constructor` can't leak
 * prototype internals into the payload.
 */
function substitute(node: unknown, scope: Row, warnings: Set<string>): unknown {
  if (typeof node === 'string') {
    const whole = node.match(WHOLE_TOKEN);
    if (whole) {
      const name = whole[1]!;
      if (Object.hasOwn(scope, name)) return scope[name];
      warnings.add(name);
      return null;
    }
    return node.replace(ANY_TOKEN, (_m, name: string) => {
      if (Object.hasOwn(scope, name)) return stringify(scope[name]);
      warnings.add(name);
      return '';
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => substitute(item, scope, warnings));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // keys are interpolated (string-only), values are fully substituted
      const renderedKey = key.replace(ANY_TOKEN, (_m, name: string) => {
        if (Object.hasOwn(scope, name)) return stringify(scope[name]);
        warnings.add(name);
        return '';
      });
      // a rendered "__proto__" would reparent `out` instead of adding a
      // property — drop such keys entirely
      if (FORBIDDEN_KEYS.has(renderedKey)) continue;
      out[renderedKey] = substitute(value, scope, warnings);
    }
    return out;
  }
  return node;
}

/**
 * parse a template once, surfacing a clear error on malformed JSON. a template
 * that is a single bare token (e.g. the default `{{$row}}`) is returned as that
 * token string so `substitute` resolves it to a typed value, it need not be
 * quoted JSON.
 */
function parseTemplate(template: string): unknown {
  const trimmed = template.trim();
  if (WHOLE_TOKEN.test(trimmed)) return trimmed;
  try {
    return JSON.parse(template);
  } catch (err) {
    throw new BadRequestError(
      `Payload template is not valid JSON: ${(err as Error).message}`,
    );
  }
}

/** render a single row to a request body */
export function renderRow(
  row: Row,
  cfg: TransformConfig,
  ctx: TransformContext,
): RenderResult {
  const warnings = new Set<string>();
  const tree = parseTemplate(cfg.template);
  const rendered = substitute(tree, buildScope(row, cfg, ctx), warnings);
  return { body: wrap(rendered, cfg), warnings: [...warnings] };
}

/**
 * render N rows into a single array body (used when `batchSize > 1`). each row
 * gets its own `{{$index}}`, the optional `wrapKey` wraps the array.
 */
export function renderBatch(
  rows: Row[],
  cfg: TransformConfig,
  startIndex: number,
  ctx: Omit<TransformContext, 'index'>,
): RenderResult {
  const warnings = new Set<string>();
  const tree = parseTemplate(cfg.template);
  const items = rows.map((row, i) => {
    const scope = buildScope(row, cfg, { ...ctx, index: startIndex + i });
    return substitute(tree, scope, warnings);
  });
  return { body: wrap(items, cfg), warnings: [...warnings] };
}

function wrap(body: unknown, cfg: TransformConfig): unknown {
  return cfg.wrapKey ? { [cfg.wrapKey]: body } : body;
}
