/**
 * narrowing the bridge list down: a search over what each row says (and every
 * target of a fan-out, which the row shortens), and a filter by what the bridge
 * is doing right now — with a count per state that agrees with the search.
 */
import { describe, expect, it } from 'vitest';
import type { Bridge, ConnectionConfig } from '@syncle/core';
import { filterBridges, type BridgeStatus } from './bridge-list';

const bridge = (over: Partial<Bridge> & Pick<Bridge, 'id' | 'name'>): Bridge =>
  ({
    enabled: true,
    trigger: { kind: 'cdc' },
    transform: { template: '{{$row}}' },
    source: { kind: 'table', connectionId: 'c1', schema: 'public', table: 'orders' },
    destination: {
      kind: 'database',
      targets: [{ connectionId: 'c2', table: 'orders' }],
    },
    ...over,
  }) as Bridge;

const orders = bridge({ id: 'orders', name: 'Orders to Mongo' });
const users = bridge({
  id: 'users',
  name: 'Users fan-out',
  source: { kind: 'table', connectionId: 'c1', table: 'users' },
  destination: {
    kind: 'database',
    targets: [
      { connectionId: 'c2', table: 'users' },
      { connectionId: 'c3', schema: 'crm', table: 'contacts' },
    ],
  } as Bridge['destination'],
});
const hook = bridge({
  id: 'hook',
  name: 'Invoices webhook',
  trigger: { kind: 'replay' } as Bridge['trigger'],
  source: { kind: 'table', connectionId: 'c1', table: 'invoices' },
  destination: {
    kind: 'http',
    method: 'POST',
    url: 'https://billing.example.com/ingest',
  } as Bridge['destination'],
});
const parked = bridge({ id: 'parked', name: 'Old archive', enabled: false });

const all = [orders, users, hook, parked];
const statuses = new Map<string, BridgeStatus>([
  ['orders', { active: true, lastStatus: 'running' }],
  ['users', { active: false, lastStatus: 'failed' }],
  ['hook', { active: false, lastStatus: 'completed' }],
]);
const ids = (bridges: Bridge[]) => bridges.map((b) => b.id);

const connections = [
  { id: 'c1', name: 'shop-prod', engine: 'postgres', host: 'pg.internal', port: 5432, database: 'shop' },
  { id: 'c2', name: 'mongo-analytics', engine: 'mongodb', host: 'mongo.internal', port: 27017 },
  { id: 'c3', name: 'crm', engine: 'mysql', host: 'crm.example.net', port: 3306 },
] as ConnectionConfig[];

describe('the bridge list, narrowed', () => {
  it('shows everything, counted by state, when nothing is asked', () => {
    const { visible, counts } = filterBridges(all, statuses, '', 'all');
    expect(ids(visible)).toEqual(['orders', 'users', 'hook', 'parked']);
    expect(counts).toEqual({ all: 4, live: 1, failed: 1, idle: 1, off: 1 });
  });

  it('keeps only the bridges in the state picked', () => {
    expect(ids(filterBridges(all, statuses, '', 'failed').visible)).toEqual(['users']);
    expect(ids(filterBridges(all, statuses, '', 'off').visible)).toEqual(['parked']);
    // a bridge with no status yet is idle, not live
    expect(ids(filterBridges(all, new Map(), '', 'idle').visible)).toEqual([
      'orders',
      'users',
      'hook',
    ]);
  });

  it('matches the name, the source and the destination, ignoring case', () => {
    expect(ids(filterBridges(all, statuses, 'MONGO', 'all').visible)).toEqual(['orders']);
    expect(ids(filterBridges(all, statuses, 'public.orders', 'all').visible)).toEqual([
      'orders',
      'parked',
    ]);
    expect(ids(filterBridges(all, statuses, 'billing.example', 'all').visible)).toEqual([
      'hook',
    ]);
  });

  it('finds a fan-out by a target the row only shows as "+1"', () => {
    expect(ids(filterBridges(all, statuses, 'crm.contacts', 'all').visible)).toEqual([
      'users',
    ]);
  });

  it('needs every word, in any order', () => {
    expect(ids(filterBridges(all, statuses, 'webhook invoices', 'all').visible)).toEqual([
      'hook',
    ]);
    expect(filterBridges(all, statuses, 'webhook orders', 'all').visible).toEqual([]);
  });

  it('counts the states over what the search leaves, so a chip says what it will show', () => {
    const { visible, counts } = filterBridges(all, statuses, 'orders', 'live');
    expect(ids(visible)).toEqual(['orders']);
    expect(counts).toEqual({ all: 2, live: 1, failed: 0, idle: 0, off: 1 });
  });

  it('finds a bridge by the connection, host or database at either end', () => {
    const find = (q: string) => ids(filterBridges(all, statuses, q, 'all', connections).visible);
    expect(find('mongo-analytics')).toEqual(['orders', 'users', 'parked']);
    expect(find('crm.example.net')).toEqual(['users']);
    expect(find('pg.internal')).toEqual(['orders', 'users', 'hook', 'parked']);
    expect(find('shop invoices')).toEqual(['hook']);
    // without the connections, only what the bridge itself says is searched
    expect(ids(filterBridges(all, statuses, 'crm.example.net', 'all').visible)).toEqual([]);
  });
});
