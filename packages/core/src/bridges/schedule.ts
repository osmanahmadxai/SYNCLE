/**
 * a replay that runs by itself: "every night at two", as a cron line and the
 * time zone it is meant in.
 *
 * What is checked here is the SHAPE of the line — five fields, each of them
 * something a crontab would take — so that the builder can say what is wrong
 * while it is being typed, in the browser. It is deliberately the classic
 * syntax and nothing else: the API has the last word, by asking the library
 * that will fire the schedule to parse it, and a line that passes here must
 * never be one that library reads differently.
 */
import { z } from 'zod';

interface FieldRule {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const FIELDS: readonly FieldRule[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  // 0 and 7 are both Sunday
  { name: 'day of week', min: 0, max: 7, names: DAYS },
];

/** a number or a name of the field, as a number; null = neither */
function valueOf(text: string, rule: FieldRule): number | null {
  if (/^\d{1,2}$/.test(text)) {
    const n = Number(text);
    return n >= rule.min && n <= rule.max ? n : null;
  }
  const at = rule.names?.indexOf(text.toLowerCase() as never) ?? -1;
  if (at < 0) return null;
  return rule.names === MONTHS ? at + 1 : at;
}

function partProblem(part: string, rule: FieldRule): string | null {
  const [range, step, ...more] = part.split('/');
  if (more.length > 0 || range === undefined || range === '')
    return `"${part}" is not a ${rule.name}`;
  if (
    step !== undefined &&
    !(/^\d{1,2}$/.test(step) && Number(step) >= 1 && Number(step) <= rule.max)
  ) {
    return `"/${step}" is not a step for the ${rule.name} (1–${rule.max})`;
  }
  if (range === '*') return null;
  const ends = range.split('-');
  if (ends.length > 2) return `"${range}" is not a ${rule.name} range`;
  const values = ends.map((end) => valueOf(end, rule));
  if (values.some((v) => v === null)) {
    return `"${range}" is not a ${rule.name} (${rule.min}–${rule.max}${rule.names ? `, or ${rule.names[0]}–${rule.names[rule.names.length - 1]}` : ''})`;
  }
  if (values.length === 2 && values[0]! > values[1]!)
    return `"${range}" runs backwards`;
  // a step needs something to step through: "5/15" means different things to different crons
  if (step !== undefined && ends.length === 1)
    return `"${part}": a step goes with * or a range (*/${step}, ${range}-${rule.max}/${step})`;
  return null;
}

/** what is wrong with a cron line, in words; null = nothing */
export function cronProblem(line: string): string | null {
  const fields = line.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 6) {
    return 'Six fields would include seconds. A bridge is scheduled by the minute at most: minute, hour, day of month, month, day of week.';
  }
  if (fields.length !== 5) {
    return `A schedule is five fields — minute, hour, day of month, month, day of week — and this has ${fields.length}.`;
  }
  for (const [i, field] of fields.entries()) {
    for (const part of field.split(',')) {
      const problem = partProblem(part, FIELDS[i]!);
      if (problem) return `${problem}.`;
    }
  }
  return null;
}

/** is this a time zone this runtime knows — `Europe/Rome`, `UTC` — and not an offset or an abbreviation? */
export function isValidTimeZone(zone: string): boolean {
  // "+02:00" and "EST" are accepted by some runtimes and mean no daylight saving: not what "9 in the morning" means
  if (!/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const replayScheduleSchema = z.object({
  /** minute hour day-of-month month day-of-week */
  cron: z
    .string()
    .trim()
    .max(120)
    .superRefine((line, ctx) => {
      const problem = cronProblem(line);
      if (problem)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    })
    // one spelling of a line, so that two that mean the same thing are the same
    .transform((line) => line.split(/\s+/).join(' ')),
  /** the zone the line is meant in: "0 2 * * *" is two in the morning THERE, summer and winter */
  timezone: z
    .string()
    .trim()
    .max(64)
    .default('UTC')
    .refine(
      isValidTimeZone,
      'Not a time zone name. Use one like "Europe/Rome" or "UTC" — not an offset or an abbreviation.',
    ),
  /** off keeps the line for later */
  enabled: z.boolean().default(true),
});

export type ReplaySchedule = z.infer<typeof replayScheduleSchema>;

/** what became of a schedule's last tick, as the API reports it */
export interface BridgeScheduleStatus {
  schedule: ReplaySchedule | null;
  /** is a scheduler registered for it right now (the bridge is enabled, the schedule is on, the queue took it) */
  active: boolean;
  /** the next times it fires, soonest first (ISO) */
  nextRuns: string[];
  lastTickAt: string | null;
  /**
   * started          a run was started
   * skipped-active   the run before it was still going: not started twice
   * failed           it could not be started; `lastError` says why
   */
  lastOutcome: 'started' | 'skipped-active' | 'failed' | null;
  lastError: string | null;
}
