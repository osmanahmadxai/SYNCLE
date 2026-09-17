import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  type BrowseParams,
  type BrowseResult,
} from '@syncle/core';
import type { AdapterPoolService } from '../connections/adapter-pool.service';
import type { ResolvedBridge } from './bridges.types';
import {
  CURSOR_COLUMN,
  TableReaderService,
  type TableRow,
} from './table-reader.service';

type Row = Record<string, unknown>;

/** a table behind a fake adapter that pages it the way a SQL engine would */
function sqlTable(rows: Row[], primaryKey: string[]) {
  const calls: BrowseParams[] = [];
  const adapter = {
    capabilities: {},
    browse: async (p: BrowseParams): Promise<BrowseResult> => {
      calls.push(p);
      let out = [...rows];
      for (const f of p.filters ?? []) {
        if (f.operator === 'gt')
          out = out.filter(
            (r) => (r[f.column] as number) > (f.value as number),
          );
        if (f.operator === 'eq')
          out = out.filter((r) => r[f.column] === f.value);
      }
      for (const s of [...(p.sort ?? [])].reverse()) {
        out.sort(
          (a, b) =>
            ((a[s.column] as number) - (b[s.column] as number)) *
            (s.direction === 'asc' ? 1 : -1),
        );
      }
      const page = out.slice(p.offset, p.offset + p.limit);
      return {
        columns: [],
        rows: page,
        rowCount: page.length,
        executionMs: 0,
        total: out.length,
        hasMore: out.length > p.offset + p.limit,
        primaryKey,
      } as unknown as BrowseResult;
    },
  };
  return { calls, adapter };
}

/** a keyspace behind a fake adapter that pages it by cursor, the way the Redis adapter does */
function scanned(
  pages: Array<{ rows: Row[]; next: string | null }>,
  starts: string[],
) {
  const calls: BrowseParams[] = [];
  const adapter = {
    capabilities: { cursorPaging: true },
    browse: async (p: BrowseParams): Promise<BrowseResult> => {
      calls.push(p);
      const base = {
        columns: [],
        executionMs: 0,
        total: 99,
        primaryKey: ['key'],
      };
      if (p.cursor === undefined) {
        return {
          ...base,
          rows: pages[0]!.rows.slice(0, 1),
          rowCount: 1,
          hasMore: true,
        } as unknown as BrowseResult;
      }
      const page = pages[starts.indexOf(p.cursor)]!;
      return {
        ...base,
        rows: page.rows,
        rowCount: page.rows.length,
        hasMore: page.next !== null,
        nextCursor: page.next,
      } as unknown as BrowseResult;
    },
  };
  return { calls, adapter };
}

const reader = (adapter: unknown) =>
  new TableReaderService({
    withAdapter: async (
      _id: string,
      _db: string | undefined,
      fn: (a: unknown) => unknown,
    ) => fn(adapter),
  } as unknown as AdapterPoolService);

const bridgeOf = (
  source: Record<string, unknown> = {},
  pageSize = 2,
): ResolvedBridge =>
  ({
    source: { kind: 'table', connectionId: 'c1', table: 't', ...source },
    delivery: { pageSize },
  }) as unknown as ResolvedBridge;

