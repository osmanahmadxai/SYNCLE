import { describe, expect, it } from 'vitest';
import { redisGlobMatch, redisKeyPattern } from './redis-key-pattern';

describe('redisKeyPattern', () => {
  const on = (operator: string, value: unknown) =>
    redisKeyPattern([{ column: 'key', operator, value } as never]);

  it('reads "equals" as the glob it is given, and the word operators as what they say', () => {
    expect(on('eq', 'user:*')).toBe('user:*');
    expect(on('eq', 'user:42')).toBe('user:42');
    expect(on('contains', 'user')).toBe('*user*');
    expect(on('startsWith', 'user:')).toBe('user:*');
    expect(on('endsWith', ':draft')).toBe('*:draft');
  });

  it('is "every key" when there is nothing Redis could be asked', () => {
    expect(redisKeyPattern(undefined)).toBe('*');
    expect(redisKeyPattern([])).toBe('*');
    expect(
      redisKeyPattern([{ column: 'value', operator: 'eq', value: 'x' }]),
    ).toBe('*');
    expect(on('eq', '')).toBe('*');
    expect(on('eq', 42)).toBe('*');
    expect(on('gt', 'a')).toBe('*');
    expect(on('isNull', undefined)).toBe('*');
  });

  it('uses the first filter on the key', () => {
    expect(
      redisKeyPattern([
        { column: 'type', operator: 'eq', value: 'string' },
        { column: 'key', operator: 'startsWith', value: 'a' },
        { column: 'key', operator: 'startsWith', value: 'b' },
      ]),
    ).toBe('a*');
  });
});

describe('redisGlobMatch', () => {
  it('matches the way MATCH does', () => {
    expect(redisGlobMatch('*', 'anything at all')).toBe(true);
    expect(redisGlobMatch('user:*', 'user:42')).toBe(true);
    expect(redisGlobMatch('user:*', 'xuser:42')).toBe(false);
    expect(redisGlobMatch('*user*', 'xuser:42')).toBe(true);
    expect(redisGlobMatch('h?llo', 'hello')).toBe(true);
    expect(redisGlobMatch('h?llo', 'hllo')).toBe(false);
    expect(redisGlobMatch('h[ae]llo', 'hallo')).toBe(true);
    expect(redisGlobMatch('h[ae]llo', 'hillo')).toBe(false);
    expect(redisGlobMatch('h[^e]llo', 'hallo')).toBe(true);
    expect(redisGlobMatch('h[^e]llo', 'hello')).toBe(false);
    expect(redisGlobMatch('h[a-c]llo', 'hbllo')).toBe(true);
    expect(redisGlobMatch('user:42', 'user:42')).toBe(true);
    expect(redisGlobMatch('user:42', 'user:420')).toBe(false);
  });

  it('takes the characters a key may hold literally', () => {
    expect(redisGlobMatch('a.b', 'a.b')).toBe(true);
    expect(redisGlobMatch('a.b', 'axb')).toBe(false);
    expect(redisGlobMatch('price($)', 'price($)')).toBe(true);
    expect(redisGlobMatch('a\\*b', 'a*b')).toBe(true);
    expect(redisGlobMatch('a\\*b', 'axb')).toBe(false);
    expect(redisGlobMatch('a[b', 'a[b')).toBe(true);
    expect(redisGlobMatch('line*', 'line\nbreak')).toBe(true);
  });
});
