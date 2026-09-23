'use client';

/**
 * What this bridge WOULD do, before it is saved: the table each database
 * target would be created as — column by column, with the source type beside
 * the type it becomes — anything the target cannot hold faithfully, and a few
 * real rows as they would be written or sent. Nothing is created and nothing
 * is delivered; the API only samples the source and looks at the targets.
 */
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  TableProperties,
} from 'lucide-react';
import type { BridgePreview } from '@syncle/core';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function DryRunDialog({
  open,
  onOpenChange,
  loading,
  preview,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  preview: BridgePreview | null;
  error: string | null;
}) {
  const t = useTranslations('dryRun');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('looking')}
          </div>
        )}

        {error && !loading && (
          <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        )}

        {preview && !loading && (
          <div className="grid gap-4 text-sm">
            {preview.warnings.length > 0 ? (
              <div className="grid gap-1 rounded-md bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('warnings', { count: preview.warnings.length })}
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('noWarnings')}
              </p>
            )}

            {preview.destinationKind === 'http' && (
              <div className="grid gap-1">
                <p className="font-medium">{t('request')}</p>
                <p className="font-mono text-xs">
                  {preview.method} {preview.url}
                </p>
                {preview.headers && Object.keys(preview.headers).length > 0 && (
                  <pre className="bg-muted overflow-x-auto rounded p-2 text-[11px]">
                    {Object.entries(preview.headers)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n')}
                  </pre>
                )}
              </div>
            )}

            {preview.targets?.map((target) => (
              <div key={target.label} className="grid gap-1.5">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <TableProperties className="h-3.5 w-3.5" />
                  <span className="font-mono">{target.label}</span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-normal',
                      target.exists === true
                        ? 'bg-muted text-muted-foreground'
                        : target.exists === false && target.createMissingTable
                          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400'
                          : 'bg-destructive/15 text-destructive',
                    )}
                  >
                    {target.exists === true
                      ? t('exists')
                      : target.exists === null
                        ? t('unknown')
                        : target.createMissingTable
                          ? t('willBeCreated')
                          : t('missing')}
                  </span>
                  <span className="text-muted-foreground text-xs font-normal">
                    {target.writeMode}
                    {target.keyColumns.length > 0 &&
                      ` · ${target.keyColumns.join(', ')}`}
                  </span>
                </p>
                {target.plannedColumns && (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 text-muted-foreground text-left">
                        <tr>
                          <th className="px-2 py-1 font-medium">
                            {t('column')}
                          </th>
                          <th className="px-2 py-1 font-medium">
                            {t('sourceType')}
                          </th>
                          <th className="px-2 py-1 font-medium">
                            {t('targetType')}
                          </th>
                          <th className="px-2 py-1 font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {target.plannedColumns.map((c) => (
                          <tr key={c.name} className="border-t">
                            <td className="px-2 py-1 font-mono">{c.name}</td>
                            <td className="text-muted-foreground px-2 py-1 font-mono">
                              {c.sourceType}
                            </td>
                            <td className="px-2 py-1 font-mono">{c.type}</td>
                            <td className="text-muted-foreground px-2 py-1">
                              {[
                                c.primaryKey && t('key'),
                                !c.nullable && t('required'),
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}

            <div className="grid gap-1">
              <p className="font-medium">
                {preview.destinationKind === 'http' ? t('payloads') : t('rows')}
                <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                  {preview.fromSource ? t('fromSource') : t('fromSample')}
                </span>
              </p>
              {preview.bodies.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t('noRows')}</p>
              ) : (
                preview.bodies.map((body, i) => (
                  <pre
                    key={i}
                    className="bg-muted max-h-40 overflow-auto rounded p-2 text-[11px]"
                  >
                    {JSON.stringify(body, null, 2)}
                  </pre>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
