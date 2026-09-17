/**
 * value-map: what a source driver READ becomes something the target driver can
 * WRITE — and everything that already is, is left alone.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseEngine } from '../adapters/types';
import {
  JsonColumnValue,
  rowConverterFor,
  valueConverterFor,
} from './value-map';

const convert = (
  type: string,
  source: DatabaseEngine,
  target: DatabaseEngine,
  value: unknown,
): unknown => {
  const c = valueConverterFor(type, source, target);
  return c ? c(value) : value;
};

describe('timestamp with time zone', () => {
  const PG = '2026-03-04 05:06:07.891234+00';

  it('reaches MySQL as the UTC wall-clock time, microseconds intact', () => {
    expect(convert('timestamptz', 'postgres', 'mysql', PG)).toBe(
      '2026-03-04 05:06:07.891234',
    );
  });

  it('applies the offset, including a half-hour one', () => {
    expect(
      convert('timestamptz', 'postgres', 'mysql', '1999-12-31 23:59:59+04:30'),
    ).toBe('1999-12-31 19:29:59.000000');
    expect(
      convert('timestamptz', 'postgres', 'mysql', '2026-01-01 00:30:00-08'),
    ).toBe('2026-01-01 08:30:00.000000');
    expect(
      convert('timestamptz', 'postgres', 'mysql', '2026-01-01T00:00:00.5Z'),
    ).toBe('2026-01-01 00:00:00.500000');
  });

  it('reaches SQLite as ISO-8601 UTC, which its date functions understand', () => {
    expect(convert('timestamptz', 'postgres', 'sqlite', PG)).toBe(
      '2026-03-04T05:06:07.891234Z',
    );
  });

  it('reaches a Redis target as the text it was — unless the target keeps rows for something to READ', () => {
    // a `key`/`value` target: the string it has always been given
    expect(convert('timestamptz', 'postgres', 'redis', PG)).toBe(PG);
    // a hash or a JSON document per row: ISO-8601, which every date parser takes
    const iso = valueConverterFor('timestamptz', 'postgres', 'redis', {
      isoInstants: true,
    });
    expect(iso?.(PG)).toBe('2026-03-04T05:06:07.891234Z');
    expect(iso?.('2026-03-04 10:36:07.5+05:30')).toBe(
      '2026-03-04T05:06:07.500000Z',
    );
    expect(iso?.('not a moment')).toBe('not a moment');
    // …and it is an option of REDIS targets: nothing else changes its spelling for it
    expect(
      valueConverterFor('timestamptz', 'postgres', 'postgres', {
        isoInstants: true,
      }),
    ).toBeNull();
    const row = rowConverterFor(
      [{ name: 'seen', sourceType: 'timestamptz' }],
      'postgres',
      'redis',
      { isoInstants: true },
    );
    expect(row?.({ id: 1, seen: PG })).toEqual({
      id: 1,
      seen: '2026-03-04T05:06:07.891234Z',
    });
  });

  it('reaches MongoDB as a Date (BSON dates are millisecond-precise)', () => {
    const d = convert('timestamptz', 'postgres', 'mongodb', PG) as Date;
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-03-04T05:06:07.891Z');
  });

  it('a Date (what MongoDB hands over) is written as UTC text, never in the process zone', () => {
    const at = new Date('2026-03-04T05:06:07.891Z');
    expect(convert('date', 'mongodb', 'mysql', at)).toBe(
      '2026-03-04 05:06:07.891000',
    );
    expect(convert('date', 'mongodb', 'sqlite', at)).toBe(
      '2026-03-04T05:06:07.891000Z',
    );
    // Postgres binds a Date as an instant itself
    expect(convert('date', 'mongodb', 'postgres', at)).toBe(at);
  });

  it('leaves what it cannot read for the target to judge', () => {
    for (const odd of [
      'infinity',
      '-infinity',
      '0044-03-15 12:00:00+00 BC',
      'soon',
    ]) {
      expect(convert('timestamptz', 'postgres', 'mysql', odd)).toBe(odd);
    }
  });
});

describe('wall-clock timestamps', () => {
  it('pass between SQL engines untouched: there is no zone to get wrong', () => {
    const v = '2026-03-04 05:06:07.891234';
    expect(convert('timestamp without time zone', 'postgres', 'mysql', v)).toBe(
      v,
    );
    expect(convert('datetime(6)', 'mysql', 'postgres', v)).toBe(v);
    expect(valueConverterFor('timestamp', 'postgres', 'sqlite')).toBeNull();
  });

  it('become a UTC instant in MongoDB, which has nothing else', () => {
    const d = convert(
      'timestamp',
      'postgres',
      'mongodb',
      '2026-03-04 05:06:07.891',
    ) as Date;
    expect(d.toISOString()).toBe('2026-03-04T05:06:07.891Z');
  });

  it('a MySQL zero date is NULL everywhere else', () => {
    for (const zero of [
      '0000-00-00',
      '0000-00-00 00:00:00',
      '2026-00-10',
      '2026-01-00 00:00:00',
    ]) {
      expect(convert('datetime', 'mysql', 'postgres', zero)).toBeNull();
      expect(convert('date', 'mysql', 'sqlite', zero)).toBeNull();
      expect(convert('timestamp', 'mysql', 'mongodb', zero)).toBeNull();
    }
    expect(convert('date', 'mysql', 'postgres', '2026-01-10')).toBe(
      '2026-01-10',
    );
    // a zero-looking string from another engine is just a string
    expect(convert('date', 'postgres', 'mysql', '0000-00-00')).toBe(
      '0000-00-00',
    );
  });
});

describe('booleans', () => {
  it('MySQL 0/1 and a bit(1) byte become real booleans', () => {
    expect(convert('tinyint(1)', 'mysql', 'postgres', 1)).toBe(true);
    expect(convert('tinyint(1)', 'mysql', 'postgres', 0)).toBe(false);
    expect(convert('bit(1)', 'mysql', 'postgres', Buffer.from([1]))).toBe(true);
    expect(convert('bit(1)', 'mysql', 'mongodb', Buffer.from([0]))).toBe(false);
    expect(convert('tinyint(1)', 'mysql', 'mongodb', '1')).toBe(true);
    expect(convert('BOOLEAN', 'sqlite', 'postgres', 0)).toBe(false);
  });

  it('stay 0/1 for engines that store them that way', () => {
    expect(convert('boolean', 'postgres', 'mysql', true)).toBe(true);
    expect(convert('bit(1)', 'mysql', 'sqlite', Buffer.from([1]))).toBe(1);
  });

  it('a tinyint that is not tinyint(1) is a number and stays one', () => {
    expect(convert('tinyint(4)', 'mysql', 'postgres', 5)).toBe(5);
  });
});

/** what a Postgres-bound json value serialises to on each write path */
const asParam = (v: unknown): string => (v as JsonColumnValue).toPostgres();
const inBulkDoc = (v: unknown): unknown => JSON.parse(JSON.stringify({ v })).v;

