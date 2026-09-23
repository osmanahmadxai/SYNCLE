/**
 * Settings › Security › Accounts, rendered to a string in every language: who is
 * listed as what, what is offered for each — and that nothing is asked for under
 * a key that is not there.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserInfo } from '@syncle/core';
import { queryKeys } from '@/lib/queries';
import { ConfirmProvider } from '@/components/confirm';
import { UsersSection } from './users-section';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

/** a message as it appears in markup */
const inHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

const user = (over: Partial<UserInfo>): UserInfo => ({
  id: 'u-root',
  username: 'root',
  role: 'admin',
  disabledAt: null,
  lastLoginAt: '2026-09-23T08:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function render(locale: string, users: UserInfo[]): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.users, users);
  client.setQueryData(queryKeys.authStatus, {
    needsSetup: false,
    authenticated: true,
    user: { id: 'u-root', username: 'root', role: 'admin' },
  });
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <UsersSection />
        </ConfirmProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/users\.\w/);
  return html;
}

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = (
    messagesOf(locale) as unknown as {
      users: Record<string, string> & { roles: Record<string, string> };
    }
  ).users;

  it('lists every account with its role, marks yours and the disabled ones, and says when each last signed in', () => {
    const html = render(locale, [
      user({}),
      user({
        id: 'u-ops',
        username: 'ops',
        role: 'operator',
        lastLoginAt: null,
      }),
      user({
        id: 'u-eye',
        username: 'eye',
        role: 'viewer',
        disabledAt: '2026-09-01T00:00:00.000Z',
      }),
    ]);
    for (const name of ['root', 'ops', 'eye']) expect(html).toContain(name);
    expect(html).toContain(inHtml(m.you!));
    expect(html).toContain(inHtml(m.disabled!));
    expect(html).toContain(inHtml(m.neverSignedIn!));
    // the delete is offered for the others, never for yourself
    expect(html.split(`>${inHtml(m.delete!)}<`).length - 1).toBe(2);
    // roles are chosen from a select, one per account plus the form's
    expect(html.split(`aria-label="${inHtml(m.role!)}"`).length - 1).toBe(1);
  });

  it('the form to add one explains the role that is chosen', () => {
    const html = render(locale, [user({})]);
    expect(html).toContain(inHtml(m.add!));
    expect(html).toContain(inHtml(m.create!));
    expect(html).toContain(
      (m.roleHint as unknown as Record<string, string>).operator!,
    );
  });
});
