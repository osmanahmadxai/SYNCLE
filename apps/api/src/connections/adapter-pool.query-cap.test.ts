/**
 * The instance-wide "max query rows" setting, which was stored, shown in
 * Settings, reported by the API — and read by nothing. Every adapter capped at
 * its built-in 5000 whatever the dialog said.
 *
 * Driven through a real (file-backed) SQLite adapter, so what is asserted is
 * what a query actually returns.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapDrivers } from '@syncle/core/adapters';
import type { ConnectionConfig } from '@syncle/core';
import { AdapterPoolService } from './adapter-pool.service';

const file = join(mkdtempSync(join(tmpdir(), 'syncle-cap-')), 'cap.db');
let settings = { maxQueryRows: 5000, poolIdleMs: 300_000 };
let connection: ConnectionConfig;
let pool: AdapterPoolService;

const make = (): AdapterPoolService =>
  new AdapterPoolService(
    {
      resolve: async () => connection,
      pinSshHostKey: async () => undefined,
    } as never,
    { snapshot: () => settings } as never,
    {
      openFor: async () => undefined,
      reroute: (c: ConnectionConfig) => c,
    } as never,
  );

const rowsReturned = async (): Promise<{
  rows: number;
  truncated: boolean;
}> => {
  const res = await pool.withAdapter('c', undefined, (a) =>
    a.query('SELECT n FROM numbers'),
  );
  return { rows: res.rows.length, truncated: res.truncated === true };
};

beforeAll(async () => {
  bootstrapDrivers();
  connection = {
    id: 'c',
    name: 'cap',
    engine: 'sqlite',
    database: file,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ConnectionConfig;
  pool = make();
  await pool.withAdapter('c', undefined, async (a) => {
    await a.query('CREATE TABLE numbers (n INTEGER PRIMARY KEY)');
    await a.query(
      'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 300) INSERT INTO numbers SELECT n FROM seq',
    );
  });
});

afterEach(async () => {
  await pool.onModuleDestroy();
  settings = { maxQueryRows: 5000, poolIdleMs: 300_000 };
  connection = { ...connection, options: undefined };
  pool = make();
});

describe('the "max query rows" setting', () => {
  it('caps a query on a connection that sets no limit of its own', async () => {
    settings.maxQueryRows = 100;
    expect(await rowsReturned()).toEqual({ rows: 100, truncated: true });
  });

  it('reaches a connection that is already open, without waiting for it to idle out', async () => {
    settings.maxQueryRows = 100;
    expect((await rowsReturned()).rows).toBe(100);
    settings = { ...settings, maxQueryRows: 250 };
    expect(await rowsReturned()).toEqual({ rows: 250, truncated: true });
    settings = { ...settings, maxQueryRows: 1000 };
    expect(await rowsReturned()).toEqual({ rows: 300, truncated: false });
  });

  it('gives way to the connection’s own limit, in either direction', async () => {
    settings.maxQueryRows = 100;
    connection = { ...connection, options: { maxQueryRows: 40 } };
    expect((await rowsReturned()).rows).toBe(40);
    connection = {
      ...connection,
      options: { maxQueryRows: 280 },
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    expect((await rowsReturned()).rows).toBe(280);
  });

  it('ignores a nonsensical limit on the connection rather than returning nothing', async () => {
    settings.maxQueryRows = 120;
    connection = { ...connection, options: { maxQueryRows: 0 } };
    expect((await rowsReturned()).rows).toBe(120);
    connection = {
      ...connection,
      options: { maxQueryRows: 'lots' },
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    expect((await rowsReturned()).rows).toBe(120);
  });

  it('does not reopen the connection when nothing changed', async () => {
    settings.maxQueryRows = 100;
    const first = await pool.withAdapter('c', undefined, async (a) => a);
    const second = await pool.withAdapter('c', undefined, async (a) => a);
    expect(second).toBe(first);
  });
});
