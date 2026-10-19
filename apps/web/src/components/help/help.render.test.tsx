/**
 * every suggestion and every section of the guide, in every language: each
 * renders, fills in its values, and leaves no message key on the screen.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { Hint, HintRule } from '@/lib/hints/diagnose';
import type { ErrorCause } from '@/lib/hints/error-causes';
import { GUIDE_SECTIONS } from '@/lib/hints/guide';
import { SuggestionCard } from './suggestion-card';
import { GuideView } from './guide-view';
import { parseBlocks } from './rich-text';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(locale: string, node: ReactNode): string {
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      {node}
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(
    /help\.(rules|causes|guide)\.|\{(bridge|count|table|keys|size|columns)\}/,
  );
  return html;
}

const RULES: HintRule[] = [
  'missing-connection',
  'failed',
  'dead-letters',
  'insert-on-live',
  'schema-drift',
  'source-hold',
  'cdc-from-now',
  'redis-cdc',
  'abort-on-live',
  'http-no-idempotency',
  'history-pruned',
  'no-connections',
  'no-bridges',
];

const CAUSES = Object.keys(
  (messagesOf('en') as unknown as { help: { causes: object } }).help.causes,
) as ErrorCause[];

const hint = (over: Partial<Hint>): Hint => ({
  id: 'x',
  rule: 'failed',
  severity: 'critical',
  bridgeId: 'b1',
  values: {
    bridge: 'Customers → Replica',
    count: 3,
    table: 'customers',
    keys: 'id',
    size: '3.0 GB',
    columns: 'plan',
    running: 'no',
    breaking: 'yes',
  },
  actions: [
    { kind: 'edit-bridge', bridgeId: 'b1' },
    { kind: 'open-bridge', bridgeId: 'b1' },
  ],
  guide: 'write-modes',
  fingerprint: '',
  ...over,
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  it.each(RULES)('the "%s" suggestion reads in full', (rule) => {
    const html = render(locale, <SuggestionCard hint={hint({ rule })} isNew />);
    if (!['no-connections', 'no-bridges'].includes(rule))
      expect(html).toContain('Customers → Replica');
    expect(html).toContain('<ol');
  });

  it('a failure names its likely cause and that cause’s steps, for every cause', () => {
    expect(CAUSES.length).toBeGreaterThan(15);
    for (const cause of CAUSES) {
      const html = render(
        locale,
        <SuggestionCard
          hint={hint({
            rule: 'dead-letters',
            cause,
            detail: 'E11000 duplicate key',
          })}
          isNew={false}
        />,
      );
      expect(html).toContain('E11000 duplicate key');
    }
  });

  it('the insert-on-live steps name the table and the key', () => {
    const html = render(
      locale,
      <SuggestionCard hint={hint({ rule: 'insert-on-live' })} isNew={false} />,
    );
    expect(html).toContain('customers');
    expect(html).toMatch(/\(id\)|（id）/);
  });

  it.each(GUIDE_SECTIONS)(
    'the guide’s "%s" section opens and reads',
    (section) => {
      const html = render(locale, <GuideView focus={section} />);
      expect(html).toContain('aria-expanded="true"');
      // the section's text, laid out (a paragraph, a list or steps)
      expect(html).toMatch(/<(p|ul|ol)[ >]/);
    },
  );
});

describe('the guide’s text conventions', () => {
  it('turns paragraphs, bullets, nested bullets and numbered steps into blocks', () => {
    expect(
      parseBlocks(
        'Intro line\ncontinues.\n\n- one\n  - one.a\n- two\n\n1. first\n2. second',
      ),
    ).toEqual([
      { kind: 'p', text: 'Intro line continues.' },
      {
        kind: 'ul',
        items: [
          { text: 'one', nested: ['one.a'] },
          { text: 'two', nested: [] },
        ],
      },
      { kind: 'ol', items: ['first', 'second'] },
    ]);
  });

  it('shows HTTP tokens literally, braces and all', () => {
    const html = render('en', <GuideView focus="http" />);
    expect(html).toContain('{{column}}');
    expect(html).toContain('{{$row}}');
  });
});
