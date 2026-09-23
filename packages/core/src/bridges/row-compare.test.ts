import { describe, expect, it } from 'vitest';
import {
  diffRow,
  keyText,
  sameValue,
  volatileColumns,
  type CompareKind,
} from './row-compare';
import { JsonColumnValue } from './value-map';

const same = (kind: CompareKind, a: unknown, b: unknown) => {
  // what is the same one way round is the same the other way round
  expect(sameValue(kind, b, a)).toBe(sameValue(kind, a, b));
  return sameValue(kind, a, b);
};

describe('NULL', () => {
  it('is only the same as NULL, whatever the column is', () => {
    for (const kind of [
      'integer',
      'text',
      'json',
      'timestamptz',
      'boolean',
      'unknown',
    ] as const) {
      expect(same(kind, null, null)).toBe(true);
      expect(same(kind, null, undefined)).toBe(true);
      expect(same(kind, null, 0)).toBe(false);
      expect(same(kind, null, '')).toBe(false);
      expect(same(kind, null, false)).toBe(false);
    }
  });
});

describe('numbers', () => {
  it('an integer is the same however the driver hands it over', () => {
    expect(same('bigint', '9007199254740993', 9007199254740993n)).toBe(true);
    expect(same('integer', 5, '5')).toBe(true);
    expect(same('integer', 5, '5.0')).toBe(true);
    expect(same('integer', -0, 0)).toBe(true);
    expect(same('integer', '007', 7)).toBe(true);
    expect(same('bigint', '9007199254740993', '9007199254740992')).toBe(false);
    expect(same('integer', 5, 6)).toBe(false);
  });

  it('a decimal is compared exactly — a lost cent is a difference, a trailing zero is not', () => {
    expect(same('decimal', '1.50', 1.5)).toBe(true);
    expect(same('decimal', '1.50', '1.5')).toBe(true);
    expect(same('decimal', '100', '100.000')).toBe(true);
    expect(same('decimal', '-0.0', '0')).toBe(true);
    expect(same('decimal', '.5', '0.5')).toBe(true);
    expect(
      same(
        'decimal',
        '12345678901234567890.123456789',
        '12345678901234567890.123456789',
      ),
    ).toBe(true);
    expect(
      same(
        'decimal',
        '12345678901234567890.123456789',
        '12345678901234567890.123456788',
      ),
    ).toBe(false);
    expect(same('decimal', '19.99', '19.98')).toBe(false);
    expect(same('decimal', '1.005', '1.01')).toBe(false);
    expect(same('decimal', 'NaN', 'NaN')).toBe(true);
    expect(same('decimal', '1e-7', 0.0000001)).toBe(true);
  });

  it('a float is the same to the digits a float holds: float4 noise is not drift, a changed value is', () => {
    expect(same('float', 0.1, 0.10000000149011612)).toBe(true);
    expect(same('float', '3.14159', 3.1415901184082031)).toBe(true);
    expect(same('float', 0.1, 0.1001)).toBe(false);
    expect(same('double', 0.1 + 0.2, 0.3)).toBe(true);
    expect(same('double', 1e300, 1.0000001e300)).toBe(false);
    expect(same('double', 'Infinity', Infinity)).toBe(true);
    expect(same('double', '-Infinity', Infinity)).toBe(false);
    expect(same('double', NaN, 'NaN')).toBe(true);
    expect(same('double', 0, 1e-320)).toBe(false);
  });
});

describe('booleans', () => {
  it('true is true in every engine’s spelling', () => {
    for (const t of [true, 1, '1', 't', 'true', Uint8Array.of(1)])
      expect(same('boolean', true, t)).toBe(true);
    for (const f of [false, 0, '0', 'f', 'false', Uint8Array.of(0)])
      expect(same('boolean', false, f)).toBe(true);
    expect(same('boolean', true, 0)).toBe(false);
    expect(same('boolean', true, 'f')).toBe(false);
  });
});

