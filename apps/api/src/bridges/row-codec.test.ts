/**
 * row-codec: a parked row must come back as the value it was read as — bytes
 * as bytes, dates as dates, bigints as bigints — and data can never be mistaken
 * for one of the codec's own tags.
 */
import { describe, expect, it } from 'vitest';
import { decodeRows, encodeRows, rowsForDisplay } from './row-codec';

const roundTrip = (
  rows: Record<string, unknown>[],
): Record<string, unknown>[] => decodeRows(encodeRows(rows));

describe('row codec', () => {
  it('round-trips plain JSON values untouched', () => {
    const rows = [
      {
        id: 1,
        name: 'a',
        ok: true,
        none: null,
        n: 1.5,
        tags: ['x', 'y'],
        o: { a: 1 },
      },
    ];
    expect(roundTrip(rows)).toEqual(rows);
  });

  it('keeps bytes as bytes', () => {
    const bytes = Buffer.from([0, 255, 16, 32, 0]);
    const [row] = roundTrip([{ id: 1, blob: bytes }]);
    expect(Buffer.isBuffer(row!.blob)).toBe(true);
    expect((row!.blob as Buffer).equals(bytes)).toBe(true);
  });

  it('keeps a Uint8Array as bytes', () => {
    const [row] = roundTrip([{ blob: new Uint8Array([1, 2, 3]) }]);
    expect((row!.blob as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('keeps dates as dates, to the millisecond', () => {
    const at = new Date('2026-09-17T10:11:12.345Z');
    const [row] = roundTrip([{ at }]);
    expect(row!.at).toBeInstanceOf(Date);
    expect((row!.at as Date).getTime()).toBe(at.getTime());
  });

  it('keeps bigints beyond the safe integer range exact', () => {
    const big = 9_223_372_036_854_775_807n;
    const [row] = roundTrip([{ big }]);
    expect(row!.big).toBe(big);
  });

  it('does not throw on a bigint, which plain JSON.stringify does', () => {
    expect(() => JSON.stringify({ big: 1n })).toThrow();
    expect(() => encodeRows([{ big: 1n }])).not.toThrow();
  });

  it('keeps non-finite numbers instead of turning them into null', () => {
    const [row] = roundTrip([
      {
        a: Number.NaN,
        b: Number.POSITIVE_INFINITY,
        c: Number.NEGATIVE_INFINITY,
      },
    ]);
    expect(Number.isNaN(row!.a)).toBe(true);
    expect(row!.b).toBe(Number.POSITIVE_INFINITY);
    expect(row!.c).toBe(Number.NEGATIVE_INFINITY);
  });

  it('handles values nested inside objects and arrays', () => {
    const at = new Date('2020-01-01T00:00:00.000Z');
    const [row] = roundTrip([
      { doc: { when: at, parts: [Buffer.from('hi'), { n: 5n }] } },
    ]);
    const doc = row!.doc as { when: Date; parts: [Buffer, { n: bigint }] };
    expect(doc.when.getTime()).toBe(at.getTime());
    expect(doc.parts[0].toString()).toBe('hi');
    expect(doc.parts[1].n).toBe(5n);
  });

  it('turns undefined and invalid dates into null', () => {
    const [row] = roundTrip([{ a: undefined, b: new Date('nope') }]);
    expect(row).toEqual({ a: null, b: null });
  });

  describe('data that looks like a tag stays data', () => {
    it.each([
      [{ $bytes: 'aGk=' }],
      [{ $date: '2020-01-01T00:00:00.000Z' }],
      [{ $bigint: '12' }],
      [{ $literal: 'NaN' }],
      [{ $literal: { $bytes: 'aGk=' } }],
    ])('%j', (value) => {
      const [row] = roundTrip([{ payload: value }]);
      expect(row!.payload).toEqual(value);
    });

    it('still decodes a real tag nested inside look-alike data', () => {
      const [row] = roundTrip([{ payload: { $bytes: Buffer.from('real') } }]);
      const inner = (row!.payload as { $bytes: Buffer }).$bytes;
      expect(Buffer.isBuffer(inner)).toBe(true);
      expect(inner.toString()).toBe('real');
    });
  });

  it('uses the JSON form of driver wrapper types', () => {
    class ObjectIdLike {
      toJSON(): string {
        return '507f1f77bcf86cd799439011';
      }
    }
    const [row] = roundTrip([{ _id: new ObjectIdLike() }]);
    expect(row!._id).toBe('507f1f77bcf86cd799439011');
  });

  it('rejects stored data that is not a list of rows', () => {
    expect(() => decodeRows('{"a":1}')).toThrow(/not a list/);
    expect(() => decodeRows('[1,2]')).toThrow(/not an object/);
    expect(() => decodeRows('not json')).toThrow();
  });

  it('shows rows for the API without dumping bytes', () => {
    const json = encodeRows([
      {
        id: 7n,
        at: new Date('2026-01-02T03:04:05.000Z'),
        blob: Buffer.alloc(2048),
      },
    ]);
    expect(rowsForDisplay(json)).toEqual([
      { id: '7', at: '2026-01-02T03:04:05.000Z', blob: '<2048 bytes>' },
    ]);
  });
});
