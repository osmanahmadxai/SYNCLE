import { describe, expect, it } from 'vitest';
import type { FilterSpec } from '@syncle/core';
import { rowMatchesFilters } from './filter-match';

const f = (column: string, operator: FilterSpec['operator'], value?: unknown): FilterSpec => ({
  column,
  operator,
  value,
});

describe('rowMatchesFilters', () => {
  it('an empty or missing filter list matches every row', () => {
    expect(rowMatchesFilters({ a: 1 }, undefined)).toBe(true);
    expect(rowMatchesFilters({ a: 1 }, [])).toBe(true);
  });

  it('filters AND together', () => {
    const filters = [f('status', 'eq', 'active'), f('amount', 'gt', 10)];
    expect(rowMatchesFilters({ status: 'active', amount: 11 }, filters)).toBe(true);
    expect(rowMatchesFilters({ status: 'active', amount: 10 }, filters)).toBe(false);
    expect(rowMatchesFilters({ status: 'archived', amount: 11 }, filters)).toBe(false);
  });

  describe('eq / neq', () => {
    it('compares numeric-looking strings numerically (pgoutput sends text)', () => {
      expect(rowMatchesFilters({ id: '42' }, [f('id', 'eq', 42)])).toBe(true);
      expect(rowMatchesFilters({ id: 42 }, [f('id', 'eq', '42')])).toBe(true);
      expect(rowMatchesFilters({ id: 41 }, [f('id', 'eq', 42)])).toBe(false);
    });

    it('string equality is case-sensitive, like SQL =', () => {
      expect(rowMatchesFilters({ s: 'Ab' }, [f('s', 'eq', 'ab')])).toBe(false);
      expect(rowMatchesFilters({ s: 'ab' }, [f('s', 'eq', 'ab')])).toBe(true);
    });

    it('booleans match 0/1 row values (MySQL tinyint booleans)', () => {
      expect(rowMatchesFilters({ ok: 1 }, [f('ok', 'eq', true)])).toBe(true);
      expect(rowMatchesFilters({ ok: 0 }, [f('ok', 'eq', false)])).toBe(true);
    });

    it('NULL never matches a comparison, including neq (SQL three-valued logic)', () => {
      expect(rowMatchesFilters({ v: null }, [f('v', 'eq', 'x')])).toBe(false);
      expect(rowMatchesFilters({ v: null }, [f('v', 'neq', 'x')])).toBe(false);
      expect(rowMatchesFilters({}, [f('v', 'neq', 'x')])).toBe(false);
      expect(rowMatchesFilters({ v: 'y' }, [f('v', 'neq', 'x')])).toBe(true);
    });
  });

  describe('ordering operators', () => {
    it('lt/lte/gt/gte compare numbers, numeric strings included', () => {
      expect(rowMatchesFilters({ n: '9' }, [f('n', 'lt', 10)])).toBe(true);
      expect(rowMatchesFilters({ n: 10 }, [f('n', 'lte', '10')])).toBe(true);
      expect(rowMatchesFilters({ n: 11 }, [f('n', 'gt', 10)])).toBe(true);
      expect(rowMatchesFilters({ n: 9 }, [f('n', 'gte', 10)])).toBe(false);
      // numeric compare, NOT the lexicographic '9' > '10'
      expect(rowMatchesFilters({ n: '9' }, [f('n', 'gt', '10')])).toBe(false);
    });

    it('compares Date row values against ISO strings by instant', () => {
      const row = { at: new Date('2026-01-02T00:00:00Z') };
      expect(rowMatchesFilters(row, [f('at', 'gt', '2026-01-01')])).toBe(true);
      expect(rowMatchesFilters(row, [f('at', 'lt', '2026-01-01')])).toBe(false);
    });

    it('null is incomparable', () => {
      expect(rowMatchesFilters({ n: null }, [f('n', 'lt', 10)])).toBe(false);
      expect(rowMatchesFilters({ n: 5 }, [f('n', 'lt', null)])).toBe(false);
    });
  });

  describe('LIKE-style operators', () => {
    it('contains/startsWith/endsWith are case-insensitive, like ILIKE', () => {
      expect(rowMatchesFilters({ s: 'Hello World' }, [f('s', 'contains', 'o w')])).toBe(true);
      expect(rowMatchesFilters({ s: 'Hello World' }, [f('s', 'startsWith', 'hell')])).toBe(true);
      expect(rowMatchesFilters({ s: 'Hello World' }, [f('s', 'endsWith', 'WORLD')])).toBe(true);
      expect(rowMatchesFilters({ s: 'Hello World' }, [f('s', 'contains', 'mars')])).toBe(false);
    });

    it('stringifies non-string row values, and NULL never matches', () => {
      expect(rowMatchesFilters({ n: 12345 }, [f('n', 'contains', '234')])).toBe(true);
      expect(rowMatchesFilters({ n: null }, [f('n', 'contains', '')])).toBe(false);
    });
  });

  describe('isNull / notNull / in', () => {
    it('isNull sees null AND a missing column; notNull is the inverse', () => {
      expect(rowMatchesFilters({ v: null }, [f('v', 'isNull')])).toBe(true);
      expect(rowMatchesFilters({}, [f('v', 'isNull')])).toBe(true);
      expect(rowMatchesFilters({ v: 0 }, [f('v', 'isNull')])).toBe(false);
      expect(rowMatchesFilters({ v: 0 }, [f('v', 'notNull')])).toBe(true);
      expect(rowMatchesFilters({ v: null }, [f('v', 'notNull')])).toBe(false);
    });

    it('in matches any listed value; empty or non-array matches nothing', () => {
      expect(rowMatchesFilters({ v: 'b' }, [f('v', 'in', ['a', 'b'])])).toBe(true);
      expect(rowMatchesFilters({ v: '2' }, [f('v', 'in', [1, 2])])).toBe(true);
      expect(rowMatchesFilters({ v: 'c' }, [f('v', 'in', ['a', 'b'])])).toBe(false);
      expect(rowMatchesFilters({ v: 'c' }, [f('v', 'in', [])])).toBe(false);
      expect(rowMatchesFilters({ v: 'c' }, [f('v', 'in', 'c')])).toBe(false);
    });
  });

  describe('partial delete images', () => {
    const filters = [f('status', 'eq', 'active')];

    it('a missing column fails by default (SQL NULL semantics)', () => {
      expect(rowMatchesFilters({ id: 7 }, filters)).toBe(false);
    });

    it('passMissingColumns lets a key-only delete image through', () => {
      expect(rowMatchesFilters({ id: 7 }, filters, { passMissingColumns: true })).toBe(true);
      // but a PRESENT column still has to match
      expect(
        rowMatchesFilters({ id: 7, status: 'archived' }, filters, { passMissingColumns: true }),
      ).toBe(false);
    });
  });
});
