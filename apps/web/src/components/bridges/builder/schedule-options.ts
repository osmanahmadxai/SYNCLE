/**
 * the builder's side of a scheduled replay: the lines offered by name, the
 * zone a new schedule starts in, and what is wrong with one that cannot be
 * saved. (when it FIRES is the server's to say — it asks the library that
 * fires it — so the next runs shown in the builder come from there)
 */
import { cronProblem, isValidTimeZone } from '@syncle/core';
import type { ScheduleDraft } from './draft';

/** the lines most schedules are, by name. `custom` is whatever else was typed */
export const SCHEDULE_PRESETS = [
  { key: 'hourly', cron: '0 * * * *' },
  { key: 'nightly', cron: '0 2 * * *' },
  { key: 'weekdays', cron: '0 2 * * 1-5' },
  { key: 'weekly', cron: '0 2 * * 1' },
  { key: 'monthly', cron: '0 2 1 * *' },
] as const;

export type SchedulePresetKey =
  | (typeof SCHEDULE_PRESETS)[number]['key']
  | 'custom';

const oneSpelling = (cron: string) => cron.trim().split(/\s+/).join(' ');

export function presetOf(cron: string): SchedulePresetKey {
  return (
    SCHEDULE_PRESETS.find((p) => p.cron === oneSpelling(cron))?.key ?? 'custom'
  );
}

/** the zone of whoever is building the bridge: "2 in the morning" means theirs unless they say otherwise */
export function localTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function blankSchedule(): ScheduleDraft {
  return { cron: '0 2 * * *', timezone: localTimeZone(), enabled: true };
}

export type ScheduleProblem =
  | { field: 'cron'; message: string }
  | { field: 'timezone' }
  | null;

/** what stops this schedule from being saved; null = nothing. a bridge with no schedule has no problem */
export function scheduleProblem(
  schedule: ScheduleDraft | null,
): ScheduleProblem {
  if (!schedule) return null;
  const cron = cronProblem(schedule.cron);
  if (cron) return { field: 'cron', message: cron };
  if (!isValidTimeZone(schedule.timezone.trim())) return { field: 'timezone' };
  return null;
}

/** every zone this browser knows, for the field's suggestions; empty where it cannot say */
export function knownTimeZones(): string[] {
  try {
    const list =
      (
        Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
      ).supportedValuesOf?.('timeZone') ?? [];
    return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    return [];
  }
}
