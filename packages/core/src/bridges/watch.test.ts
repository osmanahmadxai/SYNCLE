import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  emptyCursor,
  rowKey,
  watchQuery,
  type SnapshotStrategy,
  type TimestampStrategy,
  type WatchStrategy,
} from './watch';

const INC: WatchStrategy = { strategy: 'increment', column: 'id' };
const TS: TimestampStrategy = { strategy: 'timestamp', column: 'updated_at' };
const SNAP: SnapshotStrategy = { strategy: 'snapshot', maxTracked: 100 };

describe('increment strategy', () => {
  it('first poll fetches everything, ordered; later polls fetch only newer', () => {
    let cursor = emptyCursor(INC);
    expect(watchQuery(INC, cursor)).toEqual({
      filters: [],
      sort: [{ column: 'id', direction: 'asc' }],
    });

    const first = advanceCursor(INC, cursor, [{ id: 1 }, { id: 2 }, { id: 3 }], ['id']);
    expect(first.newRows.map((r) => r.id)).toEqual([1, 2, 3]);
    cursor = first.cursor;

    expect(watchQuery(INC, cursor)).toEqual({
      filters: [{ column: 'id', operator: 'gt', value: 3 }],
      sort: [{ column: 'id', direction: 'asc' }],
    });

    const second = advanceCursor(INC, cursor, [{ id: 4 }, { id: 5 }], ['id']);
    expect(second.newRows.map((r) => r.id)).toEqual([4, 5]);
    expect(second.cursor).toMatchObject({ value: 5 });
  });

  it('no new rows leaves the cursor put', () => {
    const cursor = { strategy: 'increment' as const, value: 9 };
    const r = advanceCursor(INC, cursor, [], ['id']);
    expect(r.newRows).toEqual([]);
    expect(r.cursor).toMatchObject({ value: 9 });
  });

  it('never overwrites the cursor with a NULL tracked value', () => {
    const cursor = { strategy: 'increment' as const, value: 9 };
    const r = advanceCursor(INC, cursor, [{ id: 10 }, { id: null }], ['id']);
    expect(r.newRows).toHaveLength(2);
    // advanced to the max NON-NULL value, not poisoned back to null
    expect(r.cursor).toMatchObject({ value: 10 });

    const allNull = advanceCursor(INC, r.cursor, [{ id: null }], ['id']);
    expect(allNull.cursor).toMatchObject({ value: 10 });
  });
});

