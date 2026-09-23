'use client';

import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';
import type { QueryResult } from '@syncle/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportRows } from '@/lib/export';
import { cn } from '@/lib/utils';

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ResultTable({ result }: { result: QueryResult | null }) {
  const t = useTranslations('resultTable');

  if (!result) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t('empty')}
      </div>
    );
  }

  const isWrite = result.columns.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <Badge variant="secondary" className="font-normal">
          {result.command ?? 'OK'}
        </Badge>
        {isWrite ? (
          <span>
            {t('rowsAffected', {
              count: result.affectedRows ?? result.rowCount,
            })}
          </span>
        ) : (
          <span>{t('rowCount', { count: result.rowCount })}</span>
        )}
        <span>· {t('executionTime', { ms: result.executionMs })}</span>
        {result.truncated && (
          <Badge variant="outline" className="text-amber-500">
            {t('truncated')}
          </Badge>
        )}
        {result.notice && <span className="italic">{result.notice}</span>}

        {!isWrite && result.rows.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-6 w-6"
                aria-label={t('exportResults')}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  exportRows(
                    result.columns.map((c) => c.name),
                    result.rows,
                    'csv',
                    'query-result',
                  )
                }
              >
                {t('exportCsv')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  exportRows(
                    result.columns.map((c) => c.name),
                    result.rows,
                    'json',
                    'query-result',
                  )
                }
              >
                {t('exportJson')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        {isWrite ? (
          <div className="text-muted-foreground p-4 text-sm">
            {t('statementExecuted')}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/95 sticky top-0 z-10 backdrop-blur">
              <tr>
                {result.columns.map((col) => (
                  <th
                    key={col.name}
                    className="whitespace-nowrap border-b border-r px-3 py-1.5 text-left font-medium"
                  >
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="hover:bg-accent/40">
                  {result.columns.map((col) => {
                    const value = row[col.name];
                    return (
                      <td
                        key={col.name}
                        className="max-w-[420px] border-b border-r px-3 py-1"
                      >
                        <span
                          className={cn(
                            'block truncate font-mono text-xs',
                            value === null || value === undefined
                              ? 'text-muted-foreground/60 italic'
                              : '',
                          )}
                          title={formatCell(value)}
                        >
                          {formatCell(value)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
