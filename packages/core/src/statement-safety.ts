/**
 * what a statement typed into the query editor would DO, as far as its text can
 * say: only read, write, or destroy.
 *
 * Two things use it, and neither is a security boundary:
 *
 *  - a connection marked READ-ONLY runs a statement only when every part of it
 *    is recognisably a read. the rule is an allowlist — what is not known to be
 *    a read is not run — so it errs on the side of refusing. (what a function
 *    called from a SELECT does is beyond any reading of the text: for a hard
 *    guarantee, connect with a database role that cannot write.)
 *  - the editor asks before it runs something destructive: a DROP, a TRUNCATE,
 *    a DELETE or UPDATE with no WHERE, a FLUSHALL.
 *
 * browser-safe: no parser, no dependency. comments and string literals are
 * masked first, so a keyword or a semicolon inside one counts for nothing.
 */
import type { DatabaseEngine } from './adapters/types';

export type StatementRisk = 'read' | 'write' | 'destructive';

export interface StatementAssessment {
  /** the worst of its statements */
  risk: StatementRisk;
  /** how many statements the text holds */
  statements: number;
  /** what makes it more than a read, in a few words each: `DROP TABLE`, `DELETE without WHERE` */
  reasons: string[];
}

const WORSE: Record<StatementRisk, number> = {
  read: 0,
  write: 1,
  destructive: 2,
};

/* -------------------------------------------------------------------------- */
/* SQL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * the text with every comment removed and every quoted thing — string, quoted
 * identifier, PostgreSQL dollar-quoted body — replaced by a placeholder of the
 * same kind, so that what is left is only the statement's own words
 */
