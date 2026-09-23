import { describe, expect, it } from 'vitest';
import type { Bridge } from '@syncle/core';
import { builderReducer, initialDraft } from './draft';
import { buildInput, loadBridge, type BuildInputContext } from './mapping';
import {
  SCHEDULE_PRESETS,
  blankSchedule,
  knownTimeZones,
  presetOf,
  scheduleProblem,
} from './schedule-options';

const ctx: BuildInputContext = {
  columns: ['id', 'name'],
  singlePk: 'id',
  fallbackName: 'b',
};

function ready() {
  let d = initialDraft();
  d = builderReducer(d, { type: 'selectConnection', connectionId: 'c1' });
  d = builderReducer(d, { type: 'selectTable', table: 'users' });
  return { ...d, dest: { ...d.dest, url: 'https://example.com/hook' } };
}

describe('the lines offered by name', () => {
  it('are lines the schema takes, each of them once', () => {
    for (const preset of SCHEDULE_PRESETS)
      expect(
        scheduleProblem({ cron: preset.cron, timezone: 'UTC', enabled: true }),
      ).toBeNull();
    expect(new Set(SCHEDULE_PRESETS.map((p) => p.cron)).size).toBe(
      SCHEDULE_PRESETS.length,
    );
  });

  it('a line is recognised however it is spaced; anything else is custom', () => {
    expect(presetOf('0 2 * * *')).toBe('nightly');
    expect(presetOf('  0   2 *  * * ')).toBe('nightly');
    expect(presetOf('0 2 * * 1-5')).toBe('weekdays');
    expect(presetOf('5 2 * * *')).toBe('custom');
    expect(presetOf('')).toBe('custom');
  });
});

describe('a new schedule', () => {
  it('is nightly, on, and in the zone of whoever is building it', () => {
    const blank = blankSchedule();
    expect(blank).toMatchObject({ cron: '0 2 * * *', enabled: true });
    expect(scheduleProblem(blank)).toBeNull();
    // (the test process has a zone, or falls back to UTC: either is a name the schema takes)
    expect(blank.timezone).toMatch(/^(UTC|[A-Za-z_]+\/.+)$/);
  });

  it('the zones suggested are names, and UTC is among them', () => {
    const zones = knownTimeZones();
    if (zones.length > 0) {
      expect(zones).toContain('UTC');
      expect(zones).toContain('Europe/Rome');
    }
  });
});

describe('what stops a save', () => {
  it('no schedule is no problem; a bad line or zone is, and says which', () => {
    expect(scheduleProblem(null)).toBeNull();
    expect(
      scheduleProblem({ cron: '0 25 * * *', timezone: 'UTC', enabled: true }),
    ).toMatchObject({
      field: 'cron',
      message: expect.stringMatching(/not a hour/),
    });
    expect(
      scheduleProblem({ cron: '', timezone: 'UTC', enabled: true }),
    ).toMatchObject({ field: 'cron' });
    expect(
      scheduleProblem({ cron: '0 2 * * *', timezone: 'CET+1', enabled: true }),
    ).toEqual({ field: 'timezone' });
    // one that is switched off is still saved, so it still has to be right
    expect(
      scheduleProblem({ cron: 'nope', timezone: 'UTC', enabled: false }),
    ).toMatchObject({ field: 'cron' });
  });
});

describe('through the builder', () => {
  it('on demand by default: a replay trigger with nothing on it', () => {
    expect(buildInput(ready(), ctx).trigger).toEqual({ kind: 'replay' });
  });

  it('switched on, edited, saved — in one spelling', () => {
    let d = builderReducer(ready(), {
      type: 'setSchedule',
      schedule: { cron: '0 2 * * *', timezone: 'Europe/Rome', enabled: true },
    });
    d = builderReducer(d, {
      type: 'patchSchedule',
      patch: { cron: ' 30   4 * *  1 ' },
    });
    expect(buildInput(d, ctx).trigger).toEqual({
      kind: 'replay',
      schedule: { cron: '30 4 * * 1', timezone: 'Europe/Rome', enabled: true },
    });
    // off keeps the line
    d = builderReducer(d, { type: 'patchSchedule', patch: { enabled: false } });
    expect(buildInput(d, ctx).trigger).toMatchObject({
      schedule: { cron: '30 4 * * 1', enabled: false },
    });
    // back to on demand: gone
    d = builderReducer(d, { type: 'setSchedule', schedule: null });
    expect(buildInput(d, ctx).trigger).toEqual({ kind: 'replay' });
    // patching a schedule that is not there does not invent one
    expect(
      builderReducer(d, { type: 'patchSchedule', patch: { cron: '* * * * *' } })
        .schedule,
    ).toBeNull();
  });

  it('a live bridge has no schedule, whatever the draft still remembers', () => {
    let d = builderReducer(ready(), {
      type: 'setSchedule',
      schedule: blankSchedule(),
    });
    d = builderReducer(d, { type: 'setSyncMode', syncMode: 'live' });
    expect(buildInput(d, ctx).trigger.kind).not.toBe('replay');
    expect(JSON.stringify(buildInput(d, ctx).trigger)).not.toContain('cron');
  });

  it('a saved schedule survives an edit; a bridge saved before there were schedules has none', () => {
    const base = buildInput(
      builderReducer(ready(), {
        type: 'setSchedule',
        schedule: {
          cron: '15 1 * * *',
          timezone: 'Asia/Kabul',
          enabled: false,
        },
      }),
      ctx,
    );
    const saved = {
      ...base,
      id: 'b1',
      workspaceId: 'w',
      createdAt: '',
      updatedAt: '',
    } as unknown as Bridge;
    const loaded = loadBridge(saved);
    expect(loaded.schedule).toEqual({
      cron: '15 1 * * *',
      timezone: 'Asia/Kabul',
      enabled: false,
    });
    expect(buildInput(loaded, ctx).trigger).toEqual(base.trigger);
    expect(
      loadBridge({ ...saved, trigger: { kind: 'replay' } }).schedule,
    ).toBeNull();
  });
});
