/**
 * the card a bridge's row shows on hover: both ends — table, connection,
 * engine, where it runs, which database — and what crosses between them, in
 * every language, with no message key left showing.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bridge, ConnectionConfig } from '@syncle/core';
import { summarizeBridge } from '@/lib/bridge-summary';
import { BridgeDetails } from './bridge-details';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

const connections = [
  {
    id: 'pg',
    name: 'shop-prod',
    engine: 'postgres',
    host: 'pg.internal',
    port: 5432,
    database: 'shop',
    environment: 'production',
  },
  {
    id: 'mongo',
    name: 'analytics',
    engine: 'mongodb',
    host: 'mongo.internal',
    port: 27017,
    ssh: { host: 'bastion.example.com', username: 'ops' },
  },
] as ConnectionConfig[];

const fanOut = {
  id: 'b1',
  name: 'orders',
  enabled: true,
  trigger: {
    kind: 'watch',
    strategy: { strategy: 'timestamp', column: 'updated_at' },
    pollIntervalMs: 5000,
  },
  transform: {
    template: '{{$row}}',
    columns: [{ kind: 'mask', column: 'email' }],
  },
  source: {
    kind: 'table',
    connectionId: 'pg',
    schema: 'public',
    table: 'orders',
  },
  destination: {
    kind: 'database',
    targets: [
      {
        connectionId: 'mongo',
        table: 'orders',
        mapping: [],
        keyColumns: ['id'],
        writeMode: 'upsert',
        onDelete: 'delete',
      },
      {
        connectionId: 'mongo',
        table: 'order_archive',
        mapping: [
          { source: 'id', target: 'id' },
          { source: 'total_cents', target: 'total' },
        ],
        keyColumns: [],
        writeMode: 'insert',
        onDelete: 'ignore',
      },
    ],
  },
} as unknown as Bridge;

function render(locale: string, bridge: Bridge): string {
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <BridgeDetails
        bridge={bridge}
        summary={summarizeBridge(bridge, connections)}
      />
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/bridgeSummary\.\w/);
  return html;
}

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  it('names both ends: table, connection, engine, host and database', () => {
    const html = render(locale, fanOut);
    expect(html).toContain('public.orders');
    expect(html).toContain('shop-prod');
    expect(html).toContain('pg.internal:5432');
    expect(html).toContain('/ shop');
    expect(html).toContain('title="PostgreSQL"');
    expect(html).toContain('bg-red-600'); // production looks like production
    expect(html).toContain('order_archive');
    expect(html).toContain('mongo.internal:27017');
    expect(html).toContain('bastion.example.com');
  });

  it('says how each target is written and which columns cross', () => {
    const html = render(locale, fanOut);
    expect(html).toContain('id'); // the upsert key
    expect(html).toContain('total_cents→total');
    expect(html).toContain('updated_at');
  });

  it('describes an HTTP destination by method, host and path', () => {
    const html = render(locale, {
      ...fanOut,
      trigger: {
        kind: 'replay',
        schedule: { cron: '0 2 * * *', timezone: 'Europe/Rome', enabled: true },
      },
      destination: {
        kind: 'http',
        method: 'POST',
        url: 'https://hooks.example.com/v1/orders',
      },
    } as unknown as Bridge);
    expect(html).toContain('POST');
    expect(html).toContain('hooks.example.com');
    expect(html).toContain('/v1/orders');
    expect(html).toContain('0 2 * * *');
  });
});
