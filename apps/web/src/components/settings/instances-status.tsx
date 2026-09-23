'use client';

/**
 * more than one API process on this database: which of them leads (it runs the
 * live change streams and the periodic sweeps), and which one answered. with
 * ONE process — almost every installation — there is nothing to say, and
 * nothing is shown; unless that one does not lead, which means the live
 * bridges are not being read by anybody, and is worth saying.
 */
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, Server } from 'lucide-react';
import type { InstanceInfo } from '@/lib/api';
import { useInstances } from '@/lib/queries';

export function InstancesStatus() {
  const { data } = useInstances(true);
  if (!data) return null;
  return <InstancesReport instances={data} />;
}

export function InstancesReport({ instances }: { instances: InstanceInfo[] }) {
  const t = useTranslations('settingsDialog.instances');
  const format = useFormatter();
  const leaderless = instances.length > 0 && !instances.some((i) => i.leader);
  if (instances.length <= 1 && !leaderless) return null;
  const versions = new Set(instances.map((i) => i.version));
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm">
      <h4 className="flex items-center gap-2 font-medium">
        <Server className="h-4 w-4" />
        {t('title', { count: instances.length })}
      </h4>
      <ul className="space-y-1 text-xs">
        {instances.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-2">
            <span className="font-mono">{i.id.slice(0, 8)}</span>
            <span className="text-muted-foreground">
              {t('since', {
                when: format.dateTime(new Date(i.startedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </span>
            <span className="text-muted-foreground">v{i.version}</span>
            {i.leader && (
              <span className="rounded bg-emerald-500/15 px-1.5 text-emerald-700 dark:text-emerald-400">
                {t('leader')}
              </span>
            )}
            {i.self && (
              <span className="text-muted-foreground">{t('self')}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">{t('explain')}</p>
      {leaderless && (
        <p
          role="alert"
          className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('leaderless')}
        </p>
      )}
      {versions.size > 1 && (
        <p
          role="alert"
          className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('versions')}
        </p>
      )}
    </section>
  );
}
