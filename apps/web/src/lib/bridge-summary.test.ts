/**
 * what the list and the map say about a bridge's two ends and what crosses
 * between them — worked out from the bridge and the workspace's connections,
 * with nothing fetched.
 */
import { describe, expect, it } from 'vitest';
import type { Bridge, ConnectionConfig } from '@syncle/core';
import { columnList, httpColumns, summarizeBridge } from './bridge-summary';

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
    connectionString: '[redacted]',
  },
  {
    id: 'lite',
    name: 'local copy',
    engine: 'sqlite',
    database: '/data/copy.db',
  },
  {
    id: 'tunnel',
    name: 'behind bastion',
    engine: 'mysql',
    host: '10.0.0.5',
    ssh: { host: 'bastion.example.com', username: 'ops' },
  },
] as ConnectionConfig[];

const bridge = (over: Partial<Bridge>): Bridge =>
  ({
    id: 'b1',
    name: 'orders',
    enabled: true,
    trigger: {
      kind: 'cdc',
      operations: ['insert', 'update', 'delete'],
      startFrom: 'now',
    },
    transform: { template: '{{$row}}' },
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
      ],
    },
    ...over,
  }) as Bridge;

describe('a bridge, summarized', () => {
  it('says which connection each end is on, its engine, where it runs and the database', () => {
    const s = summarizeBridge(bridge({}), connections);
    expect(s.source).toMatchObject({
      connectionName: 'shop-prod',
      engine: 'postgres',
      address: 'pg.internal:5432',
      database: 'shop',
      table: 'public.orders',
      via: null,
    });
    // a connection string is never sent back, so where it runs cannot be said
    expect(s.targets[0]).toMatchObject({
      connectionName: 'analytics',
      engine: 'mongodb',
      address: null,
      table: 'orders',
      keyColumns: ['id'],
      columns: null,
    });
  });

  it('names the SQLite file as the address, and the SSH host a database is reached through', () => {
    const s = summarizeBridge(
      bridge({
        source: {
          kind: 'table',
          connectionId: 'tunnel',
          database: 'crm',
          table: 'contacts',
        },
        destination: {
          kind: 'database',
          targets: [{ connectionId: 'lite', table: 'contacts' }],
        } as Bridge['destination'],
      }),
      connections,
    );
    expect(s.source).toMatchObject({
      address: '10.0.0.5',
      via: 'bastion.example.com',
      database: 'crm',
    });
    expect(s.targets[0]).toMatchObject({
      address: '/data/copy.db',
      database: null,
    });
    // a target stored before the defaults existed reads as the defaults
    expect(s.targets[0]).toMatchObject({
      writeMode: 'upsert',
      keyColumns: [],
      onDelete: 'delete',
      columns: null,
    });
  });

  it('lists the columns a target is mapped to, renames and all', () => {
    const s = summarizeBridge(
      bridge({
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: 'mongo',
              table: 'orders',
              mapping: [
                { source: 'id', target: 'id' },
                { source: 'total_cents', target: 'total' },
              ],
            },
          ],
        } as Bridge['destination'],
      }),
      connections,
    );
    expect(s.targets[0]!.columns).toEqual([
      { source: 'id', target: 'id' },
      { source: 'total_cents', target: 'total' },
    ]);
  });

  it('marks a connection that is gone, and a custom query', () => {
    const s = summarizeBridge(
      bridge({
        source: {
          kind: 'query',
          connectionId: 'deleted',
          statement: 'select 1',
        },
      }),
      connections,
    );
    expect(s.source).toMatchObject({
      connection: null,
      connectionName: null,
      engine: null,
      table: null,
    });
  });

  it('splits an HTTP destination into method, host and path, with the payload fields it names', () => {
    const b = bridge({
      destination: {
        kind: 'http',
        method: 'PUT',
        url: 'https://hooks.example.com:8443/v1/orders?src=syncle',
      } as Bridge['destination'],
      transform: {
        template: '{{$row}}',
        fields: ['id', 'email'],
        rename: { email: 'mail' },
      },
      source: {
        kind: 'table',
        connectionId: 'pg',
        table: 'orders',
        filters: [{ column: 'status', operator: 'eq', value: 'paid' }],
      } as Bridge['source'],
    });
    const s = summarizeBridge(b, connections);
    expect(s.targets).toEqual([]);
    expect(s.http).toEqual({
      method: 'PUT',
      host: 'hooks.example.com:8443',
      path: '/v1/orders?src=syncle',
    });
    expect(s.filterCount).toBe(1);
    expect(httpColumns(b)).toEqual([
      { source: 'id', target: 'id' },
      { source: 'email', target: 'mail' },
    ]);
    expect(httpColumns(bridge({}))).toBeNull();
  });
});

describe('a column list on one line', () => {
  it('shows the first few, marks a rename, and counts the rest', () => {
    const cols = ['id', 'email', 'name', 'city', 'zip'].map((c) => ({
      source: c,
      target: c,
    }));
    expect(columnList(cols)).toBe('id, email, name, city +1');
    expect(columnList([{ source: 'total_cents', target: 'total' }])).toBe(
      'total_cents→total',
    );
  });
});
