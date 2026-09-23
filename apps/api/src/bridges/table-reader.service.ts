/**
 * reads a bridge's source TABLE from one end to the other, a page at a time, in
 * a stable order — for a replay, for a verification, and for the copy a
 * change-stream bridge makes of the table before it starts following changes.
 *
 * only a single page is ever held in memory, and — wherever the engine can do
 * it — the pages are keyset-paginated: "the rows after this one", which costs
 * the same however deep the read is and lands on the exact next row after a
 * resume even when rows were added or removed in the meantime. that used to be
 * only a table with a single-column primary key; a composite key, or a sort of
 * the bridge's own, fell back to OFFSET — where every page re-reads all the
 * pages before it, so that a table of a few million rows took hours it had no
 * business taking. now:
 *
 *   - a primary key of any width is the keyset (`(a, b) > (last a, last b)`)
 *   - a sort of the bridge's own gets the key appended, so that it is total,
 *     and is keyset-paginated too — unless a sorted column can hold NULL, which
 *     no comparison can place: that is read by OFFSET, as it was
 *   - a table with no primary key is keyed by a unique index whose columns
 *     cannot be NULL, when it has one; a view, or a table with neither, is
 *     read by OFFSET in the order of all its columns, and the read SAYS that
 *     rows changed under it may be skipped or repeated (see {@link TableOrder.warning})
 *
 * a table with a single-column key is still read the way it always was
 * (`key > last`, through an ordinary filter), so every engine keeps that, and
 * so do the checkpoints of runs that were saved before this.
 *
 * an engine with no order to page by (Redis) is read by its own cursor instead.
 * it used to be keyset-paginated like the rest, and its adapter reads any
 * filter on `key` as a glob: page two asked for the keys that CONTAIN the last
 * key of page one, got that one key back, and the replay finished — "completed",
 * 200 keys deep into a database of any size.
 */
import { Injectable } from '@nestjs/common';
import {
  BadRequestError,
  type BrowseParams,
  type SortSpec,
} from '@syncle/core';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { isSyncleOwnKey } from './cdc/providers/redis-cdc.provider';
import type { KeysetCheckpoint, ResolvedBridge } from './bridges.types';

export interface TableRow {
  row: Record<string, unknown>;
  /** position of the row in the read, counted from the table's first row */
  index: number;
  /** present on keyset-paginated reads: this row's checkpointable key */
  keyset?: KeysetCheckpoint;
}

export interface TableOrder {
  sort: SortSpec[];
  total: number | null;
  /** a SINGLE column the read is keyset-paginated on (`column > last`, through a filter) */
  keysetColumn: string | null;
  /**
   * the columns the read is keyset-paginated on when there is more than one
   * (the tuple after the last row's, see {@link BrowseParams.after}); empty
   * when `keysetColumn` is set, or when the read is by OFFSET
   */
  keysetColumns?: string[];
  /** read by the engine's own cursor (see {@link CURSOR_COLUMN}); `sort` does not apply */
  cursorPaging?: boolean;
  /**
   * the read is by OFFSET in an order that is not known to be unique: rows
   * changed under it can be skipped or repeated. what a run should say
   */
  warning?: string;
}

/** what is known of a table's shape, for choosing how to page it; unknown = nothing */
interface TableFacts {
  /** the columns that can hold NULL; unknown = every column can */
  nullable: Set<string> | null;
  /** the unique indexes, each as its columns, primary key first */
  uniqueKeys: string[][];
  /** the columns, in table order */
  columns: string[];
  /** types that no ORDER BY can take (PostgreSQL's json, xml, geometry): not part of an all-columns order */
  unorderable: Set<string>;
}

/** column types an ORDER BY refuses (or orders meaninglessly): left out of an all-columns order */
const UNORDERABLE = new Set([
  'json',
  'xml',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'geometry',
  'geography',
]);

/**
 * the "column" of a checkpoint taken on a cursor-paged read. its value is the
 * cursor of the PAGE the row came in — a cursor cannot point into a page — so a
 * resume reads that page again. rows it holds that were already delivered are
 * delivered once more, which an upsert absorbs
 */
