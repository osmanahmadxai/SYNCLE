/**
 * The filter and transform editors, rendered to a string in every language.
 *
 * What this catches is what the pure tests cannot: a label asked for under a key
 * that does not exist (next-intl reports it at render time, in the browser, to
 * nobody), and a component that throws on a draft it should be able to show.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { ColumnTransform } from '@syncle/core';
import { FILTER_OPERATORS, initialDraft, type DraftFilter } from './draft';
import { FiltersSection } from './filters-section';
import { PayloadSection } from './payload-section';
import {
  CAST_ERRORS,
  CAST_TARGETS,
  MASK_MODES,
  TEXT_OPS,
} from './transform-options';
import { TransformsSection } from './transforms-section';
import { TriggerSection } from './trigger-section';

const LOCALES = ['en', 'it', 'zh'] as const;
const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

/** render, failing on anything next-intl would only have logged */
function render(locale: string, element: ReactElement): string {
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(err) => problems.push(err.message)}
    >
      {element}
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  // a key that is missing renders as its own path
  expect(html).not.toMatch(/builder(Filters|Transforms)\.\w/);
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

const COLUMNS = ['id', 'email', 'name'];
const noop = () => undefined;

/** one step of every kind, in every mode each kind has */
const everyStep: ColumnTransform[] = [
  ...MASK_MODES.map(
    (mode): ColumnTransform => ({
      kind: 'mask',
      column: 'email',
      mode,
      keepStart: 1,
      keepEnd: 2,
      fill: '*',
      salt: mode === 'hash' ? 'pepper' : undefined,
    }),
  ),
  ...CAST_TARGETS.flatMap((to) =>
    CAST_ERRORS.map(
      (onError): ColumnTransform => ({
        kind: 'cast',
        column: 'id',
        to,
        onError,
      }),
    ),
  ),
  ...TEXT_OPS.map(
    (op): ColumnTransform => ({ kind: 'text', column: 'name', op }),
  ),
  { kind: 'default', column: 'tier', value: 'free' },
  { kind: 'default', column: 'score', value: null },
  { kind: 'set', column: 'label', template: '{{name}} <{{email}}>' },
  // half-written: shown with its hint, not hidden and not a crash
  { kind: 'set', column: '', template: '' },
  // a column the table no longer has
  {
    kind: 'mask',
    column: 'dropped_column',
    mode: 'redact',
    keepStart: 0,
    keepEnd: 4,
    fill: '*',
  },
];

