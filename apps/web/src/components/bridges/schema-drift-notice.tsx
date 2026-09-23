'use client';

/**
 * The source table is not the one this bridge was built on.
 *
 * Two very different things, and they must not look alike:
 *
 *  - a column the bridge USES is gone. left alone, every row from then on would
 *    reach the destination with NULL in its place, over the value it holds. the
 *    bridge stops instead; this says which column, and that the way out is to
 *    edit the bridge — there is deliberately no button to wave it through
 *  - anything else (a column added, retyped, or one the bridge never touched
 *    dropped): worth knowing, harmless, and acceptable with one click
 */
import { useTranslations } from 'next-intl';
import { AlertTriangle, Columns3 } from 'lucide-react';
import { toast } from 'sonner';
import type { SchemaDrift } from '@syncle/core';
import { ApiError } from '@/lib/api';
import { useAcceptSchemaDrift, useSchemaDrift } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** the change as short lines: what went, what came, what is another type now */
export function driftLines(
  drift: SchemaDrift,
  t: (
    key: 'removed' | 'added' | 'retyped',
    values: { columns: string },
  ) => string,
): string[] {
  const lines: string[] = [];
  if (drift.removed.length)
    lines.push(
      t('removed', { columns: drift.removed.map((c) => c.name).join(', ') }),
    );
  if (drift.added.length)
    lines.push(
      t('added', {
        columns: drift.added.map((c) => `${c.name} (${c.type})`).join(', '),
      }),
    );
  if (drift.retyped.length)
    lines.push(
      t('retyped', {
        columns: drift.retyped
          .map((c) => `${c.name} (${c.from} → ${c.to})`)
          .join(', '),
      }),
    );
  return lines;
}

export function SchemaDriftNotice({
  bridgeId,
  onEdit,
}: {
  bridgeId: string;
  onEdit: () => void;
}) {
  const t = useTranslations('schemaDrift');
  const { data: status } = useSchemaDrift(bridgeId);
  const accept = useAcceptSchemaDrift(bridgeId);
  if (!status?.drift) return null;
  const harmful = status.missingUsed.length > 0;
  const Icon = harmful ? AlertTriangle : Columns3;

  async function handleAccept() {
    try {
      await accept.mutateAsync();
      toast.success(t('accepted'));
    } catch (err) {
      toast.error(t('couldNotAccept'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div
      role={harmful ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 border-b px-4 py-2 text-xs',
        harmful
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">
          {harmful
            ? t('harmfulTitle', {
                count: status.missingUsed.length,
                columns: status.missingUsed.join(', '),
              })
            : t('title')}
        </p>
        <p className="opacity-90">{harmful ? t('harmfulHelp') : t('help')}</p>
        <ul className="font-mono text-[10px] opacity-80">
          {driftLines(status.drift, t).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {harmful ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          onClick={onEdit}
        >
          {t('edit')}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          disabled={accept.isPending}
          onClick={() => void handleAccept()}
        >
          {t('accept')}
        </Button>
      )}
    </div>
  );
}
