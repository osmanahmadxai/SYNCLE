/**
 * scheduled replays on the screen, in every language: the builder's section in
 * each of its states, the bridge page's line, and the mark on a run the schedule
 * started. what this catches is a label asked for under a key that is not there.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { BridgeJob, BridgeScheduleStatus } from '@syncle/core';
import { ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queries';
import { ScheduleSection } from './builder/schedule-section';
import { ScheduleNotice } from './schedule-notice';
import { JobStrip } from './job-strip';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(
  locale: string,
  element: ReactElement,
  seed?: (client: QueryClient) => void,
): string {
  const client = new QueryClient();
  seed?.(client);
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/(bridgeBuilder|scheduleNotice|jobStrip)\.\w/);
  return html;
}

const nightly = { cron: '0 2 * * *', timezone: 'Europe/Rome', enabled: true };
const status = (over: Partial<BridgeScheduleStatus>): BridgeScheduleStatus => ({
  schedule: nightly,
  active: true,
  nextRuns: ['2026-09-18T00:00:00.000Z'],
  lastTickAt: null,
  lastOutcome: null,
  lastError: null,
  ...over,
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = messagesOf(locale) as unknown as {
    bridgeBuilder: { schedule: Record<string, string> };
    scheduleNotice: Record<string, string>;
    jobStrip: Record<string, string>;
  };
  const section = (schedule: typeof nightly | null) => (
    <ScheduleSection draft={{ schedule }} dispatch={() => undefined} />
  );

  it('on demand: the choice and nothing else', () => {
    const html = render(locale, section(null));
    expect(html).toContain(m.bridgeBuilder.schedule.onDemand);
    expect(html).not.toContain('schedule-cron');
  });

  it('scheduled: the line, the zone, the switch — and the next runs the SERVER gave, in the schedule’s zone', () => {
    const html = render(locale, section(nightly), (client) =>
      client.setQueryData(['schedulePreview', nightly.cron, nightly.timezone], {
        nextRuns: [
          '2026-09-18T00:00:00.000Z',
          '2026-09-19T00:00:00.000Z',
          '2026-09-20T00:00:00.000Z',
          '2026-09-21T00:00:00.000Z',
        ],
      }),
    );
    expect(html).toContain('value="0 2 * * *"');
    expect(html).toContain('value="Europe/Rome"');
    // 00:00 UTC is 02:00 in Rome in September: the zone of the schedule, not of the page
    expect(html.match(/02:00/g)?.length).toBeGreaterThanOrEqual(3);
    // three are shown, however many came
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).not.toContain('role="alert"');
  });

  it('a line that cannot be one: says what is wrong with it, and asks the server nothing', () => {
    const html = render(locale, section({ ...nightly, cron: '0 25 * * *' }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('&quot;25&quot; is not a hour');
    expect(html).toContain('aria-invalid="true"');
    const zone = render(locale, section({ ...nightly, timezone: 'CET+1' }));
    expect(zone).toContain(
      m.bridgeBuilder.schedule.timezoneProblem!.slice(0, 10),
    );
  });

  it('into a target that only inserts: warned that every run inserts everything again — and only then', () => {
    const target = (writeMode: 'insert' | 'upsert') => ({ writeMode }) as never;
    const withTargets = (destKind: 'http' | 'database', targets: never[]) => (
      <ScheduleSection
        draft={{ schedule: nightly, destKind, dbTargets: targets }}
        dispatch={() => undefined}
      />
    );
    const warning = m.bridgeBuilder.schedule.insertWarning!.slice(0, 16);
    expect(
      render(
        locale,
        withTargets('database', [target('upsert'), target('insert')]),
      ),
    ).toContain(warning);
    expect(
      render(locale, withTargets('database', [target('upsert')])),
    ).not.toContain(warning);
    // a webhook bridge keeps whatever targets the draft remembers; they are not where it sends
    expect(
      render(locale, withTargets('http', [target('insert')])),
    ).not.toContain(warning);
    expect(
      render(
        locale,
        <ScheduleSection
          draft={{
            schedule: null,
            destKind: 'database',
            dbTargets: [target('insert')],
          }}
          dispatch={() => undefined}
        />,
      ),
    ).not.toContain(warning);
  });

  it('a line the server refuses: its reason is shown instead of run times', () => {
    const html = render(locale, section(nightly), (client) => {
      const key = ['schedulePreview', nightly.cron, nightly.timezone];
      client
        .getQueryCache()
        .build(client, { queryKey: key })
        .setState({
          status: 'error',
          error: new ApiError(
            'This schedule cannot be used: whatever the library said',
            'BAD_REQUEST',
            400,
          ),
          fetchStatus: 'idle',
        } as never);
    });
    expect(html).toContain('This schedule cannot be used');
  });

  it('the bridge page: the line and when it runs next; nothing at all for a bridge without one', () => {
    const at = (s: BridgeScheduleStatus) => (client: QueryClient) =>
      client.setQueryData(queryKeys.bridgeSchedule('b1'), s);
    const notice = <ScheduleNotice bridgeId="b1" enabled />;
    expect(
      render(
        locale,
        notice,
        at(status({ schedule: null, active: false, nextRuns: [] })),
      ),
    ).toBe('');
    expect(render(locale, notice)).toBe('');

    const ok = render(locale, notice, at(status({})));
    expect(ok).toContain('0 2 * * *');
    expect(ok).toContain('02:00');
    expect(ok).not.toContain('amber');

    const off = render(
      locale,
      notice,
      at(
        status({
          schedule: { ...nightly, enabled: false },
          active: false,
          nextRuns: [],
        }),
      ),
    );
    expect(off).toContain(m.scheduleNotice.off);
    expect(off).not.toContain('amber');

    const stuck = render(
      locale,
      notice,
      at(status({ active: false, nextRuns: [] })),
    );
    expect(stuck).toContain('amber');

    const skipped = render(
      locale,
      notice,
      at(
        status({
          lastOutcome: 'skipped-active',
          lastTickAt: '2026-09-17T00:00:00.000Z',
        }),
      ),
    );
    expect(skipped).toContain('amber');
    const failed = render(
      locale,
      notice,
      at(
        status({
          lastOutcome: 'failed',
          lastTickAt: '2026-09-17T00:00:00.000Z',
          lastError: 'The job queue (Redis) is unavailable.',
        }),
      ),
    );
    expect(failed).toContain('The job queue (Redis) is unavailable.');
  });

  it('a run the schedule started is marked; one a person started is not', () => {
    const job = (id: string, startedBy: 'manual' | 'schedule'): BridgeJob =>
      ({
        id,
        bridgeId: 'b',
        status: 'completed',
        failedCount: 0,
        startedAt: '2026-09-17T10:00:00.000Z',
        startedBy,
      }) as BridgeJob;
    const html = render(
      locale,
      <JobStrip
        jobs={[job('a', 'schedule'), job('b', 'manual')]}
        selectedId="a"
        onSelect={() => undefined}
        locale={locale}
      />,
    );
    expect(html.split(m.jobStrip.scheduled!).length - 1).toBe(2); // the icon's label and the chip's title, on ONE chip
  });
});