describe('json', () => {
  it('text JSON from SQLite is parsed for a target with a real json type', () => {
    expect(convert('JSON', 'sqlite', 'mongodb', '{"a":[1,2]}')).toEqual({
      a: [1, 2],
    });
    expect(convert('JSON', 'sqlite', 'mongodb', '[]')).toEqual([]);
    expect(
      inBulkDoc(convert('JSON', 'sqlite', 'postgres', '{"a":[1,2]}')),
    ).toEqual({ a: [1, 2] });
  });

  it('a JSON string VALUE from a driver that already parsed it is not parsed again', () => {
    // jsonb '"123"' reads as the JS string "123": it is a string, not the number
    const v = convert('jsonb', 'postgres', 'mongodb', '123');
    expect(v).toBe('123');
  });

  describe('on its way into Postgres it is marked as json, even Postgres → Postgres', () => {
    it.each([
      ['a string scalar', 'abc', '"abc"'],
      ['a digit string stays a string', '123', '"123"'],
      ['a number', 5, '5'],
      ['a boolean', true, 'true'],
      ['an empty array stays an array', [], '[]'],
      ['an array', [1, 'x'], '[1,"x"]'],
      ['an object', { a: null }, '{"a":null}'],
    ])('%s', (_label, value, asText) => {
      for (const source of ['postgres', 'mysql', 'mongodb'] as const) {
        const out = convert('json', source, 'postgres', value);
        expect(out).toBeInstanceOf(JsonColumnValue);
        expect(asParam(out)).toBe(asText); // bound as a parameter
        expect(inBulkDoc(out)).toEqual(value); // inside the bulk JSON document
      }
    });

    it('also for jsonb, and only for json kinds', () => {
      expect(convert('jsonb', 'postgres', 'postgres', 'x')).toBeInstanceOf(
        JsonColumnValue,
      );
      expect(valueConverterFor('text', 'postgres', 'postgres')).toBeNull();
      expect(valueConverterFor('integer[]', 'postgres', 'postgres')).toBeNull();
    });
  });

  it('is left as text for targets that store JSON as text', () => {
    expect(valueConverterFor('jsonb', 'postgres', 'mysql')).toBeNull();
    expect(valueConverterFor('jsonb', 'postgres', 'sqlite')).toBeNull();
  });

  it('already-structured values and broken JSON pass through', () => {
    const obj = { a: 1 };
    expect(convert('json', 'mysql', 'mongodb', obj)).toBe(obj);
    expect(convert('JSON', 'sqlite', 'mongodb', '{not json')).toBe('{not json');
  });
});

