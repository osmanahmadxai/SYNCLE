import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BridgeJob } from '@syncle/core';
import { JobStrip, jobTone } from './job-strip';

const job = (over: Partial<BridgeJob>): BridgeJob =>
  ({
    id: 'j',
    bridgeId: 'b',
    status: 'completed',
    sentCount: 10,
    failedCount: 0,
    skippedCount: 0,
    totalCount: 10,
    cursorOffset: 10,
    error: null,
    startedAt: '2026-09-17T10:00:00.000Z',
    finishedAt: '2026-09-17T10:01:00.000Z',
    ...over,
  }) as BridgeJob;

describe('how a run ended, at a glance', () => {
  it('green only when nothing failed; amber when it finished but deliveries failed; red when a failure stopped it', () => {
    expect(jobTone(job({}))).toBe('ok');
    expect(jobTone(job({ failedCount: 3 }))).toBe('warn');
    expect(jobTone(job({ status: 'failed', failedCount: 1 }))).toBe('bad');
    expect(jobTone(job({ status: 'interrupted' }))).toBe('bad');
    for (const status of ['queued', 'running', 'canceling'] as const)
      expect(jobTone(job({ status }))).toBe('running');
    // stopped by someone: not a failure…
    expect(jobTone(job({ status: 'paused' as never }))).toBe('idle');
    expect(jobTone(job({ status: 'canceled' }))).toBe('idle');
    // …unless it left failures behind
    expect(jobTone(job({ status: 'canceled', failedCount: 2 }))).toBe('warn');
  });
});

describe.each(['en', 'it', 'zh'])('the job strip in %s', (locale) => {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;
  const render = (jobs: BridgeJob[], selectedId: string | null) => {
    const problems: string[] = [];
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
        onError={(e) => problems.push(e.message)}
      >
        <JobStrip
          jobs={jobs}
          selectedId={selectedId}
          onSelect={() => undefined}
          locale={locale}
        />
      </NextIntlClientProvider>,
    );
    expect(problems).toEqual([]);
    expect(html).not.toMatch(/jobStrip\.\w/);
    return html;
  };

  it('is not there for a bridge with one run: that run is the page', () => {
    expect(render([], null)).toBe('');
    expect(render([job({ id: 'only' })], 'only')).toBe('');
  });

  it('has one chip per run in every state, marks the one that is showing, and counts failures', () => {
    const jobs = [
      job({ id: 'a', status: 'running' }),
      job({ id: 'b', failedCount: 4 }),
      job({ id: 'c', status: 'failed', failedCount: 1 }),
      job({ id: 'd' }),
      job({ id: 'e', status: 'canceled' }),
    ];
    const html = render(jobs, 'c');
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    for (const dot of [
      'bg-sky-500',
      'bg-amber-500',
      'bg-red-500',
      'bg-emerald-500',
      'bg-slate-400',
    ])
      expect(html).toContain(dot);
    expect(html).toContain('>4<');
  });
});
