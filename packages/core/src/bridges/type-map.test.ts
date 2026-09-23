/**
 * The cross-engine type map, exercised type by type and engine pair by engine
 * pair. Every case in "regressions" is a translation the previous regex-based
 * version got wrong, with the wrong answer it gave.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseEngine } from '../adapters/types';
import { planTargetTable } from './bridge';
import { parseColumnType, translateColumnType } from './type-map';

const to = (
  dataType: string,
  source: DatabaseEngine | undefined,
  target: DatabaseEngine,
  isKey = false,
): string => translateColumnType(dataType, { source, target, isKey }).type;

const warns = (
  dataType: string,
  source: DatabaseEngine | undefined,
  target: DatabaseEngine,
  isKey = false,
): string[] =>
  translateColumnType(dataType, { source, target, isKey }).warnings;

describe('regressions: what substring matching used to get wrong', () => {
  it('an interval is not an INTEGER just because it starts with "int"', () => {
    expect(parseColumnType('interval', 'postgres').kind).toBe('interval');
    expect(to('interval', 'postgres', 'postgres')).toBe('interval');
    expect(to('interval', 'postgres', 'mysql')).toBe('VARCHAR(64)');
    expect(to('interval', 'postgres', 'sqlite')).toBe('TEXT');
  });

  it('a Mongo objectId is not JSON just because it contains "object"', () => {
    expect(parseColumnType('objectId', 'mongodb').kind).toBe('objectid');
    // and as the _id key it must be something a primary key can sit on
    expect(to('objectId', 'mongodb', 'postgres', true)).toBe('VARCHAR(24)');
    expect(to('objectId', 'mongodb', 'mysql', true)).toBe('CHAR(24)');
    expect(to('objectId', 'mongodb', 'sqlite', true)).toBe('TEXT');
  });

  it('timestamp WITH time zone keeps its zone', () => {
    expect(to('timestamp with time zone', 'postgres', 'postgres')).toBe(
      'timestamp with time zone',
    );
    expect(to('timestamptz', undefined, 'postgres')).toBe('TIMESTAMPTZ');
    expect(to('timestamp without time zone', undefined, 'postgres')).toBe(
      'TIMESTAMP',
    );
  });

  it('an exact decimal stays exact instead of becoming a float', () => {
    expect(to('numeric(38,10)', 'postgres', 'mysql')).toBe('DECIMAL(38,10)');
    expect(to('decimal(10,2)', 'mysql', 'postgres')).toBe('NUMERIC(10,2)');
    // SQLite would turn 38 digits into a 15-digit REAL under any numeric affinity
    expect(to('numeric(38,10)', 'postgres', 'sqlite')).toBe('TEXT');
    expect(to('numeric(12,2)', 'postgres', 'sqlite')).toBe('DECIMAL(12,2)');
    expect(to('numeric', 'postgres', 'postgres')).toBe('numeric');
  });

  it('bytes stay bytes instead of landing in a text column', () => {
    expect(to('bytea', 'postgres', 'mysql')).toBe('LONGBLOB');
    expect(to('bytea', 'postgres', 'sqlite')).toBe('BLOB');
    for (const t of [
      'blob',
      'longblob',
      'mediumblob',
      'tinyblob',
      'varbinary(64)',
      'binary(16)',
    ]) {
      expect(to(t, 'mysql', 'postgres')).toBe('BYTEA');
    }
  });

  it('a MySQL tinyint(1) is a boolean; other tinyints are not', () => {
    expect(to('tinyint(1)', 'mysql', 'postgres')).toBe('BOOLEAN');
    expect(to('tinyint(4)', 'mysql', 'postgres')).toBe('SMALLINT');
    expect(to('tinyint', 'mysql', 'postgres')).toBe('SMALLINT');
    // tinyint(1) unsigned can hold 0-255: a number, not a flag
    expect(to('tinyint(1) unsigned', 'mysql', 'postgres')).toBe('INTEGER');
  });

  it('unsigned integers get a column wide enough to hold them', () => {
    // int unsigned tops out at 4,294,967,295; a signed INTEGER at 2,147,483,647
    expect(to('int unsigned', 'mysql', 'postgres')).toBe('BIGINT');
    expect(to('int(10) unsigned', 'mysql', 'postgres')).toBe('BIGINT');
    expect(to('smallint unsigned', 'mysql', 'postgres')).toBe('INTEGER');
    expect(to('mediumint unsigned', 'mysql', 'postgres')).toBe('BIGINT');
    // 18,446,744,073,709,551,615 does not fit a signed BIGINT
    expect(to('bigint unsigned', 'mysql', 'postgres')).toBe('NUMERIC(20,0)');
    expect(to('bigint(20) unsigned zerofill', 'mysql', 'postgres')).toBe(
      'NUMERIC(20,0)',
    );
  });

  it('a name that merely CONTAINS a known word is not that type', () => {
    // each of these matched one of the old substring patterns
    for (const t of [
      'point',
      'interval',
      'tsvector',
      'daterange',
      'int4range',
      'jsonpath',
    ]) {
      const parsed = parseColumnType(t, 'postgres');
      expect(['interval', 'opaque']).toContain(parsed.kind);
    }
    expect(parseColumnType('point', 'postgres').kind).toBe('opaque');
    expect(parseColumnType('daterange', 'postgres').kind).toBe('opaque');
  });
});

describe('parseColumnType', () => {
  it('reads length, precision and scale', () => {
    expect(parseColumnType('character varying(255)', 'postgres')).toMatchObject(
      {
        kind: 'varchar',
        length: 255,
      },
    );
    expect(parseColumnType('numeric(12,4)', 'postgres')).toMatchObject({
      kind: 'decimal',
      precision: 12,
      scale: 4,
    });
    expect(parseColumnType('decimal(9)', 'mysql')).toMatchObject({
      kind: 'decimal',
      precision: 9,
      scale: 0,
    });
    expect(parseColumnType('char(3)', 'mysql')).toMatchObject({
      kind: 'char',
      length: 3,
    });
  });

  it('reads a modifier that sits in the middle of the name', () => {
    expect(
      parseColumnType('timestamp(3) with time zone', 'postgres').kind,
    ).toBe('timestamptz');
    expect(parseColumnType('time(6) without time zone', 'postgres').kind).toBe(
      'time',
    );
  });

  it('is case- and whitespace-insensitive, and keeps the original spelling', () => {
    const t = parseColumnType('  Character   Varying(40) ', 'postgres');
    expect(t).toMatchObject({
      kind: 'varchar',
      length: 40,
      native: 'Character   Varying(40)',
    });
  });

  it('an unbounded varchar is text', () => {
    expect(parseColumnType('character varying', 'postgres').kind).toBe('text');
    expect(parseColumnType('varchar', 'sqlite').kind).toBe('text');
  });

  it('reads Postgres arrays in both spellings', () => {
    expect(parseColumnType('integer[]', 'postgres')).toMatchObject({
      kind: 'array',
      element: { kind: 'integer' },
    });
    expect(parseColumnType('_int4', 'postgres')).toMatchObject({
      kind: 'array',
      element: { kind: 'integer' },
    });
    expect(
      parseColumnType('character varying(10)[]', 'postgres'),
    ).toMatchObject({
      kind: 'array',
      element: { kind: 'varchar', length: 10 },
    });
    // information_schema only says "ARRAY"; multi-dimensional has no simple form
    expect(parseColumnType('ARRAY', 'postgres').element).toBeUndefined();
    expect(parseColumnType('integer[][]', 'postgres').element).toBeUndefined();
  });

  it('the same name means different things in different engines', () => {
    // SQLite integers are 64-bit whatever the declared name says
    expect(parseColumnType('integer', 'sqlite').kind).toBe('bigint');
    expect(parseColumnType('integer', 'postgres').kind).toBe('integer');
    // float: single precision in MySQL, double in Postgres
    expect(parseColumnType('float', 'mysql').kind).toBe('float');
    expect(parseColumnType('float', 'postgres').kind).toBe('double');
    expect(parseColumnType('float(53)', 'mysql').kind).toBe('double');
    expect(parseColumnType('float(24)', 'postgres').kind).toBe('float');
    // a BSON date is an instant; a MySQL datetime is a wall-clock reading
    expect(parseColumnType('date', 'mongodb').kind).toBe('timestamptz');
    expect(parseColumnType('date', 'mysql').kind).toBe('date');
  });

  it('a MySQL TIMESTAMP keeps its literal reading rather than being re-zoned', () => {
    expect(parseColumnType('timestamp', 'mysql').kind).toBe('timestamp');
    expect(parseColumnType('datetime(6)', 'mysql').kind).toBe('timestamp');
  });

  it('carries what it cannot translate as text, and says so', () => {
    for (const [type, engine] of [
      ["enum('a','b')", 'mysql'],
      ["set('x','y')", 'mysql'],
      ['USER-DEFINED', 'postgres'],
      ['geometry', 'mysql'],
      ['mood', 'postgres'],
      ['money', 'postgres'],
    ] as const) {
      const t = parseColumnType(type, engine);
      expect(t.kind).toBe('opaque');
      expect(t.note).toMatch(/text/);
    }
  });

  it('treats an untyped SQLite column as text, not as bytes', () => {
    const t = parseColumnType('', 'sqlite');
    expect(t.kind).toBe('text');
    expect(t.note).toMatch(/no declared type/);
    // a DECLARED blob is bytes
    expect(parseColumnType('BLOB', 'sqlite').kind).toBe('bytes');
  });

  it('never throws on junk', () => {
    for (const junk of [
      null,
      undefined,
      '',
      '((',
      ')',
      '[]',
      'x'.repeat(5000),
      '🙂',
    ]) {
      expect(() => parseColumnType(junk as string)).not.toThrow();
    }
  });

  it('understands types inferred from a runtime value, whatever the source engine', () => {
    for (const engine of [undefined, 'mongodb', 'redis', 'postgres'] as const) {
      expect(parseColumnType('boolean', engine).kind).toBe('boolean');
      expect(parseColumnType('integer', engine).kind).toBe('integer');
      expect(parseColumnType('double', engine).kind).toBe('double');
      expect(parseColumnType('bigint', engine).kind).toBe('bigint');
      expect(parseColumnType('timestamp', engine).kind).toBe('timestamp');
      expect(parseColumnType('json', engine).kind).toBe('json');
      expect(parseColumnType('text', engine).kind).toBe('text');
    }
  });
});

describe('every portable kind renders on every SQL engine', () => {
  // [source type, source engine, → postgres, → mysql, → sqlite]
  const MATRIX: Array<[string, DatabaseEngine, string, string, string]> = [
    ['boolean', 'postgres', 'boolean', 'TINYINT(1)', 'INTEGER'],
    ['smallint', 'postgres', 'smallint', 'SMALLINT', 'INTEGER'],
    ['integer', 'postgres', 'integer', 'INT', 'INTEGER'],
    ['bigint', 'postgres', 'bigint', 'BIGINT', 'INTEGER'],
    ['real', 'postgres', 'real', 'FLOAT', 'REAL'],
    ['double precision', 'postgres', 'double precision', 'DOUBLE', 'REAL'],
    [
      'numeric(10,2)',
      'postgres',
      'numeric(10,2)',
      'DECIMAL(10,2)',
      'DECIMAL(10,2)',
    ],
    [
      'character varying(80)',
      'postgres',
      'character varying(80)',
      'VARCHAR(80)',
      'TEXT',
    ],
    ['character(2)', 'postgres', 'character(2)', 'CHAR(2)', 'TEXT'],
    ['text', 'postgres', 'text', 'LONGTEXT', 'TEXT'],
    ['bytea', 'postgres', 'bytea', 'LONGBLOB', 'BLOB'],
    ['date', 'postgres', 'date', 'DATE', 'TEXT'],
    [
      'time without time zone',
      'postgres',
      'time without time zone',
      'TIME(6)',
      'TEXT',
    ],
    [
      'timestamp without time zone',
      'postgres',
      'timestamp without time zone',
      'DATETIME(6)',
      'TEXT',
    ],
    [
      'timestamp with time zone',
      'postgres',
      'timestamp with time zone',
      'DATETIME(6)',
      'TEXT',
    ],
    ['interval', 'postgres', 'interval', 'VARCHAR(64)', 'TEXT'],
    ['jsonb', 'postgres', 'jsonb', 'JSON', 'TEXT'],
    ['json', 'postgres', 'json', 'JSON', 'TEXT'],
    ['uuid', 'postgres', 'uuid', 'CHAR(36)', 'TEXT'],
    ['integer[]', 'postgres', 'integer[]', 'JSON', 'TEXT'],
    ['tinyint(1)', 'mysql', 'BOOLEAN', 'tinyint(1)', 'INTEGER'],
    ['int', 'mysql', 'INTEGER', 'int', 'INTEGER'],
    ['bigint', 'mysql', 'BIGINT', 'bigint', 'INTEGER'],
    ['double', 'mysql', 'DOUBLE PRECISION', 'double', 'REAL'],
    ['float', 'mysql', 'REAL', 'float', 'REAL'],
    ['varchar(255)', 'mysql', 'VARCHAR(255)', 'varchar(255)', 'TEXT'],
    ['longtext', 'mysql', 'TEXT', 'longtext', 'TEXT'],
    ['datetime', 'mysql', 'TIMESTAMP', 'datetime', 'TEXT'],
    ['datetime(6)', 'mysql', 'TIMESTAMP', 'datetime(6)', 'TEXT'],
    ['timestamp', 'mysql', 'TIMESTAMP', 'timestamp', 'TEXT'],
    ['time', 'mysql', 'TIME', 'time', 'TEXT'],
    ['year', 'mysql', 'SMALLINT', 'year', 'INTEGER'],
    ['json', 'mysql', 'JSONB', 'json', 'TEXT'],
    ['bit(1)', 'mysql', 'BOOLEAN', 'bit(1)', 'INTEGER'],
    ['INTEGER', 'sqlite', 'BIGINT', 'BIGINT', 'INTEGER'],
    ['TEXT', 'sqlite', 'TEXT', 'LONGTEXT', 'TEXT'],
    ['REAL', 'sqlite', 'REAL', 'FLOAT', 'REAL'],
    ['BLOB', 'sqlite', 'BYTEA', 'LONGBLOB', 'BLOB'],
    ['NUMERIC', 'sqlite', 'NUMERIC', 'DECIMAL(65,30)', 'NUMERIC'],
    ['numeric(30,5)', 'postgres', 'numeric(30,5)', 'DECIMAL(30,5)', 'TEXT'],
    ['bigint unsigned', 'mysql', 'NUMERIC(20,0)', 'bigint unsigned', 'TEXT'],
    ['DATETIME', 'sqlite', 'TIMESTAMP', 'DATETIME(6)', 'DATETIME'],
    ['BOOLEAN', 'sqlite', 'BOOLEAN', 'TINYINT(1)', 'BOOLEAN'],
    ['string', 'mongodb', 'TEXT', 'LONGTEXT', 'TEXT'],
    ['number', 'mongodb', 'DOUBLE PRECISION', 'DOUBLE', 'REAL'],
    ['long', 'mongodb', 'BIGINT', 'BIGINT', 'INTEGER'],
    ['decimal128', 'mongodb', 'NUMERIC', 'DECIMAL(65,30)', 'TEXT'],
    ['boolean', 'mongodb', 'BOOLEAN', 'TINYINT(1)', 'INTEGER'],
    ['date', 'mongodb', 'TIMESTAMPTZ', 'DATETIME(6)', 'TEXT'],
    ['object', 'mongodb', 'JSONB', 'JSON', 'TEXT'],
    ['array', 'mongodb', 'JSONB', 'JSON', 'TEXT'],
    ['binary', 'mongodb', 'BYTEA', 'LONGBLOB', 'BLOB'],
    ['string', 'redis', 'TEXT', 'LONGTEXT', 'TEXT'],
  ];

  it.each(MATRIX)('%s (%s)', (type, source, pg, mysql, sqlite) => {
    expect(to(type, source, 'postgres')).toBe(pg);
    expect(to(type, source, 'mysql')).toBe(mysql);
    expect(to(type, source, 'sqlite')).toBe(sqlite);
  });

  it('every rendered type passes the adapters’ DDL type guard', () => {
    // base-sql-adapter.validateType, plus `[]` for Postgres arrays
    const guard = /^[A-Za-z0-9_ (),]+(\[\])*$/;
    for (const [type, source] of MATRIX) {
      for (const target of ['postgres', 'mysql', 'sqlite'] as const) {
        for (const isKey of [false, true]) {
          expect(to(type, source, target, isKey)).toMatch(guard);
        }
      }
    }
  });

  it('document and key-value targets get an informational kind, never a SQL type', () => {
    expect(to('numeric(10,2)', 'postgres', 'mongodb')).toBe('decimal');
    expect(to('timestamp with time zone', 'postgres', 'redis')).toBe(
      'timestamptz',
    );
  });
});

describe('same engine on both sides', () => {
  it('reuses the source type verbatim, so nothing is narrowed', () => {
    expect(to('numeric(1000,500)', 'postgres', 'postgres')).toBe(
      'numeric(1000,500)',
    );
    expect(to('timestamp(3) with time zone', 'postgres', 'postgres')).toBe(
      'timestamp(3) with time zone',
    );
    expect(to('int unsigned', 'mysql', 'mysql')).toBe('int unsigned');
    expect(to('time with time zone', 'postgres', 'postgres')).toBe(
      'time with time zone',
    );
    // and reports nothing lost, even where another engine would lose something
    expect(warns('time with time zone', 'postgres', 'postgres')).toEqual([]);
    expect(warns('time with time zone', 'postgres', 'mysql')).not.toEqual([]);
  });

  it('does not reuse a type that lives in one database only', () => {
    // an enum or domain would have to exist on the target under the same name
    expect(to('mood', 'postgres', 'postgres')).toBe('TEXT');
    expect(to('USER-DEFINED', 'postgres', 'postgres')).toBe('TEXT');
    expect(to("enum('a','b')", 'mysql', 'mysql')).toBe('LONGTEXT');
  });

  it('does not reuse a type MySQL cannot key on', () => {
    expect(to('longtext', 'mysql', 'mysql', true)).toBe('VARCHAR(255)');
    expect(to('blob', 'mysql', 'mysql', true)).toBe('VARBINARY(255)');
    expect(to('varchar(1000)', 'mysql', 'mysql', true)).toBe('VARCHAR(255)');
    expect(to('varchar(64)', 'mysql', 'mysql', true)).toBe('varchar(64)');
  });

  it('never reuses a string the DDL guard would reject', () => {
    expect(to("enum('a');DROP TABLE x;--", 'mysql', 'mysql')).toBe('LONGTEXT');
  });
});

describe('warnings: a narrowing is reported, never silent', () => {
  it('is quiet when the translation is faithful', () => {
    for (const [type, source, target] of [
      ['integer', 'postgres', 'mysql'],
      ['numeric(10,2)', 'postgres', 'mysql'],
      ['bytea', 'postgres', 'mysql'],
      ['uuid', 'postgres', 'sqlite'],
      ['varchar(255)', 'mysql', 'postgres'],
      ['bigint unsigned', 'mysql', 'postgres'],
    ] as const) {
      expect(warns(type, source, target)).toEqual([]);
    }
  });

  it('says when MySQL cannot hold the source’s precision', () => {
    expect(to('numeric(100,40)', 'postgres', 'mysql')).toBe('DECIMAL(65,30)');
    expect(warns('numeric(100,40)', 'postgres', 'mysql')[0]).toMatch(
      /65 digits/,
    );
    expect(warns('numeric', 'postgres', 'mysql')[0]).toMatch(
      /no fixed precision/,
    );
  });

  it('says when SQLite can only keep a number exact as text', () => {
    expect(warns('numeric(38,10)', 'postgres', 'sqlite')[0]).toMatch(
      /every digit is kept/,
    );
    expect(warns('numeric(12,2)', 'postgres', 'sqlite')).toEqual([]);
    expect(warns('bigint unsigned', 'mysql', 'sqlite')[0]).toMatch(
      /unsigned 64-bit/,
    );
  });

  it('says when a time zone has nowhere to go', () => {
    expect(warns('timestamp with time zone', 'postgres', 'mysql')[0]).toMatch(
      /UTC/,
    );
  });

  it('says when a key column had to be bounded', () => {
    expect(warns('text', 'postgres', 'mysql', true)[0]).toMatch(
      /VARCHAR\(255\)/,
    );
    expect(warns('text', 'postgres', 'mysql', false)).toEqual([]);
  });

  it('says when a type was carried as text', () => {
    expect(warns("enum('a','b')", 'mysql', 'postgres')[0]).toMatch(/ENUM/);
    expect(warns('geometry', 'mysql', 'postgres')[0]).toMatch(
      /not a type Syncle can translate/,
    );
  });

  it('planTargetTable attributes each warning to its column', () => {
    const { spec, warnings } = planTargetTable(
      'orders',
      undefined,
      [
        { name: 'id', sourceType: 'uuid', nullable: false },
        { name: 'total', sourceType: 'numeric', nullable: true },
        {
          name: 'placed_at',
          sourceType: 'timestamp with time zone',
          nullable: true,
        },
        { name: 'note', sourceType: 'text', nullable: true },
      ],
      ['id'],
      'mysql',
      'postgres',
    );
    expect(spec.columns.map((c) => `${c.name} ${c.type}`)).toEqual([
      'id CHAR(36)',
      'total DECIMAL(65,30)',
      'placed_at DATETIME(6)',
      'note LONGTEXT',
    ]);
    expect(warnings.map((w) => w.column)).toEqual(['total', 'placed_at']);
    expect(warnings[0]).toMatchObject({
      sourceType: 'numeric',
      targetType: 'DECIMAL(65,30)',
    });
  });
});
