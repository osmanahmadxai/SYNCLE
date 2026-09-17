import { describe, expect, it } from 'vitest';
import { cronProblem, type Bridge } from '@syncle/core';
import {
  nextRuns,
  scheduleOf,
  wantsScheduler,
} from './bridge-schedule.service';
import { withScheduleOff } from './bridge-transfer.service';

const FROM = new Date('2026-09-17T00:00:00.000Z'); // a Thursday

/** the local wall-clock of an instant, as `Thu 09:00` */
const local = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(iso))
    .replace(',', '');

describe('a line the shape check takes is a line the firing library takes — and reads the same way', () => {
  // [line, zone, the first fires as local wall-clock]
  const cases: Array<[string, string, string[]]> = [
    ['0 2 * * *', 'UTC', ['Thu 02:00', 'Fri 02:00']],
    [
      '*/15 * * * *',
      'UTC',
      ['Thu 00:15', 'Thu 00:30', 'Thu 00:45', 'Thu 01:00'],
    ],
    [
      '0 9-17/4 * * mon-fri',
      'Europe/Rome',
      ['Thu 09:00', 'Thu 13:00', 'Thu 17:00', 'Fri 09:00'],
    ],
    ['0 0 * * 7', 'UTC', ['Sun 00:00', 'Sun 00:00']],
    ['0 0 * * 0', 'UTC', ['Sun 00:00']],
    ['0 0 * * SUN', 'UTC', ['Sun 00:00']],
    ['30 6 1,15 * *', 'Asia/Kabul', ['Thu 06:30']], // 1 Oct 2026 is a Thursday
    ['5,35 */12 * * *', 'UTC', ['Thu 00:05', 'Thu 00:35', 'Thu 12:05']],
    ['0 0 1 jan,JUL *', 'UTC', ['Fri 00:00']], // 1 Jan 2027
    ['0 12 * 9-10 thu', 'UTC', ['Thu 12:00', 'Thu 12:00']],
  ];
  it.each(cases)('%s in %s', (cron, timezone, expected) => {
    expect(cronProblem(cron)).toBeNull();
    const runs = nextRuns({ cron, timezone }, expected.length, FROM);
    expect(runs.map((at) => local(at, timezone))).toEqual(expected);
    expect([...runs].sort()).toEqual(runs);
    expect(new Date(runs[0]!).getTime()).toBeGreaterThan(FROM.getTime());
  });

  it('day of month AND day of week both given: either one fires it, as in a crontab', () => {
    const runs = nextRuns({ cron: '0 0 13 * 5', timezone: 'UTC' }, 6, FROM).map(
      (at) => at.slice(0, 10),
    );
    // Fridays — and Tuesday the 13th of October
    expect(runs).toEqual([
      '2026-09-18',
      '2026-09-25',
      '2026-10-02',
      '2026-10-09',
      '2026-10-13',
      '2026-10-16',
    ]);
  });
});

describe('summer time', () => {
  it('"02:30 every night" fires once a night: on the night the hour repeats, and on the night it does not exist', () => {
    const back = nextRuns(
      { cron: '30 2 * * *', timezone: 'Europe/Rome' },
      3,
      new Date('2026-10-24T12:00:00Z'),
    );
    // 25 Oct 2026: 02:30 happens twice in Rome. one run, at the first
    expect(back).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
      '2026-10-27T01:30:00.000Z',
    ]);
    const forward = nextRuns(
      { cron: '30 2 * * *', timezone: 'Europe/Rome' },
      2,
      new Date('2027-03-27T12:00:00Z'),
    );
    // 28 Mar 2027: there is no 02:30 in Rome. one run, an hour on — not none
    expect(forward).toEqual([
      '2027-03-28T01:30:00.000Z',
      '2027-03-29T00:30:00.000Z',
    ]);
  });
});

describe('what cannot be used is refused with a reason', () => {
  it('a line only the library could object to', () => {
    // (the shape check refuses all of these first; this is the belt to those braces)
    for (const cron of ['60 * * * *', 'a b c d e', '* * * * * * *']) {
      expect(() => nextRuns({ cron, timezone: 'UTC' }, 1)).toThrowError(
        /This schedule cannot be used/,
      );
    }
    try {
      nextRuns({ cron: '61 * * * *', timezone: 'UTC' }, 1);
    } catch (err) {
      expect((err as { details?: unknown }).details).toEqual({
        reason: 'invalid-schedule',
      });
    }
  });
});

describe('which bridges fire', () => {
  const bridge = (trigger: unknown, enabled = true) =>
    ({ trigger, enabled }) as Pick<Bridge, 'trigger' | 'enabled'>;
  const schedule = { cron: '0 2 * * *', timezone: 'UTC', enabled: true };

  it('a replay with a schedule that is on, on a bridge that is on', () => {
    expect(wantsScheduler(bridge({ kind: 'replay', schedule }))).toEqual(
      schedule,
    );
    expect(
      wantsScheduler(
        bridge({ kind: 'replay', schedule: { ...schedule, enabled: false } }),
      ),
    ).toBeNull();
    expect(
      wantsScheduler(bridge({ kind: 'replay', schedule }, false)),
    ).toBeNull();
    expect(wantsScheduler(bridge({ kind: 'replay' }))).toBeNull();
    expect(
      wantsScheduler(
        bridge({ kind: 'cdc', operations: ['insert'], startFrom: 'now' }),
      ),
    ).toBeNull();
    // …while the line itself is there to be shown either way
    expect(
      scheduleOf(
        bridge({ kind: 'replay', schedule: { ...schedule, enabled: false } }),
      ),
    ).toMatchObject({ enabled: false });
  });

  it('a copy or an import keeps the line and loses the "on"', () => {
    expect(withScheduleOff({ kind: 'replay', schedule })).toEqual({
      trigger: { kind: 'replay', schedule: { ...schedule, enabled: false } },
      wasOn: true,
    });
    expect(
      withScheduleOff({
        kind: 'replay',
        schedule: { ...schedule, enabled: false },
      }).wasOn,
    ).toBe(false);
    expect(withScheduleOff({ kind: 'replay' })).toEqual({
      trigger: { kind: 'replay' },
      wasOn: false,
    });
    const cdc = {
      kind: 'cdc' as const,
      operations: ['insert' as const],
      startFrom: 'now' as const,
    };
    expect(withScheduleOff(cdc)).toEqual({ trigger: cdc, wasOn: false });
  });
});