describe('integers for MongoDB', () => {
  it('a digit string becomes a number only when that is exact', () => {
    expect(convert('bigint', 'postgres', 'mongodb', '42')).toBe(42);
    expect(convert('bigint', 'postgres', 'mongodb', '-9007199254740991')).toBe(
      -9007199254740991,
    );
    expect(
      convert('bigint', 'postgres', 'mongodb', '9223372036854775807'),
    ).toBe('9223372036854775807');
  });

  it('SQL targets keep the digits as they came', () => {
    expect(valueConverterFor('bigint', 'postgres', 'mysql')).toBeNull();
  });
});

describe('rowConverterFor', () => {
  const columns = [
    { name: 'id', sourceType: 'integer' },
    { name: 'active', sourceType: 'tinyint(1)' },
    { name: 'seen', sourceType: 'datetime' },
    { name: 'name', sourceType: 'varchar(40)' },
  ];

  it('is null when nothing needs converting, so rows are never even copied', () => {
    expect(rowConverterFor(columns, 'mysql', 'mysql')).toBeNull();
    expect(
      rowConverterFor([{ name: 'n', sourceType: 'text' }], 'postgres', 'mysql'),
    ).toBeNull();
  });

  it('passes a marker through untouched: it is not a value to convert', () => {
    // UNCHANGED stands in for a column the source did not send. a converter
    // that stringified it would write the text "Symbol(syncle.unchanged)"
    const UNCHANGED = Symbol.for('syncle.unchanged');
    const convertRow = rowConverterFor(
      [
        { name: 'doc', sourceType: 'jsonb' },
        { name: 'at', sourceType: 'timestamptz' },
      ],
      'postgres',
      'mysql',
    )!;
    const row = { doc: UNCHANGED, at: UNCHANGED };
    expect(convertRow(row)).toBe(row);
  });

  it('converts only what it must and returns the same object otherwise', () => {
    const convertRow = rowConverterFor(columns, 'mysql', 'postgres')!;
    const untouched = {
      id: 1,
      active: true,
      seen: '2026-01-01 00:00:00',
      name: 'a',
    };
    expect(convertRow(untouched)).toBe(untouched);

    const row = { id: 2, active: 1, seen: '0000-00-00 00:00:00', name: 'b' };
    const out = convertRow(row);
    expect(out).toEqual({ id: 2, active: true, seen: null, name: 'b' });
    expect(row.active).toBe(1); // the caller's row is not mutated
  });

  it('copes with a delete image that carries only the key', () => {
    const convertRow = rowConverterFor(columns, 'mysql', 'postgres')!;
    expect(convertRow({ id: 9 })).toEqual({ id: 9 });
  });

  it('leaves null and undefined alone', () => {
    const convertRow = rowConverterFor(columns, 'mysql', 'postgres')!;
    expect(convertRow({ id: 1, active: null, seen: undefined })).toEqual({
      id: 1,
      active: null,
      seen: undefined,
    });
  });
});
