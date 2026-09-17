/**
 * reads a bridge's source TABLE from one end to the other, a page at a time, in
 * a stable order — for a replay, and for the copy a change-stream bridge makes
 * of the table before it starts following changes.
 *
 * only a single page is ever held in memory. on a single-column primary key the
 * pages are keyset-paginated (`key > last`), which costs the same however deep
 * the read is and lands on the exact next row after a resume even when rows were
 * added or removed in the meantime; otherwise it falls back to OFFSET.
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
  keysetColumn: string | null;
  /** read by the engine's own cursor (see {@link CURSOR_COLUMN}); `sort` does not apply */
  cursorPaging?: boolean;
}

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
    const { probe, cursorPaging } = await this.pool.withAdapter(
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
      }),
    );
    const singlePk =
      probe.primaryKey.length === 1 ? probe.primaryKey[0]! : null;
    if (cursorPaging) {
      return {
        sort: [],
        total: probe.total,
        keysetColumn: singlePk,
        cursorPaging: true,
      };
    }

    if (src.sort && src.sort.length > 0) {
      // keyset only if the caller's order is exactly the (unique) primary key asc
      const s = src.sort;
      const keyset =
        s.length === 1 && s[0]!.column === singlePk && s[0]!.direction === 'asc'
          ? singlePk
          : null;
      return { sort: src.sort, total: probe.total, keysetColumn: keyset };
    }
    if (probe.primaryKey.length > 0) {
      return {
        sort: probe.primaryKey.map((column) => ({
          column,
          direction: 'asc' as const,
        })),
        total: probe.total,
        keysetColumn: singlePk,
      };
    }
    throw new BadRequestError(
      `Table "${src.table}" has no primary key, so rows cannot be paged in a stable order. Add a sort to the bridge to replay it safely.`,
    );
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
    const { sort, keysetColumn, cursorPaging } =
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
