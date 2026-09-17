'use client';

/**
 * What a CDC bridge is costing its source, shown only when it is worth a line.
 *
 * A PostgreSQL replication slot makes the server keep every change since the
 * slot's position, read or not. A bridge that is paused or failed keeps its
 * slot, and the source's disk fills in silence — so this says how much is being
 * held, and what to do, before that becomes an outage.
 */
import { useTranslations } from 'next-intl';
import { AlertTriangle, DatabaseZap } from 'lucide-react';
import { useSourceHold } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text =
    unit === 0 || value >= 100
      ? String(Math.round(value))
      : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

export function SourceHoldNotice({
  bridgeId,
  enabled,
}: {
  bridgeId: string;
  enabled: boolean;
}) {
  const t = useTranslations('sourceHold');
  const { data: hold } = useSourceHold(bridgeId, enabled);
  if (!hold || hold.level === 'ok' || !hold.message) return null;
  const critical = hold.level === 'critical';
  const Icon = critical ? AlertTriangle : DatabaseZap;

  return (
    <div
      role={critical ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 border-t px-4 py-2 text-xs',
        critical
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">
          {critical ? t('criticalTitle') : t('warnTitle')}
          {hold.retainedBytes !== null && hold.exists && (
            <span className="ml-1.5 font-normal opacity-80">
              {t('holding', { size: formatBytes(hold.retainedBytes) })}
            </span>
          )}
        </p>
        <p className="opacity-90">{hold.message}</p>
        <p className="font-mono text-[10px] opacity-60">{hold.name}</p>
      </div>
    </div>
  );
}
