import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeBulkSchema, type DatabaseSchema } from '@syncle/core';
import {
  BulkResult,
  blankBulkForm,
  bulkInput,
  bulkProblem,
  tablesOf,
} from './bulk-bridges';

const schema = {
  namespaces: [
    { name: 'public', tables: [{ name: 'orders' }, { name: 'customers' }] },
    { name: 'audit', tables: [{ name: 'log' }] },
  ],
} as unknown as DatabaseSchema;

describe('the form', () => {
  it('lists every table with its schema, in the server’s order', () => {
    expect(tablesOf(schema).map((t) => t.id)).toEqual([
      'public.orders',
      'public.customers',
      'audit.log',
    ]);
    expect(tablesOf(undefined)).toEqual([]);
  });

  it('says what is still missing, in the order it is asked for', () => {
    const f = blankBulkForm();
    expect(bulkProblem(f)).toBe('source');
    f.sourceId = 'c1';
    expect(bulkProblem(f)).toBe('tables');
    f.picked = new Set(['public.orders', 'audit.log']);
    expect(bulkProblem(f)).toBe('oneSchema');
    f.picked = new Set(['public.orders', 'public.customers']);
    expect(bulkProblem(f)).toBe('destination');
    f.destinationId = 'c2';
    expect(bulkProblem(f)).toBeNull();
    f.tablePrefix = 'raw-';
    expect(bulkProblem(f)).toBe('prefix');
    f.tablePrefix = 'raw_';
    expect(bulkProblem(f)).toBeNull();
  });

  it('a new one copies first and shares a slot: what somebody bridging thirty tables wants', () => {
    expect(blankBulkForm()).toMatchObject({
      mode: 'cdc',
      startFrom: 'beginning',
      slot: 'shared',
    });
  });

  it('becomes what the API takes — and the schema it validates with agrees', () => {
    const f = {
      ...blankBulkForm(),
      sourceId: 'c1',
      destinationId: 'c2',
      tablePrefix: 'raw_',
      destinationSchema: ' staging ',
      picked: new Set(['public.orders', 'public.customers']),
    };
    const input = bulkInput(f, 'ws1', 'postgres');
    expect(input).toEqual({
      workspaceId: 'ws1',
      source: {
        connectionId: 'c1',
        schema: 'public',
        tables: ['orders', 'customers'],
      },
      destination: {
        connectionId: 'c2',
        schema: 'staging',
        tablePrefix: 'raw_',
      },
      trigger: { kind: 'cdc', startFrom: 'beginning', slot: 'shared' },
    });
    expect(bridgeBulkSchema.safeParse(input).success).toBe(true);
  });

  it('only PostgreSQL has schemas and slots to speak of; a one-time copy has neither start nor slot', () => {
    const f = {
      ...blankBulkForm(),
      sourceId: 'c1',
      destinationId: 'c2',
      picked: new Set(['shop.orders']),
    };
    const mysql = bulkInput(f, null, 'mysql');
    expect(mysql.source).toEqual({ connectionId: 'c1', tables: ['orders'] });
    expect(mysql.trigger).toEqual({
      kind: 'cdc',
      startFrom: 'beginning',
      slot: 'own',
    });
    expect(mysql).not.toHaveProperty('workspaceId');
    expect(
      bulkInput({ ...f, mode: 'replay' }, null, 'postgres').trigger,
    ).toEqual({ kind: 'replay' });
    // a table whose name has a dot in it keeps it
    expect(
      bulkInput(
        { ...f, picked: new Set(['public.v1.events']) },
        null,
        'postgres',
      ).source,
    ).toMatchObject({ schema: 'public', tables: ['v1.events'] });
  });
});

describe.each(['en', 'it', 'zh'])('the result in %s', (locale) => {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;
  const render = (result: Parameters<typeof BulkResult>[0]['result']) => {
    const problems: string[] = [];
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
        onError={(e) => problems.push(e.message)}
      >
        <BulkResult result={result} />
      </NextIntlClientProvider>,
    );
    expect(problems).toEqual([]);
    expect(html).not.toMatch(/bulkBridges\.\w/);
    return html;
  };

  it('says how many were made, that none is running, and why a table has none', () => {
    const html = render({
      created: [
        { id: 'b1', name: 'orders → raw_orders', table: 'orders' },
        { id: 'b2', name: 'customers → raw_customers', table: 'customers' },
      ],
      skipped: [{ table: 'events', reason: 'It has no primary key <script>' }],
    });
    expect(html).toContain('2');
    expect(html).toContain('events');
    expect(html).toContain('It has no primary key &lt;script&gt;');
    const none = render({
      created: [],
      skipped: [{ table: 'events', reason: 'x' }],
    });
    expect(none).not.toContain(
      (messages as unknown as { bulkBridges: Record<string, string> })
        .bulkBridges.notStarted!,
    );
  });
});