export function maskSql(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      // MySQL's line comment. (a `#` elsewhere — a PostgreSQL operator — is rare
      // enough in a statement's own words that reading on from the next line is
      // the safer mistake)
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < n) {
        if (text[i] === '\\' && ch !== '"') {
          i += 2;
          continue;
        }
        if (text[i] === ch) {
          if (text[i + 1] === ch) {
            i += 2; // a doubled quote is the quote itself
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      out += ch === "'" ? " '' " : ' "x" ';
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        out += " '' ";
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const word = (s: string, w: string): boolean =>
  new RegExp(`\\b${w}\\b`).test(s);

function assessSqlStatement(statement: string): {
  risk: StatementRisk;
  reason?: string;
} {
  const s = statement.replace(/\s+/g, ' ').trim().toUpperCase();
  const first = /^[A-Z]+/.exec(s)?.[0] ?? '';
  const writesInside = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'TRUNCATE',
    'DROP',
    'ALTER',
    'CREATE',
  ].find((w) => word(s, w));

  switch (first) {
    case 'SELECT':
    case 'TABLE':
    case 'VALUES':
      // SELECT … INTO new_table creates a table (PostgreSQL); INTO OUTFILE writes a file (MySQL)
      if (/\bINTO\b/.test(s)) return { risk: 'write', reason: 'SELECT … INTO' };
      return { risk: 'read' };
    case 'WITH':
      // a CTE can carry the write: WITH gone AS (DELETE FROM t RETURNING *) SELECT …
      if (writesInside)
        return assessSqlStatement(
          statement.slice(statement.toUpperCase().indexOf(writesInside)),
        );
      if (/\bINTO\b/.test(s)) return { risk: 'write', reason: 'SELECT … INTO' };
      return { risk: 'read' };
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
      return { risk: 'read' };
    case 'EXPLAIN':
      // EXPLAIN ANALYZE runs the statement it explains
      if (word(s, 'ANALYZE') && writesInside)
        return { risk: 'write', reason: `EXPLAIN ANALYZE ${writesInside}` };
      return { risk: 'read' };
    case 'PRAGMA':
      // `PRAGMA name` reads; `PRAGMA name = value` and `PRAGMA name(value)` set
      return /[=(]/.test(s)
        ? { risk: 'write', reason: 'PRAGMA that sets a value' }
        : { risk: 'read' };
    case 'DROP':
      return {
        risk: 'destructive',
        reason: s.split(' ').slice(0, 2).join(' '),
      };
    case 'TRUNCATE':
      return { risk: 'destructive', reason: 'TRUNCATE' };
    case 'DELETE':
    case 'UPDATE':
      return word(s, 'WHERE')
        ? { risk: 'write', reason: first }
        : { risk: 'destructive', reason: `${first} without WHERE` };
    case 'ALTER':
      return word(s, 'DROP')
        ? { risk: 'destructive', reason: 'ALTER … DROP' }
        : { risk: 'write', reason: s.split(' ').slice(0, 2).join(' ') };
    default:
      // INSERT, CREATE, MERGE, COPY, GRANT, CALL, DO, SET, BEGIN, COMMIT … and
      // whatever is not known: not a read
      return { risk: 'write', reason: first || 'an empty statement' };
  }
}

function assessSql(text: string): StatementAssessment {
  const statements = maskSql(text)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  let risk: StatementRisk = 'read';
  const reasons: string[] = [];
  for (const statement of statements) {
    const a = assessSqlStatement(statement);
    if (WORSE[a.risk] > WORSE[risk]) risk = a.risk;
    if (a.reason && a.risk !== 'read') reasons.push(a.reason);
  }
  return { risk, statements: statements.length, reasons };
}

/* -------------------------------------------------------------------------- */
/* Redis                                                                      */
/* -------------------------------------------------------------------------- */

/** commands that only read. what is not here is not run on a read-only connection */
const REDIS_READS = new Set([
  'GET',
  'MGET',
  'STRLEN',
  'GETRANGE',
  'SUBSTR',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'EXPIRETIME',
  'PEXPIRETIME',
  'KEYS',
  'SCAN',
  'RANDOMKEY',
  'DBSIZE',
  'INFO',
  'PING',
  'ECHO',
  'TIME',
  'LASTSAVE',
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'HSTRLEN',
  'HSCAN',
  'HRANDFIELD',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'LPOS',
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'SMISMEMBER',
  'SRANDMEMBER',
  'SSCAN',
  'SINTER',
  'SUNION',
  'SDIFF',
  'SINTERCARD',
  'ZRANGE',
  'ZREVRANGE',
  'ZRANGEBYSCORE',
  'ZREVRANGEBYSCORE',
  'ZRANGEBYLEX',
  'ZCARD',
  'ZCOUNT',
  'ZSCORE',
  'ZMSCORE',
  'ZRANK',
  'ZREVRANK',
  'ZSCAN',
  'ZRANDMEMBER',
  'ZLEXCOUNT',
  'XRANGE',
  'XREVRANGE',
  'XLEN',
  'XINFO',
  'XPENDING',
  'BITCOUNT',
  'BITPOS',
  'GETBIT',
  'PFCOUNT',
  'GEOPOS',
  'GEODIST',
  'GEOHASH',
  'GEOSEARCH',
  'OBJECT',
  'MEMORY',
  'DUMP',
  'TOUCH',
]);
const REDIS_DESTRUCTIVE = new Set([
  'FLUSHALL',
  'FLUSHDB',
  'SHUTDOWN',
  'SWAPDB',
  'DEBUG',
  'MIGRATE',
  'RESTORE',
]);

function assessRedis(text: string): StatementAssessment {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  let risk: StatementRisk = 'read';
  const reasons: string[] = [];
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    const command = tokens[0]!.toUpperCase();
    let r: StatementRisk;
    if (REDIS_DESTRUCTIVE.has(command)) r = 'destructive';
    // CONFIG GET reads; CONFIG SET / REWRITE / RESETSTAT do not
    else if (command === 'CONFIG')
      r = tokens[1]?.toUpperCase() === 'GET' ? 'read' : 'destructive';
    else r = REDIS_READS.has(command) ? 'read' : 'write';
    if (WORSE[r] > WORSE[risk]) risk = r;
    if (r !== 'read') reasons.push(command);
  }
  return { risk, statements: lines.length, reasons };
}

/* -------------------------------------------------------------------------- */
/* MongoDB (the editor's JSON command document)                               */
/* -------------------------------------------------------------------------- */

function assessMongo(text: string): StatementAssessment {
  let spec: Record<string, unknown>;
  try {
    // the editor's starter text carries `//` comments
    spec = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as Record<
      string,
      unknown
    >;
  } catch {
    // not something that could be run at all; certainly not something to vouch for
    return {
      risk: 'write',
      statements: 1,
      reasons: ['not a JSON command document'],
    };
  }
  const stages = Array.isArray(spec.aggregate)
    ? (spec.aggregate as Array<Record<string, unknown>>)
    : [];
  // $out REPLACES a collection with the pipeline's result; $merge writes into one
  if (stages.some((s) => s && typeof s === 'object' && '$out' in s))
    return { risk: 'destructive', statements: 1, reasons: ['$out'] };
  if (stages.some((s) => s && typeof s === 'object' && '$merge' in s))
    return { risk: 'write', statements: 1, reasons: ['$merge'] };
  const reads =
    'find' in spec ||
    'aggregate' in spec ||
    'countDocuments' in spec ||
    'distinct' in spec;
  return reads ||
    Object.keys(spec).every((k) =>
      ['collection', 'sort', 'limit', 'skip', 'projection'].includes(k),
    )
    ? { risk: 'read', statements: 1, reasons: [] }
    : {
        risk: 'write',
        statements: 1,
        reasons: [
          Object.keys(spec).find((k) => k !== 'collection') ??
            'unknown command',
        ],
      };
}

export function assessStatement(
  engine: DatabaseEngine,
  text: string,
): StatementAssessment {
  if (engine === 'redis') return assessRedis(text);
  if (engine === 'mongodb') return assessMongo(text);
  return assessSql(text);
}
