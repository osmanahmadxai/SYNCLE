'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  FilterOperator,
  FilterSpec,
  SortSpec,
} from '@syncle/core';
import { api, ApiError } from '@/lib/api';
import { exportRows } from '@/lib/export';
import { useBrowse, useConnections, useDrivers } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RowEditorDialog } from './row-editor-dialog';

interface OperatorOption {
  value: FilterOperator;
  /** a symbol, shown as it is in every language */
  label?: string;
  /** a `dataGrid` message key, for the operators that are words */
  labelKey?: string;
  noValue?: boolean;
}

const OPERATORS: OperatorOption[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'contains', labelKey: 'operators.contains' },
  { value: 'startsWith', labelKey: 'operators.startsWith' },
  { value: 'endsWith', labelKey: 'operators.endsWith' },
  { value: 'isNull', labelKey: 'operators.isNull', noValue: true },
  { value: 'notNull', labelKey: 'operators.notNull', noValue: true },
];

const PAGE_SIZES = [25, 50, 100, 250, 500];

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function DataGrid() {
  const t = useTranslations('dataGrid');
  const tc = useTranslations('common');
  const { activeConnectionId, activeDatabase, selected } = useStudio();
  const qc = useQueryClient();
  const confirm = useConfirm();

  const { data: connections } = useConnections();
  const { data: drivers } = useDrivers();
  const conn = connections?.find((c) => c.id === activeConnectionId);
  const driver = drivers?.find((d) => d.engine === conn?.engine);

  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [filters, setFilters] = useState<FilterSpec[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(
    null,
  );
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // sort/filter columns and the page offset belong to the previous table;
  // reset them whenever the browsed relation changes
  useEffect(() => {
    setSort([]);
    setFilters([]);
    setOffset(0);
  }, [activeConnectionId, activeDatabase, selected?.schema, selected?.table]);

  const params = useMemo(
    () =>
      selected
        ? {
            schema: selected.schema,
            table: selected.table,
            limit,
            offset,
            sort: sort.length ? sort : undefined,
            filters: filters.length ? filters : undefined,
          }
        : null,
    [selected, limit, offset, sort, filters],
  );

  const { data, isFetching, error, refetch } = useBrowse(
    activeConnectionId,
    params,
    activeDatabase,
  );

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('selectTable')}
      </div>
    );
  }

  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const pk = data?.primaryKey ?? [];
  const canEdit = !!driver?.capabilities.rowEditing && pk.length > 0;
  const total = data?.total ?? null;

  function toggleSort(column: string) {
    setOffset(0);
    setSort((prev) => {
      const current = prev[0];
      if (!current || current.column !== column)
        return [{ column, direction: 'asc' }];
      if (current.direction === 'asc')
        return [{ column, direction: 'desc' }];
      return [];
    });
  }

  function identityFor(row: Record<string, unknown>) {
    return Object.fromEntries(pk.map((c) => [c, row[c]]));
  }

  async function commitEdit(rowIndex: number, column: string) {
    const row = rows[rowIndex];
    if (!row) return;
    const original = formatCell(row[column]);
    setEditing(null);
    if (draft === original) return;
    setBusy(true);
    try {
      await api.updateRow(
        activeConnectionId as string,
        {
          schema: selected!.schema,
          table: selected!.table,
          identity: identityFor(row),
          changes: { [column]: draft },
        },
        activeDatabase,
      );
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'browse'],
      });
      toast.success(t('rowUpdated'));
    } catch (err) {
      toast.error(t('updateFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function deleteRow(row: Record<string, unknown>) {
    const ok = await confirm({
      title: t('deleteRowTitle'),
      description: t('deleteRowDescription'),
      confirmText: tc('delete'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteRow(
        activeConnectionId as string,
        {
          schema: selected!.schema,
          table: selected!.table,
          identity: identityFor(row),
        },
        activeDatabase,
      );
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'browse'],
      });
      toast.success(t('rowDeleted'));
    } catch (err) {
      toast.error(t('deleteFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  const rangeStart = rows.length ? offset + 1 : 0;
  const rangeEnd = offset + rows.length;

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-mono text-sm font-medium">{selected.table}</span>
        <Badge variant="secondary" className="font-normal">
          {total == null
            ? t('range', { start: rangeStart, end: rangeEnd })
            : data?.estimated
              ? t('rangeOfEstimatedTotal', {
                  start: rangeStart,
                  end: rangeEnd,
                  total,
                })
              : t('rangeOfTotal', { start: rangeStart, end: rangeEnd, total })}
        </Badge>

        <FilterPopover
          columns={columns.map((c) => c.name)}
          filters={filters}
          onChange={(f) => {
            setFilters(f);
            setOffset(0);
          }}
        />

        <div className="ml-auto flex items-center gap-1">
          {(isFetching || busy) && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refetch()}
            aria-label={t('refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={rows.length === 0}
                aria-label={t('export')}
              >
                <Download className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  exportRows(
                    columns.map((c) => c.name),
                    rows,
                    'csv',
                    selected.table,
                  )
                }
              >
                {t('exportCsv')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  exportRows(
                    columns.map((c) => c.name),
                    rows,
                    'json',
                    selected.table,
                  )
                }
              >
                {t('exportJson')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canEdit && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> {t('addRow')}
            </Button>
          )}
        </div>
      </div>

      {/* grid */}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {error ? (
          <div className="p-4 text-sm text-destructive">
            {(error as Error).message}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
              <tr>
                <th className="w-8 border-b border-r px-2 py-1.5" />
                {columns.map((col) => {
                  const s = sort[0];
                  const active = s?.column === col.name;
                  return (
                    <th
                      key={col.name}
                      className="cursor-pointer select-none border-b border-r px-3 py-1.5 text-left font-medium hover:bg-accent"
                      onClick={() => toggleSort(col.name)}
                    >
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        <span>{col.name}</span>
                        {pk.includes(col.name) && (
                          <span
                            className="text-[10px] text-amber-500"
                            title={t('primaryKey')}
                          >
                            {t('pk')}
                          </span>
                        )}
                        {active &&
                          (s.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="group hover:bg-accent/40">
                  <td className="border-b border-r px-1 text-center">
                    {canEdit && (
                      <button
                        className="opacity-0 group-hover:opacity-100"
                        onClick={() => deleteRow(row)}
                        aria-label={t('deleteRow')}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                      </button>
                    )}
                  </td>
                  {columns.map((col) => {
                    const isEditing =
                      editing?.row === rowIndex && editing?.col === col.name;
                    const value = row[col.name];
                    return (
                      <td
                        key={col.name}
                        className="max-w-[420px] border-b border-r px-3 py-1"
                        onDoubleClick={() => {
                          if (!canEdit) return;
                          setEditing({ row: rowIndex, col: col.name });
                          setDraft(formatCell(value));
                        }}
                      >
                        {isEditing ? (
                          <Input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commitEdit(rowIndex, col.name)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')
                                commitEdit(rowIndex, col.name);
                              if (e.key === 'Escape') setEditing(null);
                            }}
                            className="h-6 px-1 py-0 font-mono text-xs"
                          />
                        ) : (
                          <span
                            className={cn(
                              'block truncate font-mono text-xs',
                              value === null || value === undefined
                                ? 'italic text-muted-foreground/60'
                                : '',
                            )}
                            title={formatCell(value)}
                          >
                            {value === null || value === undefined
                              ? 'NULL'
                              : formatCell(value)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!isFetching && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
                    {t('noRows')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* pagination */}
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">{t('rowsPerPage')}</span>
        <Select
          value={String(limit)}
          onValueChange={(v) => {
            setLimit(Number(v));
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-7 w-[72px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={!data?.hasMore}
            onClick={() => setOffset(offset + limit)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {addOpen && (
        <RowEditorDialog
          connectionId={activeConnectionId as string}
          database={activeDatabase}
          schema={selected.schema}
          table={selected.table}
          columns={columns}
          open={addOpen}
          onOpenChange={setAddOpen}
          onSaved={() =>
            qc.invalidateQueries({
              queryKey: ['connections', activeConnectionId, 'browse'],
            })
          }
        />
      )}
    </div>
  );
}

/* filter popover */

function FilterPopover({
  columns,
  filters,
  onChange,
}: {
  columns: string[];
  filters: FilterSpec[];
  onChange: (filters: FilterSpec[]) => void;
}) {
  const t = useTranslations('dataGrid');
  const [column, setColumn] = useState<string>('');
  const [operator, setOperator] = useState<FilterOperator>('eq');
  const [value, setValue] = useState('');

  const opMeta = OPERATORS.find((o) => o.value === operator);
  const opLabel = (o?: OperatorOption) =>
    o?.labelKey ? t(o.labelKey) : o?.label;

  function add() {
    const col = column || columns[0];
    if (!col) return;
    onChange([
      ...filters,
      { column: col, operator, value: opMeta?.noValue ? undefined : value },
    ]);
    setValue('');
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1">
          <Filter className="h-4 w-4" />
          {t('filter')}
          {filters.length > 0 && (
            <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
              {filters.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-2">
          {filters.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {filters.map((f, i) => (
                <Badge key={i} variant="secondary" className="gap-1 font-normal">
                  <span className="font-mono">
                    {f.column}{' '}
                    {opLabel(OPERATORS.find((o) => o.value === f.operator))}{' '}
                    {f.value != null ? String(f.value) : ''}
                  </span>
                  <button
                    onClick={() =>
                      onChange(filters.filter((_, idx) => idx !== i))
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="grid gap-2">
            <Select value={column || columns[0]} onValueChange={setColumn}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t('columnPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={operator}
              onValueChange={(v) => setOperator(v as FilterOperator)}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERATORS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {opLabel(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!opMeta?.noValue && (
              <Input
                className="h-8"
                placeholder={t('valuePlaceholder')}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
            )}
            <Button size="sm" onClick={add}>
              {t('addFilter')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