async function all(gen: AsyncGenerator<TableRow>): Promise<TableRow[]> {
  const out: TableRow[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const FIVE = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];

describe('a table with a single-column key', () => {
  it('is read by `key > last`, a page at a time, never by OFFSET', async () => {
    const { adapter, calls } = sqlTable(FIVE, ['id']);
    const items = await all(
      reader(adapter).rows(bridgeOf(), { startOffset: 0, resumeKey: null }),
    );
    expect(items.map((i) => [i.index, i.row.id, i.keyset])).toEqual(
      FIVE.map((r, i) => [i, r.id, { column: 'id', value: r.id }]),
    );
    const pages = calls.slice(1); // the first call is the probe
    expect(pages.every((p) => p.offset === 0)).toBe(true);
    expect(pages.map((p) => p.filters)).toEqual([
      [],
      [{ column: 'id', operator: 'gt', value: 2 }],
      [{ column: 'id', operator: 'gt', value: 4 }],
    ]);
  });

  it('resumes at the checkpointed key, exactly — whatever was added or removed before it', async () => {
    const { adapter, calls } = sqlTable(FIVE, ['id']);
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 3,
        resumeKey: { column: 'id', value: 3 },
      }),
    );
    expect(items.map((i) => [i.index, i.row.id])).toEqual([
      [3, 4],
      [4, 5],
    ]);
    // no seek query: straight to `id > 3`
    expect(calls[1]!.filters).toEqual([
      { column: 'id', operator: 'gt', value: 3 },
    ]);
  });

  it('with an offset but no usable checkpoint, seeks the last delivered row’s key first', async () => {
    const { adapter, calls } = sqlTable(FIVE, ['id']);
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 2,
        resumeKey: { column: 'other', value: 'x' },
      }),
    );
    expect(items.map((i) => i.row.id)).toEqual([3, 4, 5]);
    expect(calls[1]).toMatchObject({ limit: 1, offset: 1 });
  });

  it('keeps the bridge’s own filters on every page', async () => {
    const rows = FIVE.map((r) => ({ ...r, kind: r.id % 2 ? 'odd' : 'even' }));
    const { adapter, calls } = sqlTable(rows, ['id']);
    const filters = [{ column: 'kind', operator: 'eq', value: 'odd' }];
    const items = await all(
      reader(adapter).rows(bridgeOf({ filters }, 1), {
        startOffset: 0,
        resumeKey: null,
      }),
    );
    expect(items.map((i) => i.row.id)).toEqual([1, 3, 5]);
    expect(calls.every((c) => c.filters?.[0]?.column === 'kind')).toBe(true);
  });
});