describe('time', () => {
  it('an instant is the same in any zone’s spelling, to the microsecond', () => {
    expect(
      same(
        'timestamptz',
        '2026-03-04 05:06:07.891234+00',
        '2026-03-04 05:06:07.891234',
      ),
    ).toBe(true);
    expect(
      same(
        'timestamptz',
        '2026-03-04 09:36:07.891234+04:30',
        '2026-03-04T05:06:07.891234Z',
      ),
    ).toBe(true);
    expect(
      same(
        'timestamptz',
        '2026-03-04 05:06:07.8912+00',
        '2026-03-04 05:06:07.891200',
      ),
    ).toBe(true);
    expect(
      same(
        'timestamptz',
        '2026-03-04 05:06:07+00',
        '2026-03-04 05:06:07.000000',
      ),
    ).toBe(true);
    expect(
      same(
        'timestamptz',
        '2026-03-04 05:06:07.891234+00',
        '2026-03-04 05:06:07.891235',
      ),
    ).toBe(false);
    expect(
      same('timestamptz', '2026-03-04 05:06:07+00', '2026-03-04 05:06:08'),
    ).toBe(false);
    // an hour out is what a zone bug looks like
    expect(
      same('timestamptz', '2026-03-04 05:06:07+00', '2026-03-04 06:06:07'),
    ).toBe(false);
  });

  it('against a Date — which never held more than milliseconds — the milliseconds decide', () => {
    const date = new Date('2026-03-04T05:06:07.891Z');
    expect(same('timestamptz', '2026-03-04 05:06:07.891234+00', date)).toBe(
      true,
    );
    expect(same('timestamp', '2026-03-04 05:06:07.891', date)).toBe(true);
    expect(same('timestamptz', '2026-03-04 05:06:07.892+00', date)).toBe(false);
    expect(
      same(
        'timestamp',
        '2026-03-04 05:06:08',
        new Date('2026-03-04T05:06:07.000Z'),
      ),
    ).toBe(false);
    // but two texts that both hold microseconds are held to them
    expect(
      same(
        'timestamp',
        '2026-03-04 05:06:07.891234',
        '2026-03-04 05:06:07.891',
      ),
    ).toBe(false);
  });

  it('dates and times of day', () => {
    expect(same('date', '2026-03-04', new Date('2026-03-04T00:00:00Z'))).toBe(
      true,
    );
    expect(same('date', '2026-03-04', '2026-03-04 00:00:00')).toBe(true);
    expect(same('date', '2026-03-04', '2026-03-05')).toBe(false);
    expect(same('time', '05:06:07', '05:06:07.000000')).toBe(true);
    expect(same('time', '05:06', '05:06:00')).toBe(true);
    expect(same('time', '05:06:07.5', '05:06:07.50')).toBe(true);
    expect(same('time', '05:06:07', '05:06:08')).toBe(false);
  });

  it('what is not a timestamp at all (infinity) is compared as what it is', () => {
    expect(same('timestamptz', 'infinity', 'infinity')).toBe(true);
    expect(same('timestamptz', 'infinity', '-infinity')).toBe(false);
  });
});