export const CURSOR_COLUMN = '$cursor';

@Injectable()
export class TableReaderService {
  constructor(private readonly pool: AdapterPoolService) {}

  /**
   * a stable order is mandatory: `LIMIT/OFFSET` without `ORDER BY` can skip or
   * repeat rows across pages. use the caller's sort, else the primary key, and
   * report whether we can keyset-paginate (single, uniquely-ordered key).
   */
  async resolveOrder(bridge: ResolvedBridge): Promise<TableOrder> {
    if (bridge.source.kind !== 'table')
      return { sort: [], total: null, keysetColumn: null };
    const src = bridge.source;
    const { probe, cursorPaging, keysetPaging } = await this.pool.withAdapter(
      src.connectionId,
      src.database,
      async (a) => ({
        probe: await a.browse({
          schema: src.schema,
          table: src.table,
          filters: src.filters,
          limit: 1,
          offset: 0,
        }),
        cursorPaging: a.capabilities.cursorPaging === true,
        keysetPaging: a.capabilities.keysetPaging === true,
      }),
    );
    const singlePk =
      probe.primaryKey.length === 1 ? probe.primaryKey[0]! : null;
    // the engine's cursor runs in the engine's own order (Redis: none; MongoDB:
    // `_id`). an order the bridge asks for itself is kept — and then paged by
    // OFFSET, never by `key > last`: on these engines a key read back from a
    // row is not the key as the engine holds it (an ObjectId comes out as text)
    const s = src.sort ?? [];
    const ownOrder =
      s.length > 0 &&
      !(
        s.length === 1 &&
        s[0]!.column === singlePk &&
        s[0]!.direction === 'asc'
      );
    if (cursorPaging && !ownOrder) {
      return {
        sort: [],
        total: probe.total,
        keysetColumn: singlePk,
        cursorPaging: true,
      };
    }
    if (cursorPaging)
      return { sort: s, total: probe.total, keysetColumn: null };

    // what identifies a row: the primary key, or — without one — a unique
    // index none of whose columns can be NULL
    const facts =
      keysetPaging || probe.primaryKey.length === 0
        ? await this.facts(src, probe)
        : null;
    const key =
      probe.primaryKey.length > 0
        ? probe.primaryKey
        : (facts?.uniqueKeys.find((columns) =>
            columns.every(
              (c) => facts.nullable !== null && !facts.nullable.has(c),
            ),
          ) ?? []);
    const asc = (column: string) => ({ column, direction: 'asc' as const });

    if (s.length > 0) {
      // the single-key case, as it always was: `key > last` through a filter
      if (
        s.length === 1 &&
        s[0]!.column === singlePk &&
        s[0]!.direction === 'asc'
      )
        return { sort: s, total: probe.total, keysetColumn: singlePk };
      // the bridge's own order, made total by the key behind it — a keyset,
      // provided nothing sorted can be NULL (a NULL is neither before nor after)
      const sorted = new Set(s.map((x) => x.column));
      const nullable = facts?.nullable ?? null;
      const canKeyset =
        keysetPaging &&
        key.length > 0 &&
        nullable !== null &&
        s.every((x) => !nullable.has(x.column));
      if (canKeyset) {
        const sort = [...s, ...key.filter((c) => !sorted.has(c)).map(asc)];
        return {
          sort,
          total: probe.total,
          keysetColumn: null,
          keysetColumns: sort.map((x) => x.column),
        };
      }
      return { sort: s, total: probe.total, keysetColumn: null };
    }
    if (key.length === 1) {
      return {
        sort: key.map(asc),
        total: probe.total,
        keysetColumn: key[0]!,
      };
    }
    if (key.length > 1) {
      return {
        sort: key.map(asc),
        total: probe.total,
        keysetColumn: null,
        // an engine that cannot page after a tuple reads a composite key by OFFSET, as before
        ...(keysetPaging ? { keysetColumns: key } : {}),
      };
    }
    // nothing identifies a row (a view, a table without a key): every column
    // that can be ordered, and the honest word about it
    const columns = (
      facts?.columns.length ? facts.columns : probe.columns.map((c) => c.name)
    ).filter((c) => !facts?.unorderable.has(c));
    if (columns.length === 0) {
      throw new BadRequestError(
        `Table "${src.table}" has no primary key, so rows cannot be paged in a stable order. Add a sort to the bridge to replay it safely.`,
      );
    }
    return {
      sort: columns.map(asc),
      total: probe.total,
      keysetColumn: null,
      warning:
        `"${src.table}" has no primary key and no unique index, so it is read by OFFSET in the order of all its columns. ` +
        'Rows added, removed or changed while it is being read can be skipped or delivered twice; a key would make the read exact.',
    };
  }