describe('a table that cannot be keyset-paginated', () => {
  it('(a composite key) is read by OFFSET, in key order, and resumes by offset', async () => {
    const rows = [
      { a: 1, b: 1 },
      { a: 1, b: 2 },
      { a: 2, b: 1 },
    ];
    const { adapter, calls } = sqlTable(rows, ['a', 'b']);
    const items = await all(
      reader(adapter).rows(bridgeOf(), { startOffset: 1, resumeKey: null }),
    );
    expect(items.map((i) => [i.index, i.row, i.keyset])).toEqual([
      [1, { a: 1, b: 2 }, undefined],
      [2, { a: 2, b: 1 }, undefined],
    ]);
    expect(calls[1]).toMatchObject({
      offset: 1,
      sort: [
        { column: 'a', direction: 'asc' },
        { column: 'b', direction: 'asc' },
      ],
    });
  });

  it('(a sort of the bridge’s own that is not the key) likewise', async () => {
    const { adapter, calls } = sqlTable(FIVE, ['id']);
    const sort = [{ column: 'id', direction: 'desc' }];
    const items = await all(
      reader(adapter).rows(bridgeOf({ sort }), {
        startOffset: 0,
        resumeKey: null,
      }),
    );
    expect(items.map((i) => i.row.id)).toEqual([5, 4, 3, 2, 1]);
    expect(calls.slice(1).map((c) => c.offset)).toEqual([0, 2, 4]);
  });

  it('(no key, no sort) is refused: pages without an order skip and repeat rows', async () => {
    const { adapter } = sqlTable(FIVE, []);
    await expect(
      reader(adapter).resolveOrder(bridgeOf()),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('an engine that pages by its own cursor (Redis)', () => {
  const PAGES = [
    { rows: [{ key: 'a' }, { key: 'b' }], next: '17' },
    // a sparse MATCH: nothing here, and yet not the end
    { rows: [], next: '42' },
    {
      rows: [
        { key: 'bull:bridge-jobs:7' },
        { key: 'c' },
        { key: 'syncle:cdc:spool:x' },
      ],
      next: null,
    },
  ];
  const STARTS = ['0', '17', '42'];

  it('follows the cursor to its end: an empty page is not the end, and no `key > last` is ever asked', async () => {
    const { adapter, calls } = scanned(PAGES, STARTS);
    const filters = [{ column: 'key', operator: 'contains', value: 'user:' }];
    const items = await all(
      reader(adapter).rows(bridgeOf({ filters }), {
        startOffset: 0,
        resumeKey: null,
      }),
    );

    // Syncle's own queue and spool keys are not the user's data
    expect(items.map((i) => [i.index, i.row.key])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
    expect(calls.slice(1).map((c) => c.cursor)).toEqual(['0', '17', '42']);
    // the glob the user asked for, and nothing the reader added to it
    expect(
      calls
        .slice(1)
        .every((c) => JSON.stringify(c.filters) === JSON.stringify(filters)),
    ).toBe(true);
  });

  it('checkpoints the cursor of the PAGE a row came in, and resumes by reading that page again', async () => {
    const { adapter, calls } = scanned(PAGES, STARTS);
    const first = await all(
      reader(adapter).rows(bridgeOf(), { startOffset: 0, resumeKey: null }),
    );
    expect(first.map((i) => i.keyset)).toEqual([
      { column: CURSOR_COLUMN, value: '0' },
      { column: CURSOR_COLUMN, value: '0' },
      { column: CURSOR_COLUMN, value: '42' },
    ]);

    calls.length = 0;
    // stopped after `c` (3 rows delivered): page '42' is read again, and `c` with it
    const again = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 3,
        resumeKey: { column: CURSOR_COLUMN, value: '42' },
      }),
    );
    // under a NEW position — a row is never skipped on the strength of a count,
    // because the same cursor need not hand back the same keys
    expect(again.map((i) => [i.index, i.row.key])).toEqual([[3, 'c']]);
    expect(calls.slice(1).map((c) => c.cursor)).toEqual(['42']);
  });

  it('with no cursor to resume by (an older job), starts over rather than guess', async () => {
    const { adapter, calls } = scanned(PAGES, STARTS);
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 2,
        resumeKey: { column: 'key', value: 'b' },
      }),
    );
    expect(items.map((i) => [i.index, i.row.key])).toEqual([
      [2, 'a'],
      [3, 'b'],
      [4, 'c'],
    ]);
    expect(calls[1]!.cursor).toBe('0');
  });

  it('keeps an order the bridge asks for — paged by OFFSET, never by a key read back from a row', async () => {
    const { adapter, calls } = scanned(PAGES, STARTS);
    adapter.browse = async (p: BrowseParams) => {
      calls.push(p);
      const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }].slice(
        p.offset,
        p.offset + p.limit,
      );
      return {
        columns: [],
        rows,
        rowCount: rows.length,
        executionMs: 0,
        total: 3,
        hasMore: p.offset + p.limit < 3,
        primaryKey: ['key'],
      } as unknown as BrowseResult;
    };
    const sort = [{ column: 'value', direction: 'desc' }];
    const order = await reader(adapter).resolveOrder(bridgeOf({ sort }));
    expect(order).toEqual({ sort, total: 3, keysetColumn: null });
    const items = await all(
      reader(adapter).rows(bridgeOf({ sort }), {
        startOffset: 0,
        resumeKey: null,
      }),
    );
    expect(items.map((i) => i.row.key)).toEqual(['a', 'b', 'c']);
    expect(
      calls
        .slice(1)
        .every((c) => c.cursor === undefined && (c.filters ?? []).length === 0),
    ).toBe(true);
    expect(calls.slice(2).map((c) => c.offset)).toEqual([0, 2]);
  });

  it('…but "by the key, ascending" is the engine’s own order: what the builder always sends', async () => {
    const { adapter } = scanned(PAGES, STARTS);
    const sort = [{ column: 'key', direction: 'asc' }];
    expect(
      (await reader(adapter).resolveOrder(bridgeOf({ sort }))).cursorPaging,
    ).toBe(true);
  });

  it('needs no key and no sort', async () => {
    const { adapter } = scanned(PAGES, STARTS);
    expect(await reader(adapter).resolveOrder(bridgeOf())).toEqual({
      sort: [],
      total: 99,
      keysetColumn: 'key',
      cursorPaging: true,
    });
  });
});
