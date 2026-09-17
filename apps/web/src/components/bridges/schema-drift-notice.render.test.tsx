/**
 * the notice a bridge shows when its source table has changed, and the builder
 * setting that decides what happens then — in every language. the two states
 * of the notice must not be confusable: one is a note, the other is a bridge
 * that has stopped to avoid overwriting data, and that one has no "accept".
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { BridgeSchemaDrift } from '@syncle/core';
import { queryKeys } from '@/lib/queries';
import { SchemaDriftNotice, driftLines } from './schema-drift-notice';
import { DeliverySection } from './builder/delivery-section';
import { blankDelivery } from './builder/draft';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, Record<string, never>>;

function render(
  locale: string,
  element: ReactElement,
  status?: BridgeSchemaDrift,
): string {
  const client = new QueryClient();
  if (status) client.setQueryData(queryKeys.schemaDrift('b1'), status);
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(err) => problems.push(err.message)}
    >
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/(schemaDrift|bridgeBuilder)\.\w/);
  return html;
}

const at = '2026-09-17T10:00:00.000Z';
const col = (name: string, type = 'text') => ({ name, type, nullable: true });
const notice = <SchemaDriftNotice bridgeId="b1" onEdit={() => undefined} />;

describe('driftLines', () => {
  it('one line per kind of change, and none for a kind that did not happen', () => {
    const t = (key: string, v: { columns: string }) => `${key}=${v.columns}`;
    expect(
      driftLines(
        {
          removed: [col('email')],
          added: [col('mail'), col('seats', 'integer')],
          retyped: [{ name: 'id', from: 'integer', to: 'bigint' }],
        },
        t,
      ),
    ).toEqual([
      'removed=email',
      'added=mail (text), seats (integer)',
      'retyped=id (integer → bigint)',
    ]);
    expect(
      driftLines({ removed: [], added: [col('x')], retyped: [] }, t),
    ).toEqual(['added=x (text)']);
  });
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = messagesOf(locale);

  it('says nothing while the table is what the bridge was built on — or is not known yet', () => {
    expect(render(locale, notice)).toBe('');
    expect(
      render(locale, notice, {
        baselineAt: at,
        checkedAt: at,
        drift: null,
        missingUsed: [],
      }),
    ).toBe('');
  });

  it('a harmless change: a note, the change itself, and a way to accept it', () => {
    const html = render(locale, notice, {
      baselineAt: at,
      checkedAt: at,
      drift: {
        added: [col('plan')],
        removed: [],
        retyped: [{ name: 'id', from: 'integer', to: 'bigint' }],
      },
      missingUsed: [],
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('plan (text)');
    expect(html).toContain('id (integer → bigint)');
    expect(html).toContain(`>${m.schemaDrift!.accept}<`);
    expect(html).not.toContain(`>${m.schemaDrift!.edit}<`);
  });

  it('a column the bridge uses is gone: an alert that names it, sends you to the editor — and offers NO accept', () => {
    const html = render(locale, notice, {
      baselineAt: at,
      checkedAt: at,
      drift: {
        added: [col('mail')],
        removed: [col('email'), col('phone')],
        retyped: [],
      },
      missingUsed: ['email', 'phone'],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('email, phone');
    expect(html).toContain(`>${m.schemaDrift!.edit}<`);
    expect(html).not.toContain(`>${m.schemaDrift!.accept}<`);
  });

  it('the builder explains the choice that is made — and only offers `evolve` where there is a table to alter', () => {
    for (const onSchemaChange of ['stop', 'evolve', 'continue'] as const) {
      const html = render(
        locale,
        <DeliverySection
          draft={{
            delivery: { ...blankDelivery(), onSchemaChange },
            syncMode: 'live',
            destKind: 'database',
          }}
          dispatch={() => undefined}
        />,
      );
      expect(html).toContain(
        (
          m.bridgeBuilder!.schemaChangeHint as unknown as Record<string, string>
        )[onSchemaChange]!.slice(0, 12),
      );
    }
  });
});