  /** what the engine says of the table's shape; as little as nothing, when it says nothing */
  private async facts(
    src: Extract<ResolvedBridge['source'], { kind: 'table' }>,
    probe: {
      primaryKey: string[];
      columns: Array<{ name: string; dataType?: string }>;
    },
  ): Promise<TableFacts> {
    const facts: TableFacts = {
      nullable: null,
      uniqueKeys: probe.primaryKey.length ? [probe.primaryKey] : [],
      columns: probe.columns.map((c) => c.name),
      unorderable: new Set(
        probe.columns
          .filter((c) => c.dataType && UNORDERABLE.has(baseType(c.dataType)))
          .map((c) => c.name),
      ),
    };
    try {
      const schema = await this.pool.withAdapter(
        src.connectionId,
        src.database,
        (a) => a.getSchema(src.database),
      );
      const table = schema.namespaces
        .filter((n) => !src.schema || n.name === src.schema)
        .flatMap((n) => n.tables)
        .find((t) => t.name === src.table);
      if (!table) return facts;
      facts.nullable = new Set(
        table.columns.filter((c) => c.nullable).map((c) => c.name),
      );
      facts.columns = table.columns.map((c) => c.name);
      facts.unorderable = new Set(
        table.columns
          .filter((c) => UNORDERABLE.has(baseType(c.nativeType ?? c.dataType)))
          .map((c) => c.name),
      );
      for (const index of table.indexes) {
        if (
          index.unique &&
          index.columns.length > 0 &&
          !facts.uniqueKeys.some((k) => k.join() === index.columns.join())
        )
          facts.uniqueKeys.push(index.columns);
      }
    } catch {
      /* introspection unavailable: the key is what the probe said, every column may be NULL */
    }
    return facts;
  }

  /**
   * every row from `startOffset` on. `resumeKey` is the keyset checkpoint that
   * was stored with that offset, when there is one; `order` lets a caller that
   * has already resolved it (to refuse early, or to report the total) pass it in
   */
  async *rows(
    bridge: ResolvedBridge,
    opts: {
      startOffset: number;
      resumeKey: KeysetCheckpoint | null;
      order?: TableOrder;
    },
  ): AsyncGenerator<TableRow> {
    if (bridge.source.kind !== 'table') return;
    const src = bridge.source;
    const { startOffset, resumeKey } = opts;
    const { sort, keysetColumn, keysetColumns, cursorPaging } =
      opts.order ?? (await this.resolveOrder(bridge));
    const pageSize = bridge.delivery.pageSize;
    const browse = (params: BrowseParams) =>
      this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a.browse(params),
      );

