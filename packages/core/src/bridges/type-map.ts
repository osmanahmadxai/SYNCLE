/**
 * Cross-engine column type translation, used when a bridge creates its
 * destination table from the source's shape.
 *
 * Two steps, kept apart on purpose:
 *
 *   parse   a source engine's native type string → a small portable model
 *   render  that model → the closest native type of the target engine
 *
 * The previous version collapsed every type into eight categories with seven
 * regular expressions tried in order, and substring matching did the rest:
 * `interval` was an INTEGER (it starts with "int"), a Mongo `objectId` was JSON
 * (it contains "object"), `timestamp with time zone` lost its zone,
 * `numeric(38,10)` became a float, and bytes became text. So matching here is
 * on the type's NAME — a whole word, looked up per engine — never on a
 * substring, and whatever is not recognised is carried as text and reported
 * rather than guessed at.
 *
 * Whenever the target cannot hold everything the source type can, the render
 * step says so. A translation that silently narrows is how a sync "works" in a
 * demo and corrupts a ledger in production.
 */
import type { DatabaseEngine } from '../adapters/types';

export type PortableKind =
  | 'boolean'
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'double'
  | 'varchar'
  | 'char'
  | 'text'
  | 'bytes'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  | 'interval'
  | 'json'
  | 'uuid'
  | 'array'
  | 'objectid'
  /** a type with no portable meaning (enum, geometry, …): carried as text */
  | 'opaque';

export interface PortableType {
  kind: PortableKind;
  /** varchar / char length, in characters */
  length?: number;
  /** decimal precision and scale; absent = unconstrained */
  precision?: number;
  scale?: number;
  /** integer kinds only */
  unsigned?: boolean;
  /** array element, when the source declares one */
  element?: PortableType;
  /** the native type exactly as the source reported it */
  native: string;
  /** set while parsing when something was already lost or assumed */
  note?: string;
}

export interface ColumnTypePlan {
  /** native column type for the target engine */
  type: string;
  /** what the target column cannot preserve, in plain words; empty = faithful */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* parse                                                                      */
/* -------------------------------------------------------------------------- */

interface Decl {
  /** lower-cased type name with modifiers and array brackets removed */
  name: string;
  /** numbers inside the first parentheses, e.g. [38, 10] for numeric(38,10) */
  args: number[];
  unsigned: boolean;
  /** `[]` suffixes, or a Postgres `_name` array type */
  arrayDepth: number;
}

function parseDecl(raw: string): Decl {
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');

  let arrayDepth = 0;
  while (s.endsWith('[]')) {
    arrayDepth++;
    s = s.slice(0, -2).trim();
  }

  const args: number[] = [];
  const paren = /\(([^)]*)\)/.exec(s);
  if (paren) {
    for (const part of paren[1]!.split(',')) {
      const n = Number(part.trim());
      if (part.trim() !== '' && Number.isFinite(n)) args.push(n);
    }
    // the modifier can sit mid-name: `timestamp(3) with time zone`
    s = (s.slice(0, paren.index) + s.slice(paren.index + paren[0].length))
      .replace(/\s+/g, ' ')
      .trim();
  }