describe('timestamp strategy', () => {
  it('dedupes rows sharing the boundary timestamp across polls', () => {
    let cursor = emptyCursor(TS);
    // poll 1: two rows at t1, one at t2
    const p1 = advanceCursor(
      TS,
      cursor,
      [
        { id: 1, updated_at: '2026-01-01T00:00:00Z' },
        { id: 2, updated_at: '2026-01-01T00:00:00Z' },
        { id: 3, updated_at: '2026-01-01T00:00:05Z' },
      ],
      ['id'],
    );
    expect(p1.newRows.map((r) => r.id)).toEqual([1, 2, 3]);
    cursor = p1.cursor;
    // cursor sits at t2 with id 3 as the boundary key
    expect(watchQuery(TS, cursor).filters).toEqual([
      { column: 'updated_at', operator: 'gte', value: '2026-01-01T00:00:05Z' },
    ]);

    // poll 2 re-fetches id 3 (>= boundary) plus a new id 4 at the same instant
    const p2 = advanceCursor(
      TS,
      cursor,
      [
        { id: 3, updated_at: '2026-01-01T00:00:05Z' },
        { id: 4, updated_at: '2026-01-01T00:00:05Z' },
      ],
      ['id'],
    );
    // id 3 already emitted, so only id 4 is new, both remembered as boundary
    expect(p2.newRows.map((r) => r.id)).toEqual([4]);
  });

  it('unions boundary keys when the timestamp does not advance', () => {
    const t1 = '2026-01-01T00:00:00Z';
    // poll 1 saw ids 1 and 2 at t1
    let cursor = advanceCursor(
      TS,
      emptyCursor(TS),
      [
        { id: 1, updated_at: t1 },
        { id: 2, updated_at: t1 },
      ],
      ['id'],
    ).cursor;

    // poll 2 sees only a NEW id 3 at the same t1 (e.g. paging split the set).
    // the earlier boundary keys must survive, not be replaced
    const p2 = advanceCursor(TS, cursor, [{ id: 3, updated_at: t1 }], ['id']);
    expect(p2.newRows.map((r) => r.id)).toEqual([3]);
    cursor = p2.cursor;

    // poll 3 re-fetches all three at t1 — nothing may be re-delivered
    const p3 = advanceCursor(
      TS,
      cursor,
      [
        { id: 1, updated_at: t1 },
        { id: 2, updated_at: t1 },
        { id: 3, updated_at: t1 },
      ],
      ['id'],
    );
    expect(p3.newRows).toEqual([]);
  });

  it('NULL tracked values never advance or reset the cursor', () => {
    const t1 = '2026-01-01T00:00:00Z';
    let cursor = advanceCursor(
      TS,
      emptyCursor(TS),
      [{ id: 1, updated_at: t1 }],
      ['id'],
    ).cursor;

    // a page whose max tracked value is NULL leaves the cursor untouched
    // (a null ts would look like a fresh watch and re-deliver the table)
    const r = advanceCursor(TS, cursor, [{ id: 2, updated_at: null }], ['id']);
    expect(r.newRows.map((x) => x.id)).toEqual([2]);
    expect(r.cursor).toMatchObject({ ts: t1 });
    cursor = r.cursor;

    // a mixed page advances to the max NON-NULL timestamp
    const t2 = '2026-01-01T00:00:05Z';
    const mixed = advanceCursor(
      TS,
      cursor,
      [
        { id: 3, updated_at: null },
        { id: 4, updated_at: t2 },
      ],
      ['id'],
    );
    expect(mixed.cursor).toMatchObject({ ts: t2 });
  });

  it('adds primary-key tiebreakers to the sort when pk is provided', () => {
    expect(watchQuery(TS, emptyCursor(TS), ['id']).sort).toEqual([
      { column: 'updated_at', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
    // the tracked column itself is never duplicated as a tiebreaker
    expect(watchQuery(TS, emptyCursor(TS), ['updated_at']).sort).toEqual([
      { column: 'updated_at', direction: 'asc' },
    ]);
  });

  it('accepts Date values and serializes the cursor as an ISO string', () => {
    const cursor = emptyCursor(TS);
    const r = advanceCursor(
      TS,
      cursor,
      [{ id: 1, updated_at: new Date('2026-03-04T10:00:00Z') }],
      ['id'],
    );
    expect(r.cursor).toMatchObject({ ts: '2026-03-04T10:00:00.000Z' });
  });
});

describe('snapshot strategy', () => {
  it('orders the scan by primary key when provided (deterministic page)', () => {
    expect(watchQuery(SNAP, emptyCursor(SNAP)).sort).toEqual([]);
    expect(watchQuery(SNAP, emptyCursor(SNAP), ['id']).sort).toEqual([
      { column: 'id', direction: 'asc' },
    ]);
  });

  it('emits only previously-unseen primary keys', () => {
    let cursor = emptyCursor(SNAP);
    const p1 = advanceCursor(SNAP, cursor, [{ id: 'a' }, { id: 'b' }], ['id']);
    expect(p1.newRows.map((r) => r.id)).toEqual(['a', 'b']);
    cursor = p1.cursor;

    const p2 = advanceCursor(SNAP, cursor, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['id']);
    expect(p2.newRows.map((r) => r.id)).toEqual(['c']);
  });

  it('bounds the tracked-key set', () => {
    const strat: SnapshotStrategy = { strategy: 'snapshot', maxTracked: 3 };
    let cursor = emptyCursor(strat);
    cursor = advanceCursor(strat, cursor, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], ['id']).cursor;
    expect((cursor as { seen: string[] }).seen.length).toBe(3);
  });
});

describe('rowKey', () => {
  it('is stable for the same primary key values', () => {
    expect(rowKey({ id: 1, x: 9 }, ['id'])).toBe(rowKey({ id: 1, x: 7 }, ['id']));
    expect(rowKey({ id: 1 }, ['id'])).not.toBe(rowKey({ id: 2 }, ['id']));
  });
});

describe('timestamp lookback window', () => {
  const TSL: TimestampStrategy = {
    strategy: 'timestamp',
    column: 'updated_at',
    lookbackMs: 5000,
  };

  it('queries a window behind the cursor instead of the exact boundary', () => {
    const cursor = {
      strategy: 'timestamp' as const,
      ts: '2026-01-01T00:00:10.000Z',
      boundaryKeys: [],
    };
    const q = watchQuery(TSL, cursor, ['id']);
    expect(q.filters).toEqual([
      { column: 'updated_at', operator: 'gte', value: '2026-01-01T00:00:05.000Z' },
    ]);
    // numeric cursors stay numeric
    const qn = watchQuery(TSL, { ...cursor, ts: 10_000 }, ['id']);
    expect(qn.filters[0]!.value).toBe(5000);
  });

  it('keys every row inside the window so the overlap re-fetch dedupes', () => {
    const rows = [
      { id: 1, updated_at: '2026-01-01T00:00:06.000Z' },
      { id: 2, updated_at: '2026-01-01T00:00:09.000Z' },
      { id: 3, updated_at: '2026-01-01T00:00:10.000Z' },
    ];
    const first = advanceCursor(TSL, emptyCursor(TSL), rows, ['id']);
    expect(first.newRows).toHaveLength(3);
    // all three rows fall within 5s of the max — all are remembered
    expect(
      (first.cursor as { boundaryKeys: string[] }).boundaryKeys,
    ).toHaveLength(3);

    // the next poll re-fetches the window; nothing re-emits, and a genuinely
    // late-committing row that appeared inside the window IS emitted
    const late = { id: 4, updated_at: '2026-01-01T00:00:07.000Z' };
    const second = advanceCursor(TSL, first.cursor, [...rows, late], ['id']);
    expect(second.newRows.map((r) => r.id)).toEqual([4]);
  });

  it('never moves the cursor backwards through already-seen window rows', () => {
    // a page can consist purely of window rows BEHIND the cursor (e.g. a burst
    // denser than one page): the cursor must hold its ground and keep its keys
    const t9 = '2026-01-01T00:00:09.000Z';
    const t10 = '2026-01-01T00:00:10.000Z';
    const first = advanceCursor(
      TSL,
      emptyCursor(TSL),
      [
        { id: 1, updated_at: t9 },
        { id: 2, updated_at: t10 },
      ],
      ['id'],
    );
    const replay = advanceCursor(TSL, first.cursor, [{ id: 1, updated_at: t9 }], ['id']);
    expect(replay.newRows).toEqual([]);
    expect(replay.cursor).toMatchObject({ ts: t10 });
    // ...and the full-window re-fetch afterwards still re-emits nothing
    const refetch = advanceCursor(
      TSL,
      replay.cursor,
      [
        { id: 1, updated_at: t9 },
        { id: 2, updated_at: t10 },
      ],
      ['id'],
    );
    expect(refetch.newRows).toEqual([]);
  });

  it('keeps window keys a truncated page did not re-fetch', () => {
    // poll 1 emitted ids 1+2; poll 2's page held only the newest row (the rest
    // was cut off by the page limit). the keys for 1+2 are still inside the
    // window and must survive the advance, or the next overlap re-fetch would
    // re-deliver both rows
    const first = advanceCursor(
      TSL,
      emptyCursor(TSL),
      [
        { id: 1, updated_at: '2026-01-01T00:00:06.000Z' },
        { id: 2, updated_at: '2026-01-01T00:00:09.000Z' },
      ],
      ['id'],
    );
    const second = advanceCursor(
      TSL,
      first.cursor,
      [{ id: 3, updated_at: '2026-01-01T00:00:10.000Z' }],
      ['id'],
    );
    expect(second.newRows.map((r) => r.id)).toEqual([3]);

    const third = advanceCursor(
      TSL,
      second.cursor,
      [
        { id: 1, updated_at: '2026-01-01T00:00:06.000Z' },
        { id: 2, updated_at: '2026-01-01T00:00:09.000Z' },
        { id: 3, updated_at: '2026-01-01T00:00:10.000Z' },
      ],
      ['id'],
    );
    expect(third.newRows).toEqual([]);
  });

  it('without lookback only exact-boundary rows are keyed (legacy behavior)', () => {
    const rows = [
      { id: 1, updated_at: '2026-01-01T00:00:06.000Z' },
      { id: 2, updated_at: '2026-01-01T00:00:10.000Z' },
    ];
    const r = advanceCursor(TS, emptyCursor(TS), rows, ['id']);
    expect((r.cursor as { boundaryKeys: string[] }).boundaryKeys).toHaveLength(1);
  });
});

describe('cursor column stamping', () => {
  it('cursors carry the column they were read from', () => {
    expect(emptyCursor(INC)).toMatchObject({ column: 'id' });
    expect(emptyCursor(TS)).toMatchObject({ column: 'updated_at' });
    const adv = advanceCursor(INC, emptyCursor(INC), [{ id: 7 }], ['id']);
    expect(adv.cursor).toMatchObject({ column: 'id' });
    const advTs = advanceCursor(
      TS,
      emptyCursor(TS),
      [{ id: 1, updated_at: 100 }],
      ['id'],
    );
    expect(advTs.cursor).toMatchObject({ column: 'updated_at' });
  });
});

describe('watchQuery determinism', () => {
  it('timestamp polls tiebreak on the primary key', () => {
    const q = watchQuery(TS, emptyCursor(TS), ['id']);
    expect(q.sort).toEqual([
      { column: 'updated_at', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  it('snapshot scans order by the primary key', () => {
    const q = watchQuery(SNAP, emptyCursor(SNAP), ['a', 'b']);
    expect(q.sort).toEqual([
      { column: 'a', direction: 'asc' },
      { column: 'b', direction: 'asc' },
    ]);
  });
});
