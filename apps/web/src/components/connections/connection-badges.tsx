'use client';

/**
 * what a connection IS, shown wherever the connection is: production looks like
 * production in the sidebar, above the query editor and in a bridge's target
 * list — not only in the dialog where it was set, which nobody has open when
 * they are about to run a DELETE.
 */
import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ConnectionConfig } from '@syncle/core';
import { cn } from '@/lib/utils';

const TONE: Record<NonNullable<ConnectionConfig['environment']>, string> = {
  production: 'bg-red-600 text-white',
  staging: 'bg-amber-500 text-black',
  development: 'bg-slate-500 text-white',
};

export function ConnectionBadges({
  connection,
  className,
}: {
  connection:
    | Pick<ConnectionConfig, 'environment' | 'readOnly'>
    | null
    | undefined;
  className?: string;
}) {
  const t = useTranslations('connectionBadges');
  if (!connection || (!connection.environment && !connection.readOnly))
    return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {connection.environment && (
        <span
          className={cn(
            'rounded px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide',
            TONE[connection.environment],
          )}
          title={t(`${connection.environment}.title`)}
        >
          {t(`${connection.environment}.short`)}
        </span>
      )}
      {connection.readOnly && (
        <span
          className="text-muted-foreground inline-flex"
          title={t('readOnly')}
          aria-label={t('readOnly')}
        >
          <Lock className="h-3 w-3" />
        </span>
      )}
    </span>
  );
}
