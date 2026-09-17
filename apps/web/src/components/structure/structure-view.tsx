'use client';

import { useTranslations } from 'next-intl';
import { KeyRound, Link2 } from 'lucide-react';
import { useSchema } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';

export function StructureView() {
  const t = useTranslations('structureView');
  const { activeConnectionId, activeDatabase, selected } = useStudio();
  const { data: schema } = useSchema(activeConnectionId, activeDatabase);

  if (!selected) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t('empty')}
      </div>
    );
  }

  const table = schema?.namespaces
    .flatMap((ns) => ns.tables)
    .find(
      (tbl) =>
        tbl.name === selected.table &&
        (tbl.schema ?? '') === (selected.schema ?? ''),
    );

  if (!table) {
    return (
      <div className="text-muted-foreground p-4 text-sm">{t('loading')}</div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-4">
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            {t('columns')}
            <Badge variant="secondary" className="font-normal">
              {table.columns.length}
            </Badge>
          </h3>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-muted-foreground text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('name')}</th>
                  <th className="px-3 py-2 font-medium">{t('type')}</th>
                  <th className="px-3 py-2 font-medium">{t('nullable')}</th>
                  <th className="px-3 py-2 font-medium">{t('default')}</th>
                  <th className="px-3 py-2 font-medium">{t('key')}</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((col) => (
                  <tr key={col.name} className="border-t">
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {col.name}
                    </td>
                    <td className="text-muted-foreground px-3 py-1.5 font-mono text-xs">
                      {col.dataType}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {col.nullable ? t('yes') : t('no')}
                    </td>
                    <td className="text-muted-foreground px-3 py-1.5 font-mono text-xs">
                      {col.defaultValue ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-1">
                        {col.isPrimaryKey && (
                          <Badge
                            variant="outline"
                            className="gap-1 text-amber-500"
                          >
                            <KeyRound className="h-3 w-3" /> {t('pk')}
                          </Badge>
                        )}
                        {col.references && (
                          <Badge variant="outline" className="gap-1">
                            <Link2 className="h-3 w-3" />
                            {col.references.table}.{col.references.column}
                          </Badge>
                        )}
                        {col.isAutoIncrement && (
                          <Badge variant="outline">{t('auto')}</Badge>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {table.indexes.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('indexes')}</h3>
            <div className="space-y-1">
              {table.indexes.map((idx) => (
                <div
                  key={idx.name}
                  className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
                >
                  <span className="font-mono">{idx.name}</span>
                  <span className="text-muted-foreground">
                    ({idx.columns.join(', ')})
                  </span>
                  {idx.primary && (
                    <Badge variant="outline">{t('primary')}</Badge>
                  )}
                  {idx.unique && !idx.primary && (
                    <Badge variant="outline">{t('unique')}</Badge>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {table.foreignKeys.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('foreignKeys')}</h3>
            <div className="space-y-1">
              {table.foreignKeys.map((fk) => (
                <div
                  key={fk.name}
                  className="rounded-md border px-3 py-1.5 font-mono text-xs"
                >
                  {fk.columns.join(', ')} → {fk.referencedTable}(
                  {fk.referencedColumns.join(', ')})
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
