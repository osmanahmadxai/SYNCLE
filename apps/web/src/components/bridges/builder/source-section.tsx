'use client';

/**
 * left panel of the builder: source pickers (connection / database / table),
 * the row/column selection grid, and pagination.
 */
import type { Dispatch } from 'react';
import { Check, Loader2, Pencil, Plus, Radio, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type {
  BrowseResult,
  ConnectionConfig,
  QueryColumn,
  TableSchema,
} from '@syncle/core';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PAGE_SIZE, type BuilderAction, type BuilderDraft } from './draft';

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function SourceSection({
  draft,
  dispatch,
  connections,
  databases,
  tables,
  columns,
  rows,
  pk,
  singlePk,
  browse,
  isFetching,
  onRefetch,
  openConnectionDialog,
}: {
  draft: Pick<
    BuilderDraft,
    | 'connectionId'
    | 'database'
    | 'table'
    | 'mode'
    | 'selectedKeys'
    | 'included'
    | 'offset'
    | 'syncMode'
  >;
  dispatch: Dispatch<BuilderAction>;
  connections: ConnectionConfig[] | undefined;
  databases: string[] | undefined;
  tables: TableSchema[];
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  pk: string[];
  singlePk: string | null;
  browse: BrowseResult | undefined;
  isFetching: boolean;
  onRefetch: () => void;
  openConnectionDialog: (editingId?: string | null) => void;
}) {
  const t = useTranslations('bridgeBuilder');
  const { connectionId, database, table, mode, selectedKeys, included, offset, syncMode } =
    draft;

  /* ----- selection helpers ----- */

  function toggleRow(row: Record<string, unknown>) {
    if (!singlePk) return;
    dispatch({ type: 'toggleRow', key: String(row[singlePk]), value: row[singlePk] });
  }

  function togglePage() {
    if (!singlePk) return;
    dispatch({
      type: 'togglePage',
      entries: rows.map((r) => ({ key: String(r[singlePk]), value: r[singlePk] })),
    });
  }

  function toggleColumn(name: string) {
    dispatch({ type: 'toggleColumn', name });
  }

  return (
    <div className="flex h-full flex-col">
      {/* source pickers */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <Select
            value={connectionId}
            onValueChange={(v) => dispatch({ type: 'selectConnection', connectionId: v })}
          >
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder={t('connection')} />
            </SelectTrigger>
            <SelectContent>
              {(connections?.length ?? 0) === 0 && (
                <div className="text-muted-foreground px-2 py-1.5 text-xs">
                  {t('noConnections')}
                </div>
              )}
              {connections?.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connectionId ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={t('editConnection')}
              onClick={() => openConnectionDialog(connectionId)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => openConnectionDialog()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> {t('connectDatabase')}
            </Button>
          )}
        </div>

        {(databases?.length ?? 0) > 0 && (
          <Select
            value={database || '__default'}
            onValueChange={(v) =>
              dispatch({
                type: 'selectDatabase',
                database: v === '__default' ? '' : v,
              })
            }
          >
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">{t('defaultDb')}</SelectItem>
              {databases?.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={table}
          onValueChange={(v) => dispatch({ type: 'selectTable', table: v })}
        >
          <SelectTrigger className="h-8 w-52">
            <SelectValue placeholder={t('table')} />
          </SelectTrigger>
          <SelectContent>
            {tables.map((t) => (
              <SelectItem
                key={`${t.schema ?? ''}.${t.name}`}
                value={t.name}
              >
                {t.schema ? `${t.schema}.${t.name}` : t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {table && (
          <>
            {syncMode === 'oneTime' && (
              <>
                <div className="ml-2 flex items-center overflow-hidden rounded-md border text-xs">
                  {(['selected', 'all'] as const).map((m) => (
                    <button
                      key={m}
                      disabled={m === 'selected' && !singlePk}
                      onClick={() => dispatch({ type: 'setMode', mode: m })}
                      className={cn(
                        'px-2.5 py-1.5 transition-colors disabled:opacity-40',
                        mode === m
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-accent',
                      )}
                      title={
                        m === 'selected' && !singlePk
                          ? t('needsSinglePk')
                          : undefined
                      }
                    >
                      {m === 'selected' ? t('selectedRows') : t('allRows')}
                    </button>
                  ))}
                </div>
                {mode === 'selected' && (
                  <Badge variant="secondary" className="font-normal">
                    {t('nSelected', { count: selectedKeys.size })}
                  </Badge>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-8 w-8"
              onClick={() => onRefetch()}
            >
              {isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </>
        )}
      </div>

      {/* live-mode preview banner */}
      {syncMode === 'live' && table && (
        <div className="flex items-start gap-2 border-b bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
          <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>{t('columnSelectionOnly')}</strong> {t('liveBannerRest')}
          </span>
        </div>
      )}

      {/* grid */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        {!table ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {syncMode === 'live'
              ? t('pickLive')
              : t('pickOneTime')}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/95 sticky top-0 z-10 backdrop-blur">
              <tr>
                {mode === 'selected' && (
                  <th className="w-8 border-b border-r px-2 py-1.5">
                    <input
                      type="checkbox"
                      className="accent-primary h-3.5 w-3.5 cursor-pointer"
                      disabled={!singlePk}
                      checked={
                        rows.length > 0 &&
                        !!singlePk &&
                        rows.every((r) =>
                          selectedKeys.has(String(r[singlePk])),
                        )
                      }
                      onChange={togglePage}
                    />
                  </th>
                )}
                {columns.map((col) => {
                  const on = included.has(col.name);
                  return (
                    <th
                      key={col.name}
                      className={cn(
                        'border-b border-r px-3 py-1.5 text-left font-medium',
                        !on && 'opacity-40',
                      )}
                    >
                      <button
                        className="flex items-center gap-1.5 whitespace-nowrap"
                        onClick={() => toggleColumn(col.name)}
                        title={
                          on
                            ? t('includedClickExclude')
                            : t('excludedClickInclude')
                        }
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 items-center justify-center rounded border',
                            on
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-muted-foreground/40',
                          )}
                        >
                          {on && <Check className="h-3 w-3" />}
                        </span>
                        <span>{col.name}</span>
                        {pk.includes(col.name) && (
                          <span className="text-[10px] text-amber-500">
                            PK
                          </span>
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isSel =
                  !!singlePk && selectedKeys.has(String(row[singlePk]));
                return (
                  <tr
                    key={i}
                    className={cn(
                      'hover:bg-accent/40',
                      mode === 'selected' && isSel && 'bg-primary/5',
                    )}
                  >
                    {mode === 'selected' && (
                      <td className="border-b border-r px-2 text-center">
                        <input
                          type="checkbox"
                          className="accent-primary h-3.5 w-3.5 cursor-pointer"
                          disabled={!singlePk}
                          checked={isSel}
                          onChange={() => toggleRow(row)}
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.name}
                        className={cn(
                          'max-w-[360px] border-b border-r px-3 py-1',
                          !included.has(col.name) && 'opacity-40',
                        )}
                      >
                        <span
                          className={cn(
                            'block truncate font-mono text-xs',
                            row[col.name] == null &&
                              'text-muted-foreground/60 italic',
                          )}
                          title={formatCell(row[col.name])}
                        >
                          {formatCell(row[col.name])}
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* pagination */}
      {table && (
        <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-xs">
          <span>
            {syncMode === 'live' ? t('previewRows') + ' ' : t('rows') + ' '}
            {rows.length ? offset + 1 : 0}–{offset + rows.length}
            {syncMode === 'oneTime' && browse?.total != null
              ? t('ofTotal', {
                  total: `${browse.estimated ? '~' : ''}${browse.total.toLocaleString()}`,
                })
              : ''}
          </span>
          <div className="ml-auto flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={offset === 0}
              onClick={() =>
                dispatch({ type: 'setOffset', offset: Math.max(0, offset - PAGE_SIZE) })
              }
            >
              {t('prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={!browse?.hasMore}
              onClick={() =>
                dispatch({ type: 'setOffset', offset: offset + PAGE_SIZE })
              }
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
