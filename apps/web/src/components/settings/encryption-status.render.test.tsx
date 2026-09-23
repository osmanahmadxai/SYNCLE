import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { EncryptionReport, EncryptionStatus } from './encryption-status';

describe.each(['en', 'it', 'zh'])('a change of master key, in %s', (locale) => {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;
  const render = (element: ReactElement, seed?: (c: QueryClient) => void) => {
    const client = new QueryClient();
    seed?.(client);
    const problems: string[] = [];
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
        onError={(e) => problems.push(e.message)}
      >
        <QueryClientProvider client={client}>{element}</QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(problems).toEqual([]);
    expect(html).not.toMatch(/settingsDialog\.encryption\.\w/);
    return html;
  };
  const report = (over: Record<string, number>) => ({
    previousKeys: 1,
    reencrypted: 0,
    unreadable: 0,
    checkedAt: '2026-09-18T00:00:00.000Z',
    ...over,
  });

  it('nothing is shown on an instance nobody is changing the key of — or before the answer is there', () => {
    expect(render(<EncryptionStatus />)).toBe('');
    expect(
      render(<EncryptionStatus />, (c) =>
        c.setQueryData(['encryptionStatus'], report({ previousKeys: 0 })),
      ),
    ).toBe('');
  });

  it('done: says the previous key can go, by the name of the variable to remove', () => {
    const html = render(
      <EncryptionReport
        report={report({ reencrypted: 7 })}
        busy={false}
        onCheck={() => undefined}
      />,
    );
    expect(html).toContain('SYNCLE_MASTER_KEY_PREVIOUS');
    expect(html).toContain('emerald');
    expect(html).toContain('7');
    expect(html).not.toContain('amber');
  });

  it('a secret that fits no key: said as the problem it is, and the key is NOT said to be removable', () => {
    const html = render(
      <EncryptionReport
        report={report({ unreadable: 2 })}
        busy={false}
        onCheck={() => undefined}
      />,
    );
    expect(html).toContain('amber');
    expect(html).toContain('2');
    expect(html).not.toContain('emerald');
  });
});
