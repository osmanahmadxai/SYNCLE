import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectionBadges } from './connection-badges';

describe.each(['en', 'it', 'zh'])('connection badges in %s', (locale) => {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;
  const render = (
    connection: Parameters<typeof ConnectionBadges>[0]['connection'],
  ) => {
    const problems: string[] = [];
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
        onError={(e) => problems.push(e.message)}
      >
        <ConnectionBadges connection={connection} />
      </NextIntlClientProvider>,
    );
    expect(problems).toEqual([]);
    expect(html).not.toMatch(/connectionBadges\.\w/);
    return html;
  };

  it('says nothing about a connection there is nothing to say about', () => {
    expect(render(null)).toBe('');
    expect(render(undefined)).toBe('');
    expect(render({})).toBe('');
    expect(render({ readOnly: false })).toBe('');
  });

  it('production is red, staging amber, development grey — and a read-only one has a lock', () => {
    expect(render({ environment: 'production' })).toContain('bg-red-600');
    expect(render({ environment: 'staging' })).toContain('bg-amber-500');
    expect(render({ environment: 'development' })).toContain('bg-slate-500');
    const both = render({ environment: 'production', readOnly: true });
    expect(both).toContain('bg-red-600');
    expect(both).toContain('lucide-lock');
    expect(render({ readOnly: true })).not.toContain('bg-');
  });
});
