import { describe, expect, it } from 'vitest';
import { bridgeInputSchema } from './bridge-config';
import { cronProblem, isValidTimeZone, replayScheduleSchema } from './schedule';

describe('cronProblem', () => {
  it.each([
    '0 2 * * *',
    '*/15 * * * *',
    '0 9-17 * * 1-5',
    '0 9-17/2 * * mon-fri',
    '30 6 1,15 * *',
    '0 0 1 JAN,jul *',
    '0 0 * * 7',
    '5,35 */4 * * sun',
    '  0   2   *  *  *  ',
  ])('takes %j', (line) => {
    expect(cronProblem(line)).toBeNull();
  });

  it.each([
    ['', /five fields/],
    ['* * * *', /this has 4/],
    ['0 0 2 * * *', /seconds/],
    ['60 * * * *', /"60" is not a minute/],
    ['* 24 * * *', /"24" is not a hour/],
    ['* * 0 * *', /"0" is not a day of month/],
    ['* * * 13 *', /not a month/],
    ['* * * * 8', /not a day of week/],
    ['* * * * funday', /not a day of week/],
    ['* * * mon *', /not a month/],
    ['10-5 * * * *', /runs backwards/],
    ['*/0 * * * *', /not a step/],
    ['*/x * * * *', /not a step/],
    ['5/15 * * * *', /a step goes with \* or a range/],
    ['1-2-3 * * * *', /not a minute range/],
    ['*/5/2 * * * *', /is not a minute/],
    [', * * * *', /is not a minute/],
    ['@hourly', /this has 1/],
    ['* * L * *', /not a day of month/],
    ['* * * * 1#2', /not a day of week/],
    ['* * ? * *', /not a day of month/],
    ['-1 * * * *', /not a minute/],
    ['1.5 * * * *', /not a minute/],
    ['0x10 * * * *', /not a minute/],
  ])('says what is wrong with %j', (line, problem) => {
    expect(cronProblem(line)).toMatch(problem);
  });
});

describe('isValidTimeZone', () => {
  it('takes the names of zones, and UTC', () => {
    for (const zone of [
      'UTC',
      'Europe/Rome',
      'Asia/Kabul',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+5',
    ]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });
  it('not offsets, abbreviations or made-up places: none of them says when summer time starts', () => {
    for (const zone of [
      '',
      '+02:00',
      'EST',
      'GMT+2',
      'Europe/Atlantis',
      'Europe/',
      'utc',
      'Europe/Rome; DROP',
    ]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });
});

describe('replayScheduleSchema', () => {
  it('fills in UTC and on, and spells the line one way', () => {
    expect(replayScheduleSchema.parse({ cron: '  0   2 * *   * ' })).toEqual({
      cron: '0 2 * * *',
      timezone: 'UTC',
      enabled: true,
    });
  });

  it('refuses with the reason, not with "invalid"', () => {
    const bad = replayScheduleSchema.safeParse({
      cron: '0 25 * * *',
      timezone: 'Mars/Olympus',
    });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map((i) => i.message).join(' | ');
    expect(messages).toMatch(/"25" is not a hour/);
    expect(messages).toMatch(/Not a time zone name/);
  });

  it('belongs to a replay trigger, and only to that', () => {
    const base = {
      name: 'b',
      source: { kind: 'table', connectionId: 'c', table: 't' },
      destination: { kind: 'http', url: 'https://example.com' },
      transform: { template: '{{$row}}' },
    };
    const parsed = bridgeInputSchema.parse({
      ...base,
      trigger: {
        kind: 'replay',
        schedule: { cron: '0 2 * * *', timezone: 'Europe/Rome' },
      },
    });
    expect(parsed.trigger).toEqual({
      kind: 'replay',
      schedule: { cron: '0 2 * * *', timezone: 'Europe/Rome', enabled: true },
    });
    // a bridge saved before there were schedules is a replay with none
    expect(bridgeInputSchema.parse(base).trigger).toEqual({ kind: 'replay' });
    expect(
      bridgeInputSchema.safeParse({
        ...base,
        trigger: { kind: 'replay', schedule: { cron: 'every day' } },
      }).success,
    ).toBe(false);
  });
});
