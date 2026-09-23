/**
 * a viewer is told, once, that they may look and not change; nobody else sees it
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/queries';
import { ReadOnlyNotice } from './read-only-notice';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(locale: string, role: string | null): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.authStatus, {
    needsSetup: false,
    authenticated: role !== null,
    user: role ? { id: 'u1', username: 'sam', role } : null,
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
        <ReadOnlyNotice />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  return html;
}

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = (
    messagesOf(locale) as unknown as { userMenu: Record<string, string> }
  ).userMenu;
  it('is shown to a viewer, and to nobody else', () => {
    expect(render(locale, 'viewer')).toContain(m.viewerNotice!);
    expect(render(locale, 'operator')).toBe('');
    expect(render(locale, 'admin')).toBe('');
    expect(render(locale, null)).toBe('');
  });
});