  let unsigned = false;
  if (/\bunsigned\b/.test(s)) {
    unsigned = true;
    s = s.replace(/\bunsigned\b/, '');
  }
  s = s
    .replace(/\bzerofill\b/, '')
    .replace(/\bsigned\b/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Postgres spells an array's type as its element's name with a leading `_`
  if (arrayDepth === 0 && /^_[a-z]/.test(s)) {
    arrayDepth = 1;
    s = s.slice(1);
  }
  return { name: s, args, unsigned, arrayDepth };
}

type Shape = Omit<PortableType, 'native'>;
type Rule = Shape | ((d: Decl) => Shape);

const decimal = (d: Decl): Shape =>
  d.args.length > 0
    ? { kind: 'decimal', precision: d.args[0], scale: d.args[1] ?? 0 }
    : { kind: 'decimal' };
const varchar = (d: Decl): Shape =>
  d.args[0] ? { kind: 'varchar', length: d.args[0] } : { kind: 'text' };
const char = (d: Decl): Shape => ({ kind: 'char', length: d.args[0] ?? 1 });
const int =
  (kind: 'smallint' | 'integer' | 'bigint') =>
  (d: Decl): Shape => ({ kind, ...(d.unsigned ? { unsigned: true } : {}) });
const opaque = (what: string): Shape => ({
  kind: 'opaque',
  note: `${what} has no equivalent in other engines; it is stored as text`,
});

/** names every SQL engine here agrees on */
const COMMON: Record<string, Rule> = {
  boolean: { kind: 'boolean' },
  bool: { kind: 'boolean' },
  smallint: int('smallint'),
  integer: int('integer'),
  int: int('integer'),
  bigint: int('bigint'),
  numeric: decimal,
  decimal,
  dec: decimal,
  real: { kind: 'float' },
  'double precision': { kind: 'double' },
  double: { kind: 'double' },
  float: { kind: 'double' },
  varchar,
  'character varying': varchar,
  char,
  character: char,
  text: { kind: 'text' },
  date: { kind: 'date' },
  time: { kind: 'time' },
  // a bare `timestamp`/`datetime` is a wall-clock reading in every SQL engine
  // here; it is also what a runtime Date is inferred as when no schema exists
  timestamp: { kind: 'timestamp' },
  datetime: { kind: 'timestamp' },
  json: { kind: 'json' },
  uuid: { kind: 'uuid' },
};

const POSTGRES: Record<string, Rule> = {
  int2: int('smallint'),
  int4: int('integer'),
  int8: int('bigint'),
  smallserial: { kind: 'smallint' },
  serial: { kind: 'integer' },
  bigserial: { kind: 'bigint' },
  oid: { kind: 'bigint' },
  float4: { kind: 'float' },
  float8: { kind: 'double' },
  // `float(p)`: p ≤ 24 is single precision
  float: (d) => ({ kind: d.args[0] && d.args[0] <= 24 ? 'float' : 'double' }),
  bpchar: char,
  name: { kind: 'varchar', length: 63 },
  citext: { kind: 'text' },
  bytea: { kind: 'bytes' },
  time: { kind: 'time' },
  'time without time zone': { kind: 'time' },
  timetz: {
    kind: 'time',
    note: 'the time zone offset of a "time with time zone" value is not carried',
  },
  'time with time zone': {
    kind: 'time',
    note: 'the time zone offset of a "time with time zone" value is not carried',
  },
  timestamp: { kind: 'timestamp' },
  'timestamp without time zone': { kind: 'timestamp' },
  timestamptz: { kind: 'timestamptz' },
  'timestamp with time zone': { kind: 'timestamptz' },
  interval: { kind: 'interval' },
  jsonb: { kind: 'json' },
  xml: { kind: 'text' },
  money: opaque('A money value (formatted with a currency symbol)'),
  // information_schema's spelling when the precise type is not available
  array: { kind: 'array' },
  'user-defined': opaque('A user-defined type'),
};

const MYSQL: Record<string, Rule> = {
  // the only boolean MySQL has: BOOL is an alias for it
  tinyint: (d) =>
    d.args[0] === 1 && !d.unsigned
      ? { kind: 'boolean' }
      : { kind: 'smallint', ...(d.unsigned ? { unsigned: true } : {}) },
  mediumint: int('integer'),
  fixed: decimal,
  // `float(p)` with p > 24 is a double
  float: (d) => ({ kind: d.args[0] && d.args[0] > 24 ? 'double' : 'float' }),
  year: { kind: 'smallint' },
  bit: (d) =>
    (d.args[0] ?? 1) === 1
      ? { kind: 'boolean' }
      : { kind: 'bytes', note: 'a multi-bit value is carried as raw bytes' },
  tinytext: { kind: 'text' },
  mediumtext: { kind: 'text' },
  longtext: { kind: 'text' },
  binary: { kind: 'bytes' },
  varbinary: { kind: 'bytes' },
  tinyblob: { kind: 'bytes' },
  blob: { kind: 'bytes' },
  mediumblob: { kind: 'bytes' },
  longblob: { kind: 'bytes' },
  time: { kind: 'time' },
  datetime: { kind: 'timestamp' },
  // a MySQL TIMESTAMP is read back as a wall-clock string in the session's
  // zone; treating it as an instant would shift it on the way into another
  // engine, so it keeps the literal value it was read with
  timestamp: { kind: 'timestamp' },
  enum: opaque('An ENUM'),
  set: opaque('A SET'),
};

const SQLITE: Record<string, Rule> = {
  // SQLite integers are 64-bit whatever the declared name says
  int: { kind: 'bigint' },
  integer: { kind: 'bigint' },
  smallint: { kind: 'bigint' },
  tinyint: { kind: 'bigint' },
  mediumint: { kind: 'bigint' },
  int2: { kind: 'bigint' },
  int8: { kind: 'bigint' },
  'unsigned big int': { kind: 'bigint' },
  'big int': { kind: 'bigint' },
  clob: { kind: 'text' },
  nchar: char,
  nvarchar: varchar,
  'native character': char,
  'varying character': varchar,
  blob: { kind: 'bytes' },
  datetime: { kind: 'timestamp' },
  timestamp: { kind: 'timestamp' },
  time: { kind: 'time' },
  float: { kind: 'double' },
  // no declared type at all: the column holds whatever was put in it
  '': {
    kind: 'text',
    note: 'the SQLite column has no declared type, so it is treated as text',
  },
};

/** MongoDB has no schema: these come from sampling the collection's documents */
const MONGODB: Record<string, Rule> = {
  objectid: { kind: 'objectid' },
  string: { kind: 'text' },
  number: { kind: 'double' },
  int: { kind: 'integer' },
  long: { kind: 'bigint' },
  decimal128: { kind: 'decimal' },
  boolean: { kind: 'boolean' },
  // a BSON date is an instant (UTC milliseconds), not a wall-clock reading
  date: { kind: 'timestamptz' },
  array: { kind: 'json' },
  object: { kind: 'json' },
  binary: { kind: 'bytes' },
  uuid: { kind: 'uuid' },
  mixed: {
    kind: 'text',
    note: 'this field holds values of different types, so it is stored as text',
  },
  null: {
    kind: 'text',
    note: 'only null values were seen for this field, so it is treated as text',
  },
  undefined: {
    kind: 'text',
    note: 'no value was seen for this field, so it is treated as text',
  },
};

const REDIS: Record<string, Rule> = {
  string: { kind: 'text' },
};

const BY_ENGINE: Partial<Record<DatabaseEngine, Record<string, Rule>>> = {
  postgres: POSTGRES,
  mysql: MYSQL,
  sqlite: SQLITE,
  mongodb: MONGODB,
  redis: REDIS,
};

function lookup(
  name: string,
  engine: DatabaseEngine | undefined,
): Rule | undefined {
  const own = engine ? BY_ENGINE[engine]?.[name] : undefined;
  if (own) return own;
  // an engine that does not define the name itself may still share it
  if (COMMON[name]) return COMMON[name];
  if (engine) return undefined;
  // source engine unknown (a query source, or inference): any engine's reading
  // of the name is better than none, relational engines first
  for (const table of [POSTGRES, MYSQL, SQLITE, MONGODB]) {
    if (table[name]) return table[name];
  }
  return undefined;
}

/**
 * read a source column's native type. `engine` is the source's engine when
 * known — several names mean different things in different engines
 * (`timestamp`, `float`, `int`), so it matters.
 */
export function parseColumnType(
  dataType: string | null | undefined,
  engine?: DatabaseEngine,
): PortableType {
  const native = (dataType ?? '').trim();
  const decl = parseDecl(native);

  const resolve = (d: Decl): Shape => {
    const rule = lookup(d.name, engine);
    if (rule) return typeof rule === 'function' ? rule(d) : rule;
    return {
      kind: 'opaque',
      note: native
        ? `"${native}" is not a type Syncle can translate; it is stored as text`
        : 'the column type is unknown; it is stored as text',
    };
  };

  if (decl.arrayDepth > 0) {
    const element = resolve({ ...decl, arrayDepth: 0 });
    // multi-dimensional and untranslatable element types travel as JSON
    const simple = decl.arrayDepth === 1 && element.kind !== 'opaque';
    return simple
      ? { kind: 'array', element: { ...element, native: decl.name }, native }
      : { kind: 'array', native };
  }
  return { ...resolve(decl), native };
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

const MYSQL_MAX_PRECISION = 65;
const MYSQL_MAX_SCALE = 30;
/** longest VARCHAR that is safe under utf8mb4 (65,535 bytes / 4) */
const MYSQL_MAX_VARCHAR = 16_383;
/** InnoDB indexes at most 3,072 bytes, i.e. 768 utf8mb4 characters */
const MYSQL_MAX_KEY_CHARS = 768;
const POSTGRES_MAX_PRECISION = 1000;
/** significant digits a SQLite REAL (an IEEE double) holds without loss */
const SQLITE_EXACT_DIGITS = 15;

interface Rendered {
  type: string;
  warnings: string[];
}

const ok = (type: string): Rendered => ({ type, warnings: [] });
const lossy = (type: string, ...warnings: string[]): Rendered => ({
  type,
  warnings,
});

function renderPostgres(t: PortableType): Rendered {
  switch (t.kind) {
    case 'boolean':
      return ok('BOOLEAN');
    case 'smallint':
      // no unsigned integers in Postgres: step up to the next width
      return ok(t.unsigned ? 'INTEGER' : 'SMALLINT');
    case 'integer':
      return ok(t.unsigned ? 'BIGINT' : 'INTEGER');
    case 'bigint':
      return ok(t.unsigned ? 'NUMERIC(20,0)' : 'BIGINT');
    case 'decimal':
      if (t.precision === undefined) return ok('NUMERIC');
      return t.precision <= POSTGRES_MAX_PRECISION
        ? ok(`NUMERIC(${t.precision},${t.scale ?? 0})`)
        : ok('NUMERIC');
    case 'float':
      return ok('REAL');
    case 'double':
      return ok('DOUBLE PRECISION');
    case 'varchar':
      return ok(t.length ? `VARCHAR(${t.length})` : 'TEXT');
    case 'char':
      return ok(`CHAR(${t.length ?? 1})`);
    case 'text':
    case 'opaque':
      return ok('TEXT');
    case 'bytes':
      return ok('BYTEA');
    case 'date':
      return ok('DATE');
    case 'time':
      return ok('TIME');
    case 'timestamp':
      return ok('TIMESTAMP');
    case 'timestamptz':
      return ok('TIMESTAMPTZ');
    case 'interval':
      return ok('INTERVAL');
    case 'json':
      return ok('JSONB');
    case 'uuid':
      return ok('UUID');
    case 'objectid':
      return ok('VARCHAR(24)');
    case 'array': {
      if (!t.element) return ok('JSONB');
      const el = renderPostgres(t.element);
      return { type: `${el.type}[]`, warnings: el.warnings };
    }
  }
}

function renderMysql(t: PortableType, isKey: boolean): Rendered {
  const u = t.unsigned ? ' UNSIGNED' : '';
  switch (t.kind) {
    case 'boolean':
      return ok('TINYINT(1)');
    case 'smallint':
      return ok(`SMALLINT${u}`);
    case 'integer':
      return ok(`INT${u}`);
    case 'bigint':
      return ok(`BIGINT${u}`);
    case 'decimal': {
      if (t.precision === undefined) {
        return lossy(
          `DECIMAL(${MYSQL_MAX_PRECISION},${MYSQL_MAX_SCALE})`,
          `the source number has no fixed precision; MySQL needs one, so it is DECIMAL(${MYSQL_MAX_PRECISION},${MYSQL_MAX_SCALE}) — values with more than ${MYSQL_MAX_PRECISION - MYSQL_MAX_SCALE} digits before the decimal point will be rejected`,
        );
      }
      const scale = Math.min(t.scale ?? 0, MYSQL_MAX_SCALE);
      const precision = Math.min(t.precision, MYSQL_MAX_PRECISION);
      return precision === t.precision && scale === (t.scale ?? 0)
        ? ok(`DECIMAL(${precision},${scale})`)
        : lossy(
            `DECIMAL(${precision},${scale})`,
            `MySQL decimals stop at ${MYSQL_MAX_PRECISION} digits (${MYSQL_MAX_SCALE} after the point); the source allows (${t.precision},${t.scale ?? 0}), so larger values will be rejected`,
          );
    }
    case 'float':
      return ok('FLOAT');
    case 'double':
      return ok('DOUBLE');
    case 'varchar': {
      const n = t.length ?? 0;
      if (isKey) {
        return n > 0 && n <= MYSQL_MAX_KEY_CHARS
          ? ok(`VARCHAR(${n})`)
          : keyText();
      }
      return n > 0 && n <= MYSQL_MAX_VARCHAR
        ? ok(`VARCHAR(${n})`)
        : ok('LONGTEXT');
    }
    case 'char':
      return (t.length ?? 1) <= 255
        ? ok(`CHAR(${t.length ?? 1})`)
        : isKey
          ? keyText()
          : ok('LONGTEXT');
    case 'text':
    case 'opaque':
      // TEXT stops at 64 KB; a Postgres text column does not
      return isKey ? keyText() : ok('LONGTEXT');
    case 'bytes':
      return isKey
        ? lossy(
            'VARBINARY(255)',
            'a binary key is limited to 255 bytes in MySQL; longer values will be rejected',
          )
        : ok('LONGBLOB');
    case 'date':
      return ok('DATE');
    case 'time':
      return ok('TIME(6)');
    case 'timestamp':
      return ok('DATETIME(6)');
    case 'timestamptz':
      return lossy(
        'DATETIME(6)',
        'MySQL has no time-zone-aware timestamp; values are stored as UTC wall-clock times',
      );
    case 'interval':
      return lossy(
        'VARCHAR(64)',
        'MySQL has no interval type; the value is stored as text',
      );
    case 'json':
    case 'array':
      return isKey
        ? lossy(
            'VARCHAR(255)',
            'a JSON value cannot be a MySQL key; it is stored as text, limited to 255 characters',
          )
        : ok('JSON');
    case 'uuid':
      return ok('CHAR(36)');
    case 'objectid':
      return ok('CHAR(24)');
  }

  function keyText(): Rendered {
    return lossy(
      'VARCHAR(255)',
      'MySQL cannot index unbounded text, so this key column is VARCHAR(255); longer values will be rejected',
    );
  }
}

function renderSqlite(t: PortableType): Rendered {
  switch (t.kind) {
    case 'boolean':
    case 'smallint':
    case 'integer':
    case 'bigint':
      return t.kind === 'bigint' && t.unsigned
        ? lossy(
            'TEXT',
            'SQLite integers are signed 64-bit, so an unsigned 64-bit column is stored as text to keep values above 9,223,372,036,854,775,807 exact',
          )
        : ok('INTEGER');
    case 'decimal':
      // SQLite has no exact decimal. a column with NUMERIC affinity turns any
      // numeric-looking text into a REAL, which keeps 15 significant digits —
      // measured, not assumed: 1234567890123456789012345678.0123456789 came
      // back as 1.2345678901234569e+27. up to 15 digits that is lossless;
      // beyond it, only TEXT affinity leaves the digits alone
      return t.precision !== undefined && t.precision <= SQLITE_EXACT_DIGITS
        ? ok(`DECIMAL(${t.precision},${t.scale ?? 0})`)
        : lossy(
            'TEXT',
            'SQLite has no exact decimal type; the number is stored as text so that every digit is kept (it sorts and compares as text there)',
          );
    case 'float':
    case 'double':
      return ok('REAL');
    case 'bytes':
      return ok('BLOB');
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestamptz':
    case 'interval':
    case 'varchar':
    case 'char':
    case 'text':
    case 'opaque':
    case 'json':
    case 'array':
    case 'uuid':
    case 'objectid':
      return ok('TEXT');
  }
}

/**
 * can the source's own type be used as it stands? only between two instances
 * of the same engine, and only for a type that exists everywhere (an enum or a
 * domain lives in ONE database) and that the engine can key on.
 */
function reusable(
  t: PortableType,
  engine: DatabaseEngine,
  isKey: boolean,
): boolean {
  if (t.kind === 'opaque') return false;
  if (!/^[A-Za-z0-9_ (),]+(\[\])*$/.test(t.native)) return false;
  // MySQL cannot index unbounded text or blobs
  if (
    engine === 'mysql' &&
    isKey &&
    ['text', 'bytes', 'json', 'array'].includes(t.kind)
  ) {
    return false;
  }
  if (engine === 'mysql' && isKey && t.kind === 'varchar') {
    return (t.length ?? 0) > 0 && (t.length ?? 0) <= MYSQL_MAX_KEY_CHARS;
  }
  // information_schema's bare "ARRAY" names no element type
  if (t.kind === 'array' && !t.element) return false;
  return true;
}

/**
 * the target column type for a source column, and what — if anything — the
 * target cannot preserve.
 */
export function translateColumnType(
  dataType: string | null | undefined,
  opts: {
    source?: DatabaseEngine;
    target: DatabaseEngine;
    isKey?: boolean;
  },
): ColumnTypePlan {
  const isKey = opts.isKey ?? false;
  const parsed = parseColumnType(dataType, opts.source);
  const notes = parsed.note ? [parsed.note] : [];

  if (
    opts.source &&
    opts.source === opts.target &&
    reusable(parsed, opts.target, isKey)
  ) {
    // the very same type on the other side: nothing is translated, so nothing
    // is lost (the parse notes describe what OTHER engines would drop)
    return { type: parsed.native, warnings: [] };
  }

  let rendered: Rendered;
  switch (opts.target) {
    case 'postgres':
      rendered = renderPostgres(parsed);
      break;
    case 'mysql':
      rendered = renderMysql(parsed, isKey);
      break;
    case 'sqlite':
      rendered = renderSqlite(parsed);
      break;
    default:
      // document and key-value stores have no column types to declare; the
      // portable kind is informational only
      rendered = ok(parsed.kind);
  }
  return { type: rendered.type, warnings: [...notes, ...rendered.warnings] };
}
