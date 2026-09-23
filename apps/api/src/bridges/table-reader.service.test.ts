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

/** what the fake engine says of its table, when asked (see `getSchema`) */
interface Shape {
  /** the columns, in table order; default: those of the first row */
  columns?: Array<{ name: string; dataType?: string; nullable?: boolean }>;
  /** unique indexes besides the primary key */
  unique?: string[][];
  /** the engine can page after a tuple (see `BrowseParams.after`) */
  keyset?: boolean;
  /** the engine cannot say what it holds */
  noSchema?: boolean;
}

const cmp = (a: unknown, b: unknown): number =>
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b));

/** a table behind a fake adapter that pages it the way a SQL engine would */
function sqlTable(rows: Row[], primaryKey: string[], shape: Shape = {}) {
  const calls: BrowseParams[] = [];
  const columns: NonNullable<Shape['columns']> =
    shape.columns ??
    Object.keys(rows[0] ?? {}).map((name) => ({ name, nullable: true }));
  const adapter = {
    capabilities: shape.keyset ? { keysetPaging: true } : {},
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
      const sort = p.sort ?? [];
      for (const s of [...sort].reverse()) {
        out.sort(
          (a, b) =>
            cmp(a[s.column], b[s.column]) * (s.direction === 'asc' ? 1 : -1),
        );
      }
      if (p.after) {
        // the rows after the tuple, in the sort's order — what the SQL does
        const dirs = sort.map((x) => x.direction);
        if (sort.map((x) => x.column).join() !== p.after.columns.join())
          throw new BadRequestError('the tuple is not the sort');
        out = out.filter((r) => {
          for (let i = 0; i < p.after!.columns.length; i++) {
            const c = cmp(r[p.after!.columns[i]!], p.after!.values[i]);
            if (c === 0) continue;
            return dirs[i] === 'asc' ? c > 0 : c < 0;
          }
          return false;
        });
      }
      const offset = p.after ? 0 : p.offset;
      const page = out.slice(offset, offset + p.limit);
      return {
        columns: columns.map((c) => ({
          name: c.name,
          dataType: c.dataType ?? 'integer',
        })),
        rows: page,
        rowCount: page.length,
        executionMs: 0,
        total: out.length,
        hasMore: out.length > offset + p.limit,
        primaryKey,
      } as unknown as BrowseResult;
    },
    getSchema: async () => {
      if (shape.noSchema) throw new Error('no catalog here');
      const indexes = [
        ...(primaryKey.length
          ? [{ name: 'pk', columns: primaryKey, unique: true }]
          : []),
        ...(shape.unique ?? []).map((cols, i) => ({
          name: `u${i}`,
          columns: cols,
          unique: true,
        })),
      ];
      return {
        namespaces: [
          {
            name: 'main',
            tables: [
              {
                name: 't',
                columns: columns.map((c) => ({
                  name: c.name,
                  dataType: c.dataType ?? 'integer',
                  nullable: c.nullable ?? true,
                })),
                indexes,
                primaryKey,
              },
            ],
          },
        ],
      };
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
  it('(a composite key, on an engine that cannot page after a tuple) is read by OFFSET, in key order, and resumes by offset', async () => {
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

  it('(no key, no sort, and no column that can be ordered) is refused: pages without an order skip and repeat rows', async () => {
    const { adapter } = sqlTable([{ doc: {} }], [], {
      columns: [{ name: 'doc', dataType: 'json' }],
    });
    await expect(
      reader(adapter).resolveOrder(bridgeOf()),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

const NOT_NULL = (...names: string[]) =>
  names.map((name) => ({ name, nullable: false }));

describe('an engine that pages after a tuple', () => {
  const GRID = [
    { a: 1, b: 1, n: 'x' },
    { a: 1, b: 2, n: 'y' },
    { a: 2, b: 1, n: 'z' },
    { a: 2, b: 2, n: 'w' },
    { a: 3, b: 1, n: 'v' },
  ];

  it('reads a composite key after the last row’s tuple, never by OFFSET, and checkpoints the tuple', async () => {
    const { adapter, calls } = sqlTable(GRID, ['a', 'b'], {
      keyset: true,
      columns: [...NOT_NULL('a', 'b'), { name: 'n' }],
    });
    const items = await all(
      reader(adapter).rows(bridgeOf(), { startOffset: 0, resumeKey: null }),
    );
    expect(items.map((i) => [i.index, i.row.n, i.keyset])).toEqual([
      [0, 'x', { column: 'a,b', value: [1, 1] }],
      [1, 'y', { column: 'a,b', value: [1, 2] }],
      [2, 'z', { column: 'a,b', value: [2, 1] }],
      [3, 'w', { column: 'a,b', value: [2, 2] }],
      [4, 'v', { column: 'a,b', value: [3, 1] }],
    ]);
    const pages = calls.filter((c) => c.limit === 2);
    expect(pages.map((p) => p.after)).toEqual([
      undefined,
      { columns: ['a', 'b'], values: [1, 2] },
      { columns: ['a', 'b'], values: [2, 2] },
    ]);
    expect(pages.every((p) => p.offset === 0)).toBe(true);
    expect(pages[0]!.sort).toEqual([
      { column: 'a', direction: 'asc' },
      { column: 'b', direction: 'asc' },
    ]);
  });

  it('resumes at the checkpointed tuple exactly, with no seek', async () => {
    const { adapter, calls } = sqlTable(GRID, ['a', 'b'], {
      keyset: true,
      columns: NOT_NULL('a', 'b', 'n'),
    });
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 3,
        resumeKey: { column: 'a,b', value: [2, 2] },
      }),
    );
    expect(items.map((i) => [i.index, i.row.n])).toEqual([[3, 'v']]);
    expect(calls[1]).toMatchObject({
      offset: 0,
      after: { columns: ['a', 'b'], values: [2, 2] },
    });
  });

  it('with an offset but a checkpoint of another shape (an older run), seeks the last delivered row once, by offset', async () => {
    const { adapter, calls } = sqlTable(GRID, ['a', 'b'], {
      keyset: true,
      columns: NOT_NULL('a', 'b', 'n'),
    });
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 2,
        resumeKey: { column: 'a', value: 1 },
      }),
    );
    expect(items.map((i) => i.row.n)).toEqual(['z', 'w', 'v']);
    expect(calls[1]).toMatchObject({ limit: 1, offset: 1 });
    expect(calls[1]!.after).toBeUndefined();
    expect(calls[2]).toMatchObject({
      after: { columns: ['a', 'b'], values: [1, 2] },
    });
  });

  it('keeps a single-column key on the filter it always used (older checkpoints stay good)', async () => {
    const { adapter, calls } = sqlTable(FIVE, ['id'], {
      keyset: true,
      columns: NOT_NULL('id'),
    });
    const items = await all(
      reader(adapter).rows(bridgeOf(), { startOffset: 0, resumeKey: null }),
    );
    expect(items.map((i) => i.keyset)).toEqual(
      FIVE.map((r) => ({ column: 'id', value: r.id })),
    );
    expect(calls.slice(1).every((c) => c.after === undefined)).toBe(true);
    expect(calls[2]!.filters).toEqual([
      { column: 'id', operator: 'gt', value: 2 },
    ]);
  });

  it('a sort of the bridge’s own gets the key appended, and is paged after the tuple too', async () => {
    const { adapter, calls } = sqlTable(GRID, ['a', 'b'], {
      keyset: true,
      columns: NOT_NULL('a', 'b', 'n'),
    });
    const sort = [{ column: 'n', direction: 'desc' as const }];
    const order = await reader(adapter).resolveOrder(bridgeOf({ sort }));
    expect(order).toEqual({
      sort: [
        { column: 'n', direction: 'desc' },
        { column: 'a', direction: 'asc' },
        { column: 'b', direction: 'asc' },
      ],
      total: 5,
      keysetColumn: null,
      keysetColumns: ['n', 'a', 'b'],
    });
    const items = await all(
      reader(adapter).rows(bridgeOf({ sort }), {
        startOffset: 0,
        resumeKey: null,
        order,
      }),
    );
    expect(items.map((i) => i.row.n)).toEqual(['z', 'y', 'x', 'w', 'v']);
    expect(items[1]!.keyset).toEqual({ column: 'n,a,b', value: ['y', 1, 2] });
    expect(calls.slice(1).every((c) => c.offset === 0)).toBe(true);
  });

  it('…sorted by a column that can be NULL, it is read by OFFSET, as before: a NULL is neither before nor after', async () => {
    const { adapter, calls } = sqlTable(GRID, ['a', 'b'], {
      keyset: true,
      columns: [...NOT_NULL('a', 'b'), { name: 'n', nullable: true }],
    });
    const sort = [{ column: 'n', direction: 'asc' as const }];
    const order = await reader(adapter).resolveOrder(bridgeOf({ sort }));
    expect(order).toEqual({ sort, total: 5, keysetColumn: null });
    await all(
      reader(adapter).rows(bridgeOf({ sort }), {
        startOffset: 0,
        resumeKey: null,
        order,
      }),
    );
    expect(calls.slice(1).map((c) => c.offset)).toEqual([0, 2, 4]);
  });

  it('a sort the bridge asks for that already IS the key is not doubled', async () => {
    const { adapter } = sqlTable(GRID, ['a', 'b'], {
      keyset: true,
      columns: NOT_NULL('a', 'b', 'n'),
    });
    const sort = [
      { column: 'b', direction: 'desc' as const },
      { column: 'a', direction: 'asc' as const },
    ];
    expect(
      (await reader(adapter).resolveOrder(bridgeOf({ sort }))).keysetColumns,
    ).toEqual(['b', 'a']);
  });
});

describe('a table with no primary key', () => {
  const ROWS = [
    { code: 'b', kind: 2, doc: { x: 1 } },
    { code: 'a', kind: 1, doc: null },
    { code: 'c', kind: 1, doc: null },
  ];

  it('is keyed by a unique index whose columns cannot be NULL', async () => {
    const { adapter, calls } = sqlTable(ROWS, [], {
      keyset: true,
      columns: [
        ...NOT_NULL('code'),
        { name: 'kind' },
        { name: 'doc', dataType: 'json' },
      ],
      unique: [['kind'], ['code']],
    });
    const order = await reader(adapter).resolveOrder(bridgeOf());
    // `kind` can be NULL, so it is not `code`'s equal
    expect(order).toEqual({
      sort: [{ column: 'code', direction: 'asc' }],
      total: 3,
      keysetColumn: 'code',
    });
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 0,
        resumeKey: null,
        order,
      }),
    );
    expect(items.map((i) => i.row.code)).toEqual(['a', 'b', 'c']);
    expect(calls[2]!.filters).toEqual([
      { column: 'code', operator: 'gt', value: 'b' },
    ]);
  });

  it('…of several columns, likewise, after the tuple', async () => {
    const { adapter } = sqlTable(ROWS, [], {
      keyset: true,
      columns: [...NOT_NULL('code', 'kind'), { name: 'doc', dataType: 'json' }],
      unique: [['kind', 'code']],
    });
    expect(await reader(adapter).resolveOrder(bridgeOf())).toEqual({
      sort: [
        { column: 'kind', direction: 'asc' },
        { column: 'code', direction: 'asc' },
      ],
      total: 3,
      keysetColumn: null,
      keysetColumns: ['kind', 'code'],
    });
  });

  it('with no unique index either is read by OFFSET in the order of every column that can be ordered — and says so', async () => {
    const { adapter, calls } = sqlTable(ROWS, [], {
      keyset: true,
      columns: [
        { name: 'code' },
        { name: 'kind' },
        { name: 'doc', dataType: 'json' },
      ],
    });
    const order = await reader(adapter).resolveOrder(bridgeOf());
    expect(order.sort).toEqual([
      { column: 'code', direction: 'asc' },
      { column: 'kind', direction: 'asc' },
    ]);
    expect(order.keysetColumn).toBeNull();
    expect(order.keysetColumns).toBeUndefined();
    expect(order.warning).toMatch(/no primary key and no unique index/);
    expect(order.warning).toMatch(/skipped or delivered twice/);
    const items = await all(
      reader(adapter).rows(bridgeOf(), {
        startOffset: 1,
        resumeKey: null,
        order,
      }),
    );
    expect(items.map((i) => [i.index, i.row.code, i.keyset])).toEqual([
      [1, 'b', undefined],
      [2, 'c', undefined],
    ]);
    expect(calls[1]).toMatchObject({ offset: 1 });
  });

  it('…and when the engine will not say what the table holds, the columns are those the probe returned', async () => {
    const { adapter } = sqlTable(ROWS, [], {
      noSchema: true,
      columns: [{ name: 'code' }, { name: 'kind' }],
    });
    const order = await reader(adapter).resolveOrder(bridgeOf());
    expect(order.sort.map((x) => x.column)).toEqual(['code', 'kind']);
    expect(order.warning).toBeDefined();
  });

  it('with a sort of the bridge’s own is read in that order by OFFSET, and nothing is said', async () => {
    const { adapter } = sqlTable(ROWS, [], {
      keyset: true,
      columns: [{ name: 'code' }, { name: 'kind' }],
    });
    const sort = [{ column: 'code', direction: 'asc' as const }];
    expect(await reader(adapter).resolveOrder(bridgeOf({ sort }))).toEqual({
      sort,
      total: 3,
      keysetColumn: null,
    });
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
