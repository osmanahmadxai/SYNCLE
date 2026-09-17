'use client';

/**
 * a bridge's runs, newest first, as a strip of chips: which one is showing, how
 * each one ended, and a way to look at an older one. a bridge page used to show
 * its LATEST run and nothing else — the run that failed last Tuesday was there,
 * in the API, and nowhere on the screen.
 */
import { useTranslations } from 'next-intl';
import type { BridgeJob } from '@syncle/core';
import { cn } from '@/lib/utils';

/** the dot's colour says how the run ended; a run that is going pulses */
export function jobTone(
  job: Pick<BridgeJob, 'status' | 'failedCount'>,
): 'running' | 'ok' | 'warn' | 'bad' | 'idle' {
  if (['queued', 'running', 'canceling'].includes(job.status)) return 'running';
  if (job.status === 'failed' || job.status === 'interrupted') return 'bad';
  if (job.status === 'completed') return job.failedCount > 0 ? 'warn' : 'ok';
  // paused by someone, or canceled: neither good nor bad news
  return job.failedCount > 0 ? 'warn' : 'idle';
}

const DOT: Record<ReturnType<typeof jobTone>, string> = {
  running: 'bg-sky-500 animate-pulse',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  idle: 'bg-slate-400',
};

export function JobStrip({
  jobs,
  selectedId,
  onSelect,
  locale,
}: {
  jobs: BridgeJob[];
  selectedId: string | null;
  onSelect: (jobId: string) => void;
  locale?: string;
}) {
  const t = useTranslations('jobStrip');
  // one run is the page itself: a strip of one chip says nothing
  if (jobs.length < 2) return null;
  const when = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <nav
      aria-label={t('label')}
      className="flex items-center gap-1.5 overflow-x-auto border-b px-4 py-1.5"
    >
      <span className="text-muted-foreground shrink-0 text-[11px]">
        {t('runs', { count: jobs.length })}
      </span>
      {jobs.map((job) => {
        const tone = jobTone(job);
        const on = job.id === selectedId;
        return (
          <button
            key={job.id}
            onClick={() => onSelect(job.id)}
            aria-current={on ? 'true' : undefined}
            title={t(`tone.${tone}`, { failed: job.failedCount })}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              on
                ? 'bg-accent border-foreground/30 font-medium'
                : 'hover:bg-accent/60',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} />
            {when.format(new Date(job.startedAt))}
            {job.failedCount > 0 && (
              <span className="text-red-600 dark:text-red-500">
                {job.failedCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