describe.each(LOCALES)('the builder sections in %s', (locale) => {
  const messages = messagesOf(locale) as unknown as Record<
    string,
    Record<string, string>
  >;

  it('the replication slot choice is offered for a PostgreSQL source, and for no other', () => {
    const m = messagesOf(locale) as unknown as {
      bridgeBuilder: Record<string, string>;
    };
    const draft = {
      ...initialDraft(),
      syncMode: 'live' as const,
      triggerKind: 'cdc' as const,
      connectionId: 'c1',
      table: 'users',
    };
    const section = (sourceEngine: string, cdcSlot: 'own' | 'shared') => (
      <TriggerSection
        draft={{ ...draft, cdcSlot }}
        dispatch={() => undefined}
        columns={[]}
        sourceEngine={sourceEngine}
      />
    );
    const own = render(locale, section('postgres', 'own'));
    expect(own).toContain(inHtml(m.bridgeBuilder.cdcSlot!));
    expect(own).toContain(inHtml(m.bridgeBuilder.cdcSlotOwnHint!));
    expect(render(locale, section('postgres', 'shared'))).toContain(
      inHtml(m.bridgeBuilder.cdcSlotSharedHint!),
    );
    for (const engine of ['mysql', 'mongodb', 'redis']) {
      expect(render(locale, section(engine, 'shared'))).not.toContain(
        inHtml(m.bridgeBuilder.cdcSlot!),
      );
    }
  });

  it('filters: empty, then one row per operator, then what the editor cannot show', () => {
    const empty = render(
      locale,
      <FiltersSection
        draft={{ filters: [], extraFilters: [] }}
        dispatch={noop}
        columns={COLUMNS}
      />,
    );
    expect(empty).toContain(inHtml(messages.builderFilters!.title!));

    const filters: DraftFilter[] = FILTER_OPERATORS.map((operator, i) => ({
      id: `f${i}`,
      column: i === 0 ? 'dropped_column' : 'email',
      operator,
      value: 'x',
    }));
    const full = render(
      locale,
      <FiltersSection
        draft={{
          filters: [
            ...filters,
            { id: 'half', column: 'id', operator: 'gt', value: '' },
          ],
          extraFilters: [{ column: 'country', operator: 'in', value: ['IT'] }],
        }}
        dispatch={noop}
        columns={COLUMNS}
      />,
    );
    // the two that compare against nothing have no value box
    expect(full.match(/<input/g)?.length).toBe(FILTER_OPERATORS.length - 2 + 1);
    expect(full).toContain('text-destructive');
  });

  it('transforms: every kind and mode renders, the half-written one with its hint', () => {
    const empty = render(
      locale,
      <TransformsSection
        draft={{ transforms: [] }}
        dispatch={noop}
        columns={COLUMNS}
      />,
    );
    expect(empty).toContain(inHtml(messages.builderTransforms!.none!));

    const html = render(
      locale,
      <TransformsSection
        draft={{ transforms: everyStep.map((t, i) => ({ ...t, id: `t${i}` })) }}
        dispatch={noop}
        columns={COLUMNS}
      />,
    );
    expect(html).toContain(inHtml(messages.builderTransforms!.needsColumn!));
    expect(html).toContain(inHtml(messages.builderTransforms!.orderHint!));
    // the tokens are passed through the message as values, braces intact
    expect(html).toContain('{{column}}');
    expect(html).toContain('{{$now}}');
  });

  it('the payload preview shows what the steps do to the sample row', () => {
    const draft = { ...initialDraft(), table: 'users' };
    const transforms: ColumnTransform[] = [
      { kind: 'text', column: 'email', op: 'upper' },
      {
        kind: 'mask',
        column: 'email',
        mode: 'partial',
        keepStart: 1,
        keepEnd: 4,
        fill: '*',
      },
      {
        kind: 'mask',
        column: 'name',
        mode: 'hash',
        keepStart: 0,
        keepEnd: 4,
        fill: '*',
      },
      { kind: 'cast', column: 'id', to: 'string', onError: 'fail' },
      { kind: 'set', column: 'label', template: 'user {{id}}' },
    ];
    const html = render(
      locale,
      <PayloadSection
        draft={draft}
        dispatch={noop}
        sampleRow={{ id: 7, email: 'ada@example.com', name: 'Ada' }}
        includedList={['id', 'email', 'name', 'label']}
        transforms={transforms}
      />,
    );
    expect(html).toContain(
      'A*********.COM'.replace('*********', '*'.repeat(10)),
    );
    expect(html).not.toContain('ada@example.com');
    expect(html).not.toContain('Ada&quot;');
    // the id is text now, in the schema and in the body
    expect(html).toContain('&quot;id&quot;: &quot;string&quot;');
    expect(html).toContain('&quot;label&quot;: &quot;user 7&quot;');
    // a browser cannot hash in a render: a stand-in, and a line that says so
    expect(html).toContain('sha256:');
    expect(html).toContain(inHtml(messages.bridgeBuilder!.hashStandIn!));
  });

  it('a cast set to fail, on a value that cannot be cast, shows as the error it would be', () => {
    const html = render(
      locale,
      <PayloadSection
        draft={{ ...initialDraft(), table: 'users' }}
        dispatch={noop}
        sampleRow={{ id: 'n/a' }}
        includedList={['id']}
        transforms={[
          { kind: 'cast', column: 'id', to: 'integer', onError: 'fail' },
        ]}
      />,
    );
    expect(html).toContain('cast id');
    expect(html).toContain('is not a integer');
    expect(html).toContain('text-destructive');
  });
});
