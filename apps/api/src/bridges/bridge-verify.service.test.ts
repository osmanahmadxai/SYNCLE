import { describe, expect, it } from 'vitest';
import { isMarked, lookupValues, show } from './bridge-verify.service';

describe('values asked for with an IN', () => {
  it('each once, as they are', () => {
    expect(lookupValues([1, 2, 2, 'a', 'a', '2'])).toEqual([1, 2, 'a', '2']);
  });

  it('a document store matches by type: a key that came back from SQL as text is asked for as the number too', () => {
    expect(lookupValues(['5', '17'], 'mongodb')).toEqual(['5', 5, '17', 17]);
    // …but only when the text is exactly how that number is written, and safely a number
    expect(
      lookupValues(
        [
          '007',
          '5.0',
          '-3',
          '9007199254740993',
          'abc',
          '65f1c0ffee65f1c0ffee65f1',
        ],
        'mongodb',
      ),
    ).toEqual([
      '007',
      '5.0',
      '-3',
      -3,
      '9007199254740993',
      'abc',
      '65f1c0ffee65f1c0ffee65f1',
    ]);
    // a SQL engine coerces by the column's type and needs none of it
    expect(lookupValues(['5'], 'postgres')).toEqual(['5']);
  });
});

describe('a soft-delete marker', () => {
  it('is set when it holds a time or true — not when it is null, false or empty', () => {
    for (const set of [new Date(), '2026-09-17 10:00:00', true, 1, 't'])
      expect(isMarked(set)).toBe(true);
    for (const unset of [null, undefined, false, 0, '0', ''])
      expect(isMarked(unset)).toBe(false);
  });
});

describe('a value in a report', () => {
  it('is plain JSON, and short', () => {
    expect(show(null)).toBeNull();
    expect(show(undefined)).toBeNull();
    expect(show(9007199254740993n)).toBe('9007199254740993');
    expect(show(new Date('2026-09-17T10:00:00Z'))).toBe(
      '2026-09-17T10:00:00.000Z',
    );
    expect(show(Buffer.from([1, 2, 3]))).toBe('<3 bytes>');
    expect(show(NaN)).toBe('NaN');
    expect(show(1.5)).toBe(1.5);
    expect(show(true)).toBe(true);
    expect(show({ a: [1, { b: 2n }] })).toEqual({ a: [1, { b: '2' }] });
    const long = show('x'.repeat(5000)) as string;
    expect(long.length).toBeLessThan(260);
    expect(long).toMatch(/… \(5000 characters\)$/);
    const big = show({ text: 'y'.repeat(5000) }) as string;
    expect(typeof big).toBe('string');
    expect(big).toMatch(/characters\)$/);
    // whatever it is, it survives being stored
    expect(() =>
      JSON.stringify([
        show(1n),
        show(new Date()),
        show(Buffer.alloc(9)),
        show({ n: 1n }),
      ]),
    ).not.toThrow();
  });
});
