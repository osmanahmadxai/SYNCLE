/**
 * Settings › Activity, rendered to a string in every language: an entry says
 * who, what, to what, from where; the page offers the older ones; every action
 * the API can record has a name.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, type AuditEntry, type AuditPage } from '@syncle/core';
import { queryKeys } from '@/lib/queries';
import { AuditLog, Entry, actionKey } from './audit-log';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(
  locale: string,
  element: ReactElement,
  page?: AuditPage,
): string {
  const client = new QueryClient();
  if (page)
    client.setQueryData(
      [...queryKeys.audit, { limit: 50, action: undefined, actor: undefined }],
      page,
    );
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
  expect(html).not.toMatch(/audit\.\w/);
  return html;
}

/** a message as it appears in markup */
const inHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 'e1',
  at: '2026-09-23T10:20:30.000Z',
  actor: { type: 'user', id: 'u1', name: 'ada' },
  action: 'bridge.create',
  target: { type: 'bridge', id: 'b1234567-89ab', name: 'orders → warehouse' },
  details: null,
  ip: '10.0.0.7',
  ...over,
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = (
    messagesOf(locale) as unknown as {
      audit: Record<string, string> & {
        actions: Record<string, string>;
        actorType: Record<string, string>;
      };
    }
  ).audit;

  it('every action the API can record has a name here', () => {
    for (const action of AUDIT_ACTIONS)
      expect(m.actions[actionKey(action)], action).toEqual(expect.any(String));
    expect(Object.keys(m.actions)).toHaveLength(AUDIT_ACTIONS.length);
  });

  it('an entry: who, what, to what, from where — and the details in one line', () => {
    const html = render(
      locale,
      <Entry entry={entry({ details: { engine: 'postgres', rows: 3 } })} />,
    );
    expect(html).toContain('ada');
    expect(html).toContain(inHtml(m.actions.bridge_create!));
    expect(html).toContain('orders → warehouse');
    expect(html).toContain('b1234567'); // the id, shortened, beside the name
    expect(html).toContain('10.0.0.7');
    expect(html).toContain('engine=postgres');
    expect(html).toContain('rows=3');
    // an account is the ordinary case and is not labelled; a key and Syncle itself are
    expect(html).not.toContain(inHtml(m.actorType.user!));
    const byKey = render(
      locale,
      <Entry
        entry={entry({ actor: { type: 'apiKey', id: 'k1', name: 'ci' } })}
      />,
    );
    expect(byKey).toContain(inHtml(m.actorType.apiKey!));
    const bySystem = render(
      locale,
      <Entry
        entry={entry({
          actor: { type: 'system', id: null, name: 'system' },
          action: 'bridge.slot_surrendered',
        })}
      />,
    );
    expect(bySystem).toContain(inHtml(m.actorType.system!));
    expect(bySystem).toContain(inHtml(m.actions.bridge_slot_surrendered!));
  });

  it('an action this build does not know is shown as it is, not as a missing key', () => {
    const html = render(
      locale,
      <Entry entry={entry({ action: 'something.new' })} />,
    );
    expect(html).toContain('something.new');
  });

  it('the page lists the entries and offers the older ones; empty says so', () => {
    const html = render(locale, <AuditLog />, {
      entries: [
        entry({}),
        entry({ id: 'e2', action: 'auth.login', target: null }),
      ],
      next: '2026-09-23T10:00:00.000Z|e2',
    });
    expect(html).toContain(inHtml(m.actions.bridge_create!));
    expect(html).toContain(inHtml(m.actions.auth_login!));
    expect(html).toContain(`${inHtml(m.more!)}<`);
    const empty = render(locale, <AuditLog />, { entries: [], next: null });
    expect(empty).toContain(inHtml(m.empty!));
    expect(empty).not.toContain(`${inHtml(m.more!)}<`);
  });
});
