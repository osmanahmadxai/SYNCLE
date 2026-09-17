/**
 * what a verification found, on the screen, in every language: in sync, drifted
 * (with both readings of what differs), repaired, could not be compared, failed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  BridgeVerification,
  VerificationTargetResult,
} from '@syncle/core';
import { VerificationReport, cell, verdictOf } from './verify-dialog';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(locale: string, verification: BridgeVerification): string {
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <VerificationReport verification={verification} />
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/verify\.\w/);
  return html;
}

const target = (
  over: Partial<VerificationTargetResult> = {},
): VerificationTargetResult => ({
  target: 'public.users_copy',
  connectionId: 'c2',
  unsupported: null,
  notes: [],
  checked: 450,
  missing: 0,
  different: 0,
  extra: 0,
  fixed: 0,
  removed: 0,
  samples: { missing: [], extra: [], different: [] },
  ...over,
});
const verification = (
  over: Partial<BridgeVerification> = {},
): BridgeVerification => ({
  id: 'v1',
  bridgeId: 'b1',
  mode: 'verify',
  deleteExtra: false,
  status: 'completed',
  sourceRows: 450,
  sourceTotal: 450,
  targets: [target()],
  inSync: true,
  error: null,
  startedAt: '2026-09-17T10:00:00.000Z',
  finishedAt: '2026-09-17T10:00:03.000Z',
  ...over,
});

describe('how it turned out', () => {
  it('is said by the verification, not guessed from its counts', () => {
    expect(verdictOf(verification())).toBe('inSync');
    expect(verdictOf(verification({ inSync: false }))).toBe('differs');
    expect(verdictOf(verification({ inSync: null }))).toBe('unknown');
    expect(verdictOf(verification({ status: 'running', inSync: null }))).toBe(
      'running',
    );
    expect(verdictOf(verification({ status: 'queued', inSync: null }))).toBe(
      'running',
    );
    expect(verdictOf(verification({ status: 'failed', inSync: null }))).toBe(
      'failed',
    );
    expect(verdictOf(verification({ status: 'canceled', inSync: null }))).toBe(
      'canceled',
    );
  });

  it('a value is shown as what it is: NULL is not the text "null"', () => {
    expect(cell(null)).toBe('NULL');
    expect(cell(undefined)).toBe('NULL');
    expect(cell('null')).toBe('null');
    expect(cell(5)).toBe('5');
    expect(cell({ a: 1 })).toBe('{"a":1}');
  });
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = (
    messagesOf(locale) as unknown as {
      verify: Record<string, string> & { verdict: Record<string, string> };
    }
  ).verify;

  it('in sync', () => {
    const html = render(locale, verification());
    expect(html).toContain(m.verdict.inSync);
    expect(html).toContain(m.targetInSync);
    expect(html).toContain('public.users_copy');
    expect(html).not.toContain('<table');
  });

  it('drifted: counts, the keys, and BOTH readings of every column that differs', () => {
    const html = render(
      locale,
      verification({
        inSync: false,
        targets: [
          target({
            missing: 40,
            different: 1,
            extra: 1,
            samples: {
              missing: [[7], [301]],
              extra: [['9001']],
              different: [
                {
                  key: [250, 'eu'],
                  columns: [
                    {
                      column: 'email',
                      expected: 'u250@example.com',
                      actual: null,
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    );
    expect(html).toContain(m.verdict.differs);
    expect(html).toContain('7 · 301');
    expect(html).toContain('250, eu');
    expect(html).toContain('u250@example.com');
    expect(html).toContain('NULL');
    // 2 of 40 shown: the count is the count, the list is a sample
    expect(html).toMatch(/2[^0-9]+40/);
    // a verify wrote nothing, so says nothing about writing
    expect(html).not.toContain(`>${m.fixed}<`);
  });

  it('reconciled: what was written and removed is said', () => {
    const html = render(
      locale,
      verification({
        mode: 'reconcile',
        inSync: true,
        targets: [
          target({ missing: 2, different: 1, extra: 1, fixed: 3, removed: 1 }),
        ],
      }),
    );
    expect(html).toContain(`>${m.fixed}<`);
    expect(html).toContain(`>${m.removed}<`);
    expect(html).toContain(m.targetInSync);
  });

  it('a target that cannot be compared says why; extras that were not looked for are not shown as zero', () => {
    const html = render(
      locale,
      verification({
        inSync: null,
        targets: [
          target({
            unsupported:
              'A redis destination cannot be asked for rows by key, so it cannot be compared.',
          }),
          target({
            target: 'archive',
            extra: null,
            notes: ['This target keeps rows that were deleted at the source.'],
          }),
        ],
      }),
    );
    expect(html).toContain('cannot be asked for rows by key');
    expect(html).toContain(m.notLookedFor);
    expect(html).toContain('keeps rows that were deleted');
    expect(html).toContain(m.verdict.unknown);
  });

  it('running shows how far it is; failed shows the error', () => {
    const running = render(
      locale,
      verification({
        status: 'running',
        inSync: null,
        sourceRows: 90,
        sourceTotal: 450,
        targets: [],
      }),
    );
    expect(running).toContain('20%');
    expect(running).toContain(m.verdict.running);
    // no total to go by (PostgreSQL has not analysed the table): no percentage, and no NaN
    const blind = render(
      locale,
      verification({
        status: 'running',
        inSync: null,
        sourceRows: 90,
        sourceTotal: null,
        targets: [],
      }),
    );
    expect(blind).not.toMatch(/%|NaN/);
    const failed = render(
      locale,
      verification({
        status: 'failed',
        inSync: null,
        error: 'connect ECONNREFUSED 10.0.0.5:5432',
        targets: [],
      }),
    );
    expect(failed).toContain('ECONNREFUSED');
    expect(failed).toContain(m.verdict.failed);
  });
});