    if (cursorPaging) {
      // a resume with no cursor to resume by starts over: everything is
      // delivered again, under new positions, and nothing is skipped
      let cursor =
        resumeKey?.column === CURSOR_COLUMN &&
        typeof resumeKey.value === 'string'
          ? resumeKey.value
          : '0';
      let index = startOffset;
      for (;;) {
        const page = await browse({
          schema: src.schema,
          table: src.table,
          filters: src.filters,
          limit: pageSize,
          offset: 0,
          cursor,
        });
        for (const row of page.rows) {
          // Syncle's own job queues and spool, when the Redis being read is the
          // one Syncle runs on: never the user's data. the change stream leaves
          // them out for the same reason
          if (typeof row.key === 'string' && isSyncleOwnKey(row.key)) continue;
          yield {
            row,
            index,
            keyset: { column: CURSOR_COLUMN, value: cursor },
          };
          index++;
        }
        // an empty page is not the end (a sparse MATCH); only the cursor says so
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    }

    // keyset pagination after a TUPLE: a composite key, or the bridge's own
    // order with the key behind it. the checkpoint is the whole tuple
    if (keysetColumns && keysetColumns.length > 0) {
      const name = keysetColumns.join(',');
      let last: unknown[] | null = null;
      let index = startOffset;
      if (startOffset > 0) {
        if (
          resumeKey &&
          resumeKey.column === name &&
          Array.isArray(resumeKey.value) &&
          resumeKey.value.length === keysetColumns.length
        ) {
          last = resumeKey.value;
        } else {
          // no checkpoint of this shape (an older run, a changed sort): the
          // row before the first one wanted, by offset, once
          const seek = await browse({
            schema: src.schema,
            table: src.table,
            filters: src.filters,
            sort,
            limit: 1,
            offset: startOffset - 1,
          });
          const row = seek.rows[0];
          last = row ? keysetColumns.map((c) => row[c]) : null;
        }
      }
      for (;;) {
        const page = await browse({
          schema: src.schema,
          table: src.table,
          filters: src.filters,
          sort,
          limit: pageSize,
          offset: 0,
          ...(last ? { after: { columns: keysetColumns, values: last } } : {}),
        });
        for (const row of page.rows) {
          last = keysetColumns.map((c) => row[c]);
          yield { row, index, keyset: { column: name, value: last } };
          index++;
        }
        if (!page.hasMore || page.rows.length === 0) return;
      }
    }

    // keyset pagination on a unique key, O(1) per page no matter how deep we
    // are, so a multi-million-row read stays fast (no OFFSET re-scan)
    if (keysetColumn) {
      let lastKey: unknown = null;
      let index = startOffset;
      if (startOffset > 0) {
        if (resumeKey && resumeKey.column === keysetColumn) {
          // exact resume from the checkpointed key — immune to rows added or
          // removed under the job, and no deep-OFFSET seek query
          lastKey = resumeKey.value;
        } else {
          // legacy jobs (no checkpoint) or a changed sort column: fall back to
          // seeking the key of the last already-delivered row by offset
          const seek = await browse({
            schema: src.schema,
            table: src.table,
            filters: src.filters,
            sort,
            limit: 1,
            offset: startOffset - 1,
          });
          lastKey = seek.rows[0]?.[keysetColumn] ?? null;
        }
      }
      for (;;) {
        const filters = [
          ...(src.filters ?? []),
          ...(lastKey != null
            ? [
                {
                  column: keysetColumn,
                  operator: 'gt' as const,
                  value: lastKey,
                },
              ]
            : []),
        ];
        const page = await browse({
          schema: src.schema,
          table: src.table,
          filters,
          sort,
          limit: pageSize,
          offset: 0,
        });
        for (const row of page.rows) {
          lastKey = row[keysetColumn];
          yield {
            row,
            index,
            keyset: { column: keysetColumn, value: lastKey },
          };
          index++;
        }
        if (!page.hasMore || page.rows.length === 0) return;
      }
    }

    // fallback: OFFSET pagination (composite key or custom non-unique sort)
    let offset = startOffset;
    for (;;) {
      const page = await browse({
        schema: src.schema,
        table: src.table,
        filters: src.filters,
        sort,
        limit: pageSize,
        offset,
      });
      for (let i = 0; i < page.rows.length; i++) {
        yield { row: page.rows[i]!, index: offset + i };
      }
      if (!page.hasMore || page.rows.length === 0) return;
      offset += page.rows.length;
    }
  }
}

/** `numeric(10,2)` -> `numeric`, `character varying` -> `character varying`, `json` -> `json` */
function baseType(type: string): string {
  return type.toLowerCase().replace(/\(.*$/, '').replace(/\[\]$/, '').trim();
}