describe('structure', () => {
  it('json is the same whatever the key order, the spacing, or which side still has it as text', () => {
    expect(
      same(
        'json',
        { b: 1, a: [1, 2, { z: null, y: 'x' }] },
        '{"a":[1,2,{"y":"x","z":null}],"b":1}',
      ),
    ).toBe(true);
    expect(same('json', new JsonColumnValue({ a: 1 }), { a: 1 })).toBe(true);
    expect(same('json', '{"a": 1}', '{"a":1}')).toBe(true);
    expect(same('json', [1, 2, 3], [1, 2, 3])).toBe(true);
    expect(same('json', [], '[]')).toBe(true);
    expect(same('json', { a: 1 }, { a: 2 })).toBe(false);
    expect(same('json', [1, 2, 3], [3, 2, 1])).toBe(false);
    expect(same('json', { a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it('a JSON string value: parsed by one driver, still quoted text from another', () => {
    expect(same('json', 'abc', '"abc"')).toBe(true);
    expect(same('json', 'abc', 'abc')).toBe(true);
    expect(same('json', 'abc', 'abd')).toBe(false);
    expect(same('json', 123, '123')).toBe(true);
    expect(same('json', true, 'true')).toBe(true);
    expect(same('json', true, 'false')).toBe(false);
  });

  it('an array column that became a json column is still the same list', () => {
    expect(same('array', ['a', 'b'], '["a","b"]')).toBe(true);
    expect(same('array', ['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('bytes are the same bytes, as a Buffer or as one that went through JSON', () => {
    expect(
      same('bytes', Uint8Array.of(0, 255, 16), Buffer.from([0, 255, 16])),
    ).toBe(true);
    expect(
      same('bytes', Uint8Array.of(1, 2), { type: 'Buffer', data: [1, 2] }),
    ).toBe(true);
    expect(same('bytes', Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(same('bytes', Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(
      false,
    );
  });
});

describe('text', () => {
  it('is compared exactly — case, spaces, everything — except the padding of a char(n)', () => {
    expect(same('text', 'Ada', 'Ada')).toBe(true);
    expect(same('text', 'Ada', 'ada')).toBe(false);
    expect(same('text', 'Ada', 'Ada ')).toBe(false);
    expect(same('varchar', '', ' ')).toBe(false);
    expect(same('char', 'abc       ', 'abc')).toBe(true);
    expect(same('char', ' abc', 'abc')).toBe(false);
    expect(
      same(
        'uuid',
        'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      ),
    ).toBe(true);
    expect(same('text', '5', 5)).toBe(true);
    expect(same('text', '05', 5)).toBe(false);
  });
});

describe('no kind to go by', () => {
  it('the values say what they are', () => {
    expect(same('unknown', 5, '5')).toBe(true);
    expect(same('unknown', 1.5, '1.50')).toBe(true);
    expect(same('unknown', true, 1)).toBe(true);
    expect(
      same(
        'unknown',
        new Date('2026-03-04T05:06:07.891Z'),
        '2026-03-04 05:06:07.891',
      ),
    ).toBe(true);
    expect(same('unknown', { a: [1, { b: 2 }] }, '{"a":[1,{"b":2}]}')).toBe(
      true,
    );
    expect(same('unknown', 'abc', 'abc')).toBe(true);
    expect(same('unknown', 'abc', 'abd')).toBe(false);
    expect(same('unknown', 5, 6)).toBe(false);
    expect(same('unknown', { a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('keys', () => {
  it('a numeric key is one row however it is read', () => {
    expect(keyText([5], ['integer'])).toBe(keyText(['5'], ['integer']));
    expect(keyText(['9007199254740993'], ['bigint'])).toBe(
      keyText([9007199254740993n], ['bigint']),
    );
    expect(keyText(['1.50'], ['decimal'])).toBe(keyText([1.5], ['decimal']));
    expect(keyText([5], ['integer'])).not.toBe(keyText([6], ['integer']));
  });

  it('a TEXT key is never read as a number: 007 and 7 are two rows', () => {
    expect(keyText(['007'], ['text'])).not.toBe(keyText(['7'], ['text']));
    expect(keyText(['7'], ['varchar'])).not.toBe(keyText(['7.0'], ['varchar']));
    expect(keyText(['Ada'], ['text'])).not.toBe(keyText(['ada'], ['text']));
    expect(keyText(['A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'], ['uuid'])).toBe(
      keyText(['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'], ['uuid']),
    );
  });

  it('with no kind: a string is a number only when it is spelled exactly as one', () => {
    expect(keyText([5])).toBe(keyText(['5']));
    expect(keyText(['007'])).not.toBe(keyText([7]));
    expect(keyText(['5.0'])).not.toBe(keyText([5]));
    expect(keyText(['65f1c0ffee65f1c0ffee65f1'])).toBe(
      keyText(['65f1c0ffee65f1c0ffee65f1']),
    );
  });

  it('composite keys keep their order, and their parts apart', () => {
    expect(keyText([1, 'a'], ['integer', 'text'])).toBe(
      keyText(['1', 'a'], ['integer', 'text']),
    );
    expect(keyText([1, 2], ['integer', 'integer'])).not.toBe(
      keyText([2, 1], ['integer', 'integer']),
    );
    expect(keyText(['a,b', 'c'], ['text', 'text'])).not.toBe(
      keyText(['a', 'b,c'], ['text', 'text']),
    );
    expect(keyText([null, 1], ['integer', 'integer'])).not.toBe(
      keyText([0, 1], ['integer', 'integer']),
    );
  });

  it('a timestamp key is the same instant in any spelling', () => {
    expect(keyText(['2026-03-04 05:06:07.500+00'], ['timestamptz'])).toBe(
      keyText(['2026-03-04T05:06:07.5Z'], ['timestamptz']),
    );
  });
});

describe('diffRow', () => {
  const kinds = {
    id: 'integer',
    total: 'decimal',
    at: 'timestamptz',
    doc: 'json',
    name: 'text',
  } as const;

  it('nothing, for the same row read two ways', () => {
    expect(
      diffRow(
        {
          id: 1,
          total: '19.90',
          at: '2026-03-04 05:06:07.5+00',
          doc: new JsonColumnValue({ b: 1, a: 2 }),
          name: 'Ada',
        },
        {
          id: '1',
          total: 19.9,
          at: '2026-03-04 05:06:07.500000',
          doc: '{"a":2,"b":1}',
          name: 'Ada',
          loaded_at: 'not the bridge’s column',
        },
        kinds,
      ),
    ).toEqual([]);
  });

  it('the columns that differ, with both readings', () => {
    expect(
      diffRow(
        { id: 1, total: '19.90', name: 'Ada' },
        { id: 1, total: '19.00', name: null },
        kinds,
      ),
    ).toEqual([
      { column: 'total', expected: '19.90', actual: '19.00' },
      { column: 'name', expected: 'Ada', actual: null },
    ]);
  });

  it('a column the destination does not have at all is a difference; one the source did not send is not', () => {
    expect(diffRow({ id: 1, name: 'Ada' }, { id: 1 }, kinds)).toEqual([
      { column: 'name', expected: 'Ada', actual: undefined },
    ]);
    expect(diffRow({ id: 1, name: null }, { id: 1 }, kinds)).toEqual([]);
    expect(
      diffRow(
        { id: 1, name: Symbol('unchanged') },
        { id: 1, name: 'whatever' },
        kinds,
      ),
    ).toEqual([]);
  });
});

describe('columns that can never be the same twice', () => {
  it('a computed column that uses the time of delivery, and whatever is computed from it', () => {
    expect(
      volatileColumns([
        { kind: 'set', column: 'loaded_at', template: '{{ $now }}' },
        { kind: 'set', column: 'label', template: '{{first}} {{last}}' },
        {
          kind: 'set',
          column: 'stamp',
          template: 'row {{id}} at {{loaded_at}}',
        },
        { kind: 'mask', column: 'email', mode: 'hash' },
      ] as never),
    ).toEqual(new Set(['loaded_at', 'stamp']));
  });

  it('a column recomputed from things that do not move is comparable again; no steps, none', () => {
    expect(
      volatileColumns([
        { kind: 'set', column: 'x', template: '{{$now}}' },
        { kind: 'set', column: 'x', template: '{{id}}' },
      ] as never),
    ).toEqual(new Set());
    expect(volatileColumns(undefined)).toEqual(new Set());
    // `$table` is the same every time
    expect(
      volatileColumns([
        { kind: 'set', column: 't', template: '{{$table}}' },
      ] as never),
    ).toEqual(new Set());
  });
});
