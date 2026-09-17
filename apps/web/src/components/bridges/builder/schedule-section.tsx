'use client';

/**
 * a one-time bridge that runs by itself: on a cron line, in a named time zone.
 *
 * the line is always shown and always editable — the presets only fill it in —
 * so what is saved is what is on the screen. when it FIRES is asked of the
 * server, which asks the library that fires it: the builder never shows a time
 * it worked out by itself.
 */
import type { Dispatch } from 'react';
import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ApiError } from '@/lib/api';
import { useSchedulePreview } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BuilderAction, BuilderDraft } from './draft';
import {
  SCHEDULE_PRESETS,
  blankSchedule,
  knownTimeZones,
  presetOf,
  scheduleProblem,
} from './schedule-options';

export function ScheduleSection({
  draft,
  dispatch,
}: {
  draft: Pick<BuilderDraft, 'schedule'> &
    Partial<Pick<BuilderDraft, 'destKind' | 'dbTargets'>>;
  dispatch: Dispatch<BuilderAction>;
}) {
  const t = useTranslations('bridgeBuilder.schedule');
  const format = useFormatter();
  const { schedule } = draft;
  const problem = scheduleProblem(schedule);
  // every run sends the whole source again: into a target that only inserts, that is every row, again
  const insertsAgain =
    !!schedule &&
    draft.destKind === 'database' &&
    (draft.dbTargets ?? []).some((target) => target.writeMode === 'insert');
  const zones = useMemo(() => knownTimeZones(), []);
  // only a line with the shape of one is worth a question to the server
  const preview = useSchedulePreview(
    schedule && !problem
      ? {
          cron: schedule.cron.trim().split(/\s+/).join(' '),
          timezone: schedule.timezone.trim(),
        }
      : null,
  );
  const refused =
    preview.error instanceof ApiError
      ? preview.error.message
      : preview.error
        ? String(preview.error)
        : null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <div className="flex overflow-hidden rounded-md border text-xs">
        {(
          [
            [false, t('onDemand')],
            [true, t('onSchedule')],
          ] as const
        ).map(([scheduled, label]) => (
          <button
            key={String(scheduled)}
            type="button"
            aria-pressed={!!schedule === scheduled}
            onClick={() =>
              dispatch({
                type: 'setSchedule',
                schedule: scheduled ? (schedule ?? blankSchedule()) : null,
              })
            }
            className={cn(
              'flex-1 px-2.5 py-1.5 transition-colors',
              !!schedule === scheduled
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-[11px]">
        {schedule ? t('scheduledDesc') : t('onDemandDesc')}
      </p>

      {schedule && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t('preset')}</Label>
              <Select
                value={presetOf(schedule.cron)}
                onValueChange={(key) => {
                  const preset = SCHEDULE_PRESETS.find((p) => p.key === key);
                  if (preset)
                    dispatch({
                      type: 'patchSchedule',
                      patch: { cron: preset.cron },
                    });
                }}
              >
                <SelectTrigger className="h-8" aria-label={t('preset')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {t(`presets.${p.key}`)}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">{t('presets.custom')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs" htmlFor="schedule-cron">
                {t('cron')}
              </Label>
              <Input
                id="schedule-cron"
                className="h-8 font-mono text-xs"
                value={schedule.cron}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={problem?.field === 'cron'}
                onChange={(e) =>
                  dispatch({
                    type: 'patchSchedule',
                    patch: { cron: e.target.value },
                  })
                }
              />
            </div>
          </div>
          <p className="text-muted-foreground font-mono text-[10px]">
            {t('cronFields')}
          </p>

          <div className="grid gap-1.5">
            <Label className="text-xs" htmlFor="schedule-zone">
              {t('timezone')}
            </Label>
            <Input
              id="schedule-zone"
              className="h-8 text-xs"
              list="schedule-zones"
              value={schedule.timezone}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={problem?.field === 'timezone'}
              onChange={(e) =>
                dispatch({
                  type: 'patchSchedule',
                  patch: { timezone: e.target.value },
                })
              }
            />
            <datalist id="schedule-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="text-muted-foreground text-[11px]">
              {t('timezoneHint')}
            </p>
          </div>

          {problem ? (
            <p role="alert" className="text-destructive text-xs">
              {problem.field === 'cron'
                ? problem.message
                : t('timezoneProblem')}
            </p>
          ) : refused ? (
            <p role="alert" className="text-destructive text-xs">
              {refused}
            </p>
          ) : (
            preview.data && (
              <div className="text-xs">
                <p className="text-muted-foreground">
                  {t('nextRuns', { zone: schedule.timezone.trim() })}
                </p>
                <ul className="font-mono text-[11px]">
                  {preview.data.nextRuns.slice(0, 3).map((at) => (
                    <li key={at}>
                      {format.dateTime(new Date(at), {
                        timeZone: schedule.timezone.trim(),
                        weekday: 'short',
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}

          <div className="flex items-start gap-2">
            <Switch
              id="schedule-enabled"
              checked={schedule.enabled}
              onCheckedChange={(enabled) =>
                dispatch({ type: 'patchSchedule', patch: { enabled } })
              }
            />
            <div className="space-y-0.5">
              <Label className="text-xs" htmlFor="schedule-enabled">
                {t('enabled')}
              </Label>
              <p className="text-muted-foreground text-[11px]">
                {t('enabledHint')}
              </p>
            </div>
          </div>
          <p className="text-muted-foreground text-[11px]">{t('rules')}</p>
          {insertsAgain && (
            <p
              role="note"
              className="text-xs text-amber-700 dark:text-amber-400"
            >
              {t('insertWarning')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
