'use client';

/**
 * a scheduled bridge, on its own page: when it runs next — and, when the last
 * tick did NOT start a run, that it did not and why. a schedule that silently
 * is not firing (the bridge disabled, the queue down when it was saved) is the
 * thing this exists to make visible.
 */
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { useBridgeSchedule } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function ScheduleNotice({
  bridgeId,
  enabled,
}: {
  bridgeId: string;
  enabled: boolean;
}) {
  const t = useTranslations('scheduleNotice');
  const format = useFormatter();
  const { data: status } = useBridgeSchedule(bridgeId, enabled);
  if (!status?.schedule) return null;
  const { schedule } = status;
  const trouble =
    status.lastOutcome === 'failed' || status.lastOutcome === 'skipped-active';
  // wanted but not registered: saved while the queue was away. it is put right at the next start of the API
  const notRegistered = schedule.enabled && !status.active;
  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      timeZone: schedule.timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const Icon = trouble || notRegistered ? AlertTriangle : CalendarClock;

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 border-b px-4 py-1.5 text-xs',
        trouble || notRegistered
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p>
          <span className="font-mono">{schedule.cron}</span>{' '}
          <span className="opacity-80">({schedule.timezone})</span>
          {' · '}
          {status.nextRuns[0]
            ? t('next', { when: when(status.nextRuns[0]) })
            : schedule.enabled
              ? t('notFiring')
              : t('off')}
        </p>
        {status.lastOutcome === 'skipped-active' && status.lastTickAt && (
          <p>{t('skipped', { when: when(status.lastTickAt) })}</p>
        )}
        {status.lastOutcome === 'failed' && status.lastTickAt && (
          <p>
            {t('failed', {
              when: when(status.lastTickAt),
              error: status.lastError ?? '',
            })}
          </p>
        )}
      </div>
    </div>
  );
}
