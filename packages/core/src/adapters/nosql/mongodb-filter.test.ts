import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { FilterSpec } from '../types';
import { afterId, buildMongoFilter } from './mongodb-adapter';

const HEX = '64f0c0ffee64f0c0ffee64f0';
const f = (column: string, operator: string, value?: unknown): FilterSpec =>
  ({ column, operator, value }) as FilterSpec;

describe('buildMongoFilter', () => {
  it('is one plain clause for one condition, and `{}` for none', () => {
    expect(buildMongoFilter(undefined)).toEqual({});
    expect(buildMongoFilter([])).toEqual({});
    expect(buildMongoFilter([f('age', 'gte', 18)])).toEqual({
      age: { $gte: 18 },
    });
    expect(buildMongoFilter([f('name', 'eq', 'Ada')])).toEqual({ name: 'Ada' });
  });

  it('ANDs the conditions: two on one column used to leave only the second', () => {
    expect(
      buildMongoFilter([
        f('age', 'gte', 18),
        f('age', 'lt', 65),
        f('name', 'notNull'),
      ]),
    ).toEqual({
      $and: [
        { age: { $gte: 18 } },
        { age: { $lt: 65 } },
        { name: { $ne: null } },
      ],
    });
  });

  it('looks for an `_id` written as 24 hex characters as the ObjectId it shows — and as the text it may be', () => {
    expect(buildMongoFilter([f('_id', 'eq', HEX)])).toEqual({
      _id: { $in: [new ObjectId(HEX), HEX] },
    });
    expect(buildMongoFilter([f('_id', 'neq', HEX)])).toEqual({
      _id: { $nin: [new ObjectId(HEX), HEX] },
    });
    expect(buildMongoFilter([f('_id', 'in', [HEX, 7, 'plain'])])).toEqual({
      _id: { $in: [new ObjectId(HEX), HEX, 7, 'plain'] },
    });
    // a comparison matches its own BSON type only, so it is asked once per form
    expect(buildMongoFilter([f('_id', 'gt', HEX)])).toEqual({
      $or: [{ _id: { $gt: new ObjectId(HEX) } }, { _id: { $gt: HEX } }],
    });
  });

  it('leaves every other value, and every other column, as it is', () => {
    expect(buildMongoFilter([f('_id', 'eq', 42)])).toEqual({ _id: 42 });
    expect(buildMongoFilter([f('_id', 'eq', 'not-hex')])).toEqual({
      _id: 'not-hex',
    });
    expect(buildMongoFilter([f('ref', 'eq', HEX)])).toEqual({ ref: HEX });
    expect(buildMongoFilter([f('_id', 'in', 'not-a-list')])).toEqual({
      _id: { $in: [] },
    });
  });

  it('keeps the text operators case-insensitive and literal', () => {
    expect(buildMongoFilter([f('name', 'contains', 'a.b')])).toEqual({
      name: { $regex: 'a\\.b', $options: 'i' },
    });
    expect(buildMongoFilter([f('name', 'startsWith', 'Ad')])).toEqual({
      name: { $regex: '^Ad', $options: 'i' },
    });
    expect(buildMongoFilter([f('name', 'endsWith', 'da')])).toEqual({
      name: { $regex: 'da$', $options: 'i' },
    });
    expect(buildMongoFilter([f('gone', 'isNull')])).toEqual({ gone: null });
  });

  it('refuses what it does not know, and a value that is not a scalar', () => {
    expect(() => buildMongoFilter([f('a', 'between', 1)])).toThrow(
      /Unsupported filter operator/,
    );
    expect(() => buildMongoFilter([f('a', 'eq', { $gt: '' })])).toThrow(
      /must be a scalar/,
    );
  });
});

describe('afterId: the documents that sort after an `_id`, whatever kind their own is', () => {
  const laterTypes = (last: unknown): string[] => {
    const q = afterId(last) as {
      $or?: [unknown, { _id: { $type: string[] } }];
    };
    return q.$or ? q.$or[1]._id.$type : [];
  };

  it('asks for greater values of the same kind, and for every kind MongoDB sorts later', () => {
    expect(afterId(7)).toEqual({
      $or: [
        { _id: { $gt: 7 } },
        {
          _id: {
            $type: [
              'string',
              'symbol',
              'object',
              'binData',
              'objectId',
              'bool',
              'date',
              'timestamp',
            ],
          },
        },
      ],
    });
    expect(laterTypes('text')).toEqual([
      'object',
      'binData',
      'objectId',
      'bool',
      'date',
      'timestamp',
    ]);
    expect(laterTypes(new ObjectId(HEX))).toEqual([
      'bool',
      'date',
      'timestamp',
    ]);
    expect(laterTypes(new Date(0))).toEqual(['timestamp']);
    expect(laterTypes({ a: 1 })).toEqual([
      'binData',
      'objectId',
      'bool',
      'date',
      'timestamp',
    ]);
  });

  it('numbers of any width are one kind: none of them is "later" than another', () => {
    expect(laterTypes(7)).not.toContain('long');
    expect(laterTypes(7n)).not.toContain('double');
  });
});
