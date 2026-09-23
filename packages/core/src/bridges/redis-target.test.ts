import { describe, expect, it } from 'vitest';
import { databaseTargetSchema } from './bridge-config';
import { UNCHANGED } from './bridge';
import {
  RedisKeyError,
  redisKeyColumns,
  redisTargetSchema,
  redisText,
  renderRedisKey,
  toRedisRow,
} from './redis-target';

describe('a key template', () => {
  it('names the columns it is built from, once each, in order', () => {
    expect(redisKeyColumns('user:{{id}}')).toEqual(['id']);
    expect(redisKeyColumns('t:{{ tenant_id }}:u:{{id}}:{{tenant_id}}')).toEqual(
      ['tenant_id', 'id'],
    );
    expect(redisKeyColumns('no columns here')).toEqual([]);
  });

  it('renders a key from a row, whatever the driver handed over', () => {
    expect(renderRedisKey('user:{{id}}', { id: 42 })).toBe('user:42');
    expect(renderRedisKey('user:{{id}}', { id: '42' })).toBe('user:42');
    expect(renderRedisKey('user:{{id}}', { id: 9007199254740993n })).toBe(
      'user:9007199254740993',
    );
    expect(
      renderRedisKey('t:{{tenant}}:u:{{id}}', { tenant: 'acme', id: 7 }),
    ).toBe('t:acme:u:7');
    expect(
      renderRedisKey('day:{{d}}', { d: new Date('2026-03-01T00:00:00.000Z') }),
    ).toBe('day:2026-03-01T00:00:00.000Z');
    expect(
      renderRedisKey('h:{{digest}}', { digest: Uint8Array.from([0xde, 0xad]) }),
    ).toBe('h:dead');
  });

  it('refuses to build a key from nothing: two rows must never share a key by accident', () => {
    for (const row of [{}, { id: null }, { id: undefined }, { id: '' }]) {
      expect(() => renderRedisKey('user:{{id}}', row)).toThrow(RedisKeyError);
    }
    try {
      renderRedisKey('t:{{tenant}}:u:{{id}}', { id: 1 });
    } catch (err) {
      expect((err as RedisKeyError).missing).toEqual(['tenant']);
      expect((err as Error).message).toContain('"tenant"');
      expect((err as Error).message).toContain('t:{{tenant}}:u:{{id}}');
    }
  });
});

describe('what Redis keeps of a value', () => {
  it('is its text', () => {
    expect(redisText('plain')).toBe('plain');
    expect(redisText(12.5)).toBe('12.5');
    expect(redisText(0)).toBe('0');
    expect(redisText(10n ** 20n)).toBe('100000000000000000000');
    expect(redisText(true)).toBe('true');
    expect(redisText(false)).toBe('false');
    expect(redisText(new Date('2026-03-01T10:20:30.123Z'))).toBe(
      '2026-03-01T10:20:30.123Z',
    );
  });

  it('a document is JSON — never "[object Object]"', () => {
    expect(redisText({ a: 1, b: [true, null] })).toBe(
      '{"a":1,"b":[true,null]}',
    );
    expect(redisText([1, 2])).toBe('[1,2]');
    expect(redisText({ big: 5n, bytes: Uint8Array.from([1, 2, 3]) })).toBe(
      '{"big":"5","bytes":"AQID"}',
    );
    // a value wrapped for another engine's driver says what it holds
    expect(redisText({ toJSON: () => ({ wrapped: true }) })).toBe(
      '{"wrapped":true}',
    );
  });

  it('bytes stay bytes: a Redis string is binary-safe', () => {
    const bytes = Uint8Array.from([0, 255, 10]);
    expect(redisText(bytes)).toBe(bytes);
  });

  it('nothing is nothing: NULL, a value the source did not send, a date that is not one', () => {
    expect(redisText(null)).toBeNull();
    expect(redisText(undefined)).toBeNull();
    expect(redisText(UNCHANGED)).toBeNull();
    expect(redisText(new Date('nope'))).toBeNull();
  });
});

