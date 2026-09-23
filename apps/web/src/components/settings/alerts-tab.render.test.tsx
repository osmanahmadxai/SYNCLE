/**
 * Settings › Alerts, rendered to a string in every language: every kind of
 * channel's form, and a channel in each state the list can show it in. what
 * this catches is a label asked for under a key that does not exist — which
 * next-intl reports at render time, in the browser, to nobody.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ALERT_EVENT_TYPES,
  ALERT_SECRET_SENTINEL as S,
  type AlertChannel,
} from '@syncle/core';
import { ALERT_KINDS } from './alert-form';
import { AlertsTab, ChannelForm, ChannelRow } from './alerts-tab';

const LOCALES = ['en', 'it', 'zh'] as const;
const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(locale: string, element: ReactElement): string {
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(err) => problems.push(err.message)}
    >
      <QueryClientProvider client={new QueryClient()}>
        {element}
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/alertsTab\.\w/);
  return html;
}

const meta = {
  id: 'c1',
  createdAt: '',
  updatedAt: '',
  lastSentAt: null,
} as const;
const webhook: AlertChannel = {
  ...meta,
  kind: 'webhook',
  name: 'On-call <b>',
  enabled: true,
  events: [...ALERT_EVENT_TYPES],
  url: `https://example.com/${S}`,
  secret: S,
  headers: { 'X-Api-Key': S },
  lastStatus: null,
  lastError: null,
};

describe.each(LOCALES)('Settings › Alerts in %s', (locale) => {
  it('the form of every kind of channel, new', () => {
    for (const kind of ALERT_KINDS) {
      const html = render(
        locale,
        <ChannelForm
          channel={null}
          initialKind={kind}
          onDone={() => undefined}
        />,
      );
      // one checkbox per event the API knows
      // (a Switch renders a checkbox of its own; the events' are the accented ones)
      expect(
        html.match(/type="checkbox" class="accent-primary/g)?.length,
        kind,
      ).toBe(ALERT_EVENT_TYPES.length);
      // nothing is red before Save has been tried
      expect(html).not.toContain('text-destructive');
    }
  });

  it('the form of a stored channel: masked as the API gave it, and its kind fixed', () => {
    const html = render(
      locale,
      <ChannelForm channel={webhook} onDone={() => undefined} />,
    );
    expect(html).toContain(`value="https://example.com/${S}"`);
    expect(html).toContain('value="X-Api-Key"');
    // the name is somebody's text: it is escaped, not markup
    expect(html).toContain('On-call &lt;b&gt;');
    expect(html).toMatch(/role="combobox"[^>]*disabled/);
  });

  it('a channel in the list: never used, delivered, failed, and switched off', () => {
    const never = render(
      locale,
      <ChannelRow channel={webhook} onEdit={() => undefined} />,
    );
    expect(never).not.toContain('text-destructive');
    const ok = render(
      locale,
      <ChannelRow
        channel={{ ...webhook, lastStatus: 'ok' }}
        onEdit={() => undefined}
      />,
    );
    expect(ok).toContain('text-emerald-600');
    const failed = render(
      locale,
      <ChannelRow
        channel={{
          ...webhook,
          enabled: false,
          lastStatus: 'failed',
          lastError: 'HTTP 500: <nope>',
        }}
        onEdit={() => undefined}
      />,
    );
    expect(failed).toContain('text-destructive');
    expect(failed).toContain('HTTP 500: &lt;nope&gt;');
  });

  it('the tab itself, while the list is loading', () => {
    expect(render(locale, <AlertsTab />)).toContain('animate-spin');
  });
});
