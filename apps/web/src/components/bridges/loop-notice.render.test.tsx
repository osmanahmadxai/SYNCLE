/**
 * the line a bridge's page shows when it is tied to another bridge in a ring —
 * in every language, in each of its states. silent for a bridge that is not.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BridgeLoopStatus } from '@syncle/core';
import { queryKeys } from '@/lib/queries';
import { LoopNotice } from './loop-notice';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(locale: string, status: BridgeLoopStatus | null): string {
  const client = new QueryClient();
  if (status) client.setQueryData(queryKeys.bridgeLoops('b1'), status);
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <QueryClientProvider client={client}>
        <LoopNotice bridgeId="b1" />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/loopNotice\.\w/);
  return html;
}

const back = { bridgeId: 'b2', name: 'warehouse → shop' };
const third = { bridgeId: 'b3', name: 'shop → archive' };

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  it('says nothing for a bridge that is tied to nobody — or only on one side', () => {
    expect(render(locale, null)).toBe('');
    expect(
      render(locale, { guard: true, fedBy: [], feeds: [], heldBack: 0 }),
    ).toBe('');
    // a chain is not a ring: fed by one bridge, feeding nobody (or the other way round)
    expect(
      render(locale, { guard: true, fedBy: [back], feeds: [], heldBack: 0 }),
    ).toBe('');
    expect(
      render(locale, { guard: true, fedBy: [], feeds: [back], heldBack: 0 }),
    ).toBe('');
  });

  it('names the other bridge ONCE, and counts what was held back only when something was', () => {
    const quiet = render(locale, {
      guard: true,
      fedBy: [back],
      feeds: [back],
      heldBack: 0,
    });
    expect(quiet.split('warehouse → shop')).toHaveLength(2);
    expect(quiet.split('<p>')).toHaveLength(2); // one line: nothing was held back, so nothing is said of it
    expect(quiet).not.toContain('amber');

    const busy = render(locale, {
      guard: true,
      fedBy: [back],
      feeds: [back],
      heldBack: 1234,
    });
    expect(busy.split('<p>')).toHaveLength(3);
    // (1,234 / 1.234 / 1234: however the language groups its digits)
    expect(busy).toMatch(/1\D?234/);
  });

  it('a longer ring names every bridge in it', () => {
    const html = render(locale, {
      guard: true,
      fedBy: [third],
      feeds: [back],
      heldBack: 1,
    });
    expect(html).toContain('warehouse → shop');
    expect(html).toContain('shop → archive');
  });

  it('with the guard switched off it is a WARNING, and says which setting', () => {
    const html = render(locale, {
      guard: false,
      fedBy: [back],
      feeds: [back],
      heldBack: 0,
    });
    expect(html).toContain('amber');
    expect(html).toContain('SYNCLE_ECHO_TTL_SECONDS');
    expect(html).toContain('warehouse → shop');
  });
});