describe('a row, as the key it becomes', () => {
  const row = { id: 7, name: 'Ada', note: null, tags: ['a', 'b'] };

  it('hash: a field per column, NULL as "no such field", written into the hash that is there', () => {
    expect(
      toRedisRow({ keyTemplate: 'user:{{id}}', type: 'hash' }, row),
    ).toEqual({
      key: 'user:7',
      type: 'hash',
      value: { id: '7', name: 'Ada', note: null, tags: '["a","b"]' },
      ttl: 0,
      fields: true,
    });
  });

  it('json: the whole row as one document, NULLs included', () => {
    const out = toRedisRow(
      { keyTemplate: 'user:{{id}}', type: 'json', ttlSeconds: 3600 },
      { ...row, big: 9007199254740993n, sent: UNCHANGED },
    );
    expect(out).toEqual({
      key: 'user:7',
      type: 'string',
      value:
        '{"id":7,"name":"Ada","note":null,"tags":["a","b"],"big":"9007199254740993","sent":null}',
      ttl: 3600,
    });
  });

  it('string: one column; a NULL there is the empty string, not a missing key', () => {
    const config = {
      keyTemplate: 'name:{{id}}',
      type: 'string' as const,
      valueColumn: 'name',
    };
    expect(toRedisRow(config, row)).toEqual({
      key: 'name:7',
      type: 'string',
      value: 'Ada',
      ttl: 0,
    });
    expect(toRedisRow(config, { id: 7, name: null }).value).toBe('');
  });
});

describe('the configuration', () => {
  const parse = (redis: unknown) => redisTargetSchema.safeParse(redis);
  const problem = (redis: unknown) => {
    const r = parse(redis);
    return r.success ? null : r.error.issues.map((i) => i.message).join(' | ');
  };

  it('defaults to a hash that does not expire', () => {
    expect(parse({ keyTemplate: ' user:{{id}} ' })).toMatchObject({
      success: true,
      data: { keyTemplate: 'user:{{id}}', type: 'hash' },
    });
  });

  it('a key without a column in it would be ONE key for every row', () => {
    expect(problem({ keyTemplate: 'users' })).toMatch(/at least one column/);
    expect(problem({ keyTemplate: 'users:{{ }}' })).toMatch(/empty \{\{ \}\}/);
  });

  it('a key has to be the same every time the row is written', () => {
    expect(problem({ keyTemplate: 'user:{{id}}:{{$now}}' })).toMatch(
      /\{\{\$now\}\} cannot be part of a key/,
    );
  });

  it('a string needs its column; a hash and a document take none', () => {
    expect(problem({ keyTemplate: 'u:{{id}}', type: 'string' })).toMatch(
      /say which column/,
    );
    expect(
      problem({ keyTemplate: 'u:{{id}}', type: 'hash', valueColumn: 'name' }),
    ).toMatch(/only applies to a string key/);
    expect(
      problem({ keyTemplate: 'u:{{id}}', type: 'string', valueColumn: 'name' }),
    ).toBeNull();
  });

  it('an expiry is whole seconds, at least one', () => {
    expect(problem({ keyTemplate: 'u:{{id}}', ttlSeconds: 0 })).not.toBeNull();
    expect(
      problem({ keyTemplate: 'u:{{id}}', ttlSeconds: 1.5 }),
    ).not.toBeNull();
    expect(problem({ keyTemplate: 'u:{{id}}', ttlSeconds: 60 })).toBeNull();
  });
});

describe('a target with a key template', () => {
  const target = (extra: Record<string, unknown>) =>
    databaseTargetSchema.safeParse({
      connectionId: 'c',
      table: 'keys',
      ...extra,
    });

  it('is keyed on the COLUMNS of the template, whatever was sent as key columns', () => {
    const r = target({
      keyColumns: ['something else'],
      redis: { keyTemplate: 't:{{tenant_id}}:u:{{id}}' },
    });
    expect(r.success && r.data.keyColumns).toEqual(['tenant_id', 'id']);
  });

  it('without one, a target is exactly what it was', () => {
    const r = target({ keyColumns: ['id'] });
    expect(r.success && r.data.keyColumns).toEqual(['id']);
    expect(r.success && r.data.redis).toBeUndefined();
  });

  it('cannot be soft-deleted: there is no column to put the mark in', () => {
    const r = target({
      redis: { keyTemplate: 'u:{{id}}' },
      onDelete: 'soft',
      softDelete: { column: 'deleted_at' },
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toMatch(
      /cannot be marked as deleted/,
    );
  });

  it('a key or a value column the target does not receive is said when it is saved, not when the first row fails', () => {
    const mapping = [
      { source: 'id', target: 'user_id' },
      { source: 'name', target: 'name' },
    ];
    const bad = target({ mapping, redis: { keyTemplate: 'u:{{id}}' } });
    expect(!bad.success && bad.error.issues[0]!.message).toMatch(
      /"id" is not a column this target receives/,
    );
    expect(
      target({ mapping, redis: { keyTemplate: 'u:{{user_id}}' } }).success,
    ).toBe(true);
    const noValue = target({
      mapping,
      redis: {
        keyTemplate: 'u:{{user_id}}',
        type: 'string',
        valueColumn: 'email',
      },
    });
    expect(!noValue.success && noValue.error.issues[0]!.message).toMatch(
      /"email"/,
    );
  });
});
