import { describe, expect, it } from 'vitest';
import type { Bridge } from '@syncle/core';
import { initialDraft } from './draft';
import { buildInput, loadBridge, type BuildInputContext } from './mapping';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function httpBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    id: 'b1',
    name: 'Users to CRM',
    workspaceId: 'ws1',
    source: {
      kind: 'table',
      connectionId: 'c1',
      database: 'app',
      schema: 'public',
      table: 'users',
    },
    destination: {
      kind: 'http',
      url: 'https://api.example.com/webhook',
      method: 'POST',
      headers: { 'X-Env': 'prod' },
      auth: { type: 'bearer', token: 'secret' },
      idempotency: true,
    },
    transform: { template: '{{$row}}', fields: ['id', 'email'], wrapKey: 'user' },
    delivery: {
      batchSize: 10,
      maxAttempts: 5,
      backoffMs: 500,
      backoffMaxMs: 30000,
      minDelayMs: 250,
      timeoutMs: 20000,
      pageSize: 200,
      onError: 'abort',
    },
    trigger: { kind: 'replay' },
    enabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ctx(overrides: Partial<BuildInputContext> = {}): BuildInputContext {
  return {
    columns: ['id', 'email', 'name'],
    singlePk: 'id',
    fallbackName: 'Send users',
    ...overrides,
  };
}

/** a draft as the builder would hold it right before saving an HTTP bridge */
function readyDraft() {
  const d = initialDraft();
  d.name = 'Users to CRM';
  d.connectionId = 'c1';
  d.database = 'app';
  d.schema = 'public';
  d.table = 'users';
  d.included = new Set(['id', 'email', 'name']);
  d.dest = { ...d.dest, url: 'https://api.example.com/webhook' };
  return d;
}

/* -------------------------------------------------------------------------- */
/* loadBridge: bridge → draft (edit-mode hydration)                           */
/* -------------------------------------------------------------------------- */

describe('loadBridge', () => {
  it('hydrates source, transform, delivery and enabled from an http bridge', () => {
    const d = loadBridge(httpBridge());
    expect(d.name).toBe('Users to CRM');
    expect(d.connectionId).toBe('c1');
    expect(d.database).toBe('app');
    expect(d.schema).toBe('public');
    expect(d.table).toBe('users');
    expect(d.mode).toBe('all');
    expect(d.selectedKeys.size).toBe(0);
    // pinned fields are deferred until the table's columns load
    expect(d.fieldsPref).toEqual(['id', 'email']);
    expect(d.included.size).toBe(0);
    expect(d.wrapKey).toBe('user');
    expect(d.destKind).toBe('http');
    expect(d.dest).toEqual({
      url: 'https://api.example.com/webhook',
      method: 'POST',
      authType: 'bearer',
      authToken: 'secret',
      authHeaderName: '',
      authHeaderValue: '',
      headers: [{ key: 'X-Env', value: 'prod' }],
      idempotency: true,
    });
    expect(d.delivery).toEqual({
      batchSize: 10,
      maxAttempts: 5,
      minDelayMs: 250,
      timeoutMs: 20000,
      onError: 'abort',
    });
    expect(d.enabled).toBe(false);
    // a replay trigger is a one-time job
    expect(d.syncMode).toBe('oneTime');
    expect(d.triggerKind).toBe('replay');
    expect(d.offset).toBe(0);
    expect(d.readiness).toBeNull();
  });

  it('maps an in-filter to selected-rows mode, keyed by String(value)', () => {
    const d = loadBridge(
      httpBridge({
        source: {
          kind: 'table',
          connectionId: 'c1',
          table: 'users',
          filters: [{ column: 'id', operator: 'in', value: [1, 2, 30] }],
        },
      }),
    );
    expect(d.mode).toBe('selected');
    expect([...d.selectedKeys.entries()]).toEqual([
      ['1', 1],
      ['2', 2],
      ['30', 30],
    ]);
    // absent optional source fields normalize to ''
    expect(d.database).toBe('');
    expect(d.schema).toBe('');
  });

  it('hydrates a watch trigger as a live bridge with its strategy fields', () => {
    const d = loadBridge(
      httpBridge({
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'timestamp', column: 'updated_at', lookbackMs: 3000 },
          pollIntervalMs: 7500,
          startFrom: 'beginning',
          maxPerPoll: 500,
        },
      }),
    );
    expect(d.syncMode).toBe('live');
    expect(d.triggerKind).toBe('watch');
    expect(d.watchStrategy).toBe('timestamp');
    expect(d.watchColumn).toBe('updated_at');
    expect(d.pollSeconds).toBe(8); // rounded from 7500ms
    expect(d.watchStartFrom).toBe('beginning');
  });

  it('leaves the watch column blank for a snapshot strategy', () => {
    const d = loadBridge(
      httpBridge({
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'snapshot', maxTracked: 50000 },
          pollIntervalMs: 5000,
          startFrom: 'now',
          maxPerPoll: 500,
        },
      }),
    );
    expect(d.watchStrategy).toBe('snapshot');
    expect(d.watchColumn).toBe('');
  });

  it('hydrates a cdc trigger with its operations', () => {
    const d = loadBridge(
      httpBridge({ trigger: { kind: 'cdc', operations: ['insert', 'delete'] } }),
    );
    expect(d.syncMode).toBe('live');
    expect(d.triggerKind).toBe('cdc');
    expect([...d.cdcOps]).toEqual(['insert', 'delete']);
  });

  it('hydrates header auth into the separate name/value fields', () => {
    const d = loadBridge(
      httpBridge({
        destination: {
          kind: 'http',
          url: 'https://x.test/h',
          method: 'PUT',
          auth: { type: 'header', name: 'X-API-Key', value: 'v1' },
          idempotency: false,
        },
      }),
    );
    expect(d.dest.authType).toBe('header');
    expect(d.dest.authHeaderName).toBe('X-API-Key');
    expect(d.dest.authHeaderValue).toBe('v1');
    expect(d.dest.authToken).toBe('');
    expect(d.dest.headers).toEqual([]);
  });

  it('hydrates database targets, keeping only real renames', () => {
    const d = loadBridge(
      httpBridge({
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: 'c2',
              table: 'users_copy',
              writeMode: 'upsert',
              keyColumns: ['id'],
              mapping: [
                { source: 'id', target: 'id' },
                { source: 'email', target: 'mail' },
              ],
              createMissingTable: false,
            },
          ],
        },
      }),
    );
    expect(d.destKind).toBe('database');
    expect(d.dbTargets).toEqual([
      {
        connectionId: 'c2',
        database: '',
        schema: '',
        table: 'users_copy',
        writeMode: 'upsert',
        keyColumns: ['id'],
        createMissingTable: false,
        renames: { email: 'mail' }, // identity pairs dropped
      },
    ]);
    // the http form resets to blank when the bridge writes to databases
    expect(d.dest.url).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* buildInput: draft → BridgeInputDTO (save payload)                          */
/* -------------------------------------------------------------------------- */

describe('buildInput', () => {
  it('builds the exact http payload, with fields omitted when all are included', () => {
    const d = readyDraft();
    d.dest = {
      ...d.dest,
      method: 'PUT',
      authType: 'bearer',
      authToken: 'tok',
      headers: [
        { key: ' X-Env ', value: 'prod' },
        { key: '   ', value: 'dropped' },
      ],
      idempotency: true,
    };
    d.wrapKey = 'user';
    expect(buildInput(d, ctx())).toEqual({
      name: 'Users to CRM',
      source: {
        kind: 'table',
        connectionId: 'c1',
        database: 'app',
        schema: 'public',
        table: 'users',
        filters: undefined,
        sort: [{ column: 'id', direction: 'asc' }],
      },
      destination: {
        kind: 'http',
        url: 'https://api.example.com/webhook',
        method: 'PUT',
        headers: { 'X-Env': 'prod' },
        auth: { type: 'bearer', token: 'tok' },
        idempotency: true,
      },
      transform: { template: '{{$row}}', fields: undefined, wrapKey: 'user' },
      delivery: {
        batchSize: 1,
        maxAttempts: 3,
        minDelayMs: 0,
        timeoutMs: 15000,
        onError: 'continue',
        backoffMs: 500,
        backoffMaxMs: 30000,
        pageSize: 200,
      },
      trigger: { kind: 'replay' },
      enabled: true,
    });
  });

  it('pins fields (in table order) when a subset of columns is included', () => {
    const d = readyDraft();
    d.included = new Set(['name', 'id']); // insertion order differs from table order
    const input = buildInput(d, ctx());
    expect(input.transform.fields).toEqual(['id', 'name']);
  });

  it('emits an in-filter from the selection in selected mode', () => {
    const d = readyDraft();
    d.mode = 'selected';
    d.selectedKeys = new Map<string, unknown>([
      ['1', 1],
      ['2', 2],
    ]);
    const input = buildInput(d, ctx());
    expect(input.source.kind).toBe('table');
    if (input.source.kind === 'table') {
      expect(input.source.filters).toEqual([
        { column: 'id', operator: 'in', value: [1, 2] },
      ]);
    }
  });

  it('omits filters and sort without a single-column primary key', () => {
    const d = readyDraft();
    d.mode = 'selected';
    d.selectedKeys = new Map([['1', 1]]);
    const input = buildInput(d, ctx({ singlePk: null }));
    if (input.source.kind === 'table') {
      expect(input.source.filters).toBeUndefined();
      expect(input.source.sort).toBeUndefined();
    }
  });

  it('normalizes blank optionals: name falls back, empty database/schema/wrapKey become undefined', () => {
    const d = readyDraft();
    d.name = '   ';
    d.database = '';
    d.schema = '';
    const input = buildInput(d, ctx());
    expect(input.name).toBe('Send users');
    if (input.source.kind === 'table') {
      expect(input.source.database).toBeUndefined();
      expect(input.source.schema).toBeUndefined();
    }
    expect(input.transform.wrapKey).toBeUndefined();
    expect(
      input.destination.kind === 'http' ? input.destination.headers : null,
    ).toBeUndefined();
  });

  it('maps header auth and none auth', () => {
    const d = readyDraft();
    d.dest = {
      ...d.dest,
      authType: 'header',
      authHeaderName: 'X-API-Key',
      authHeaderValue: 'v',
    };
    let input = buildInput(d, ctx());
    if (input.destination.kind === 'http') {
      expect(input.destination.auth).toEqual({
        type: 'header',
        name: 'X-API-Key',
        value: 'v',
      });
    }
    d.dest = { ...d.dest, authType: 'none' };
    input = buildInput(d, ctx());
    if (input.destination.kind === 'http') {
      expect(input.destination.auth).toEqual({ type: 'none' });
    }
  });

  it('builds a database destination with the full included projection per target', () => {
    const d = readyDraft();
    d.included = new Set(['id', 'email']);
    d.destKind = 'database';
    d.dbTargets = [
      {
        connectionId: 'c2',
        database: '',
        schema: '',
        table: '  users_copy  ',
        writeMode: 'upsert',
        keyColumns: ['id'],
        createMissingTable: true,
        renames: { email: ' mail ', name: 'ignored' },
      },
    ];
    const input = buildInput(d, ctx());
    expect(input.destination).toEqual({
      kind: 'database',
      targets: [
        {
          connectionId: 'c2',
          database: undefined,
          schema: undefined,
          table: 'users_copy',
          writeMode: 'upsert',
          keyColumns: ['id'],
          mapping: [
            { source: 'id', target: 'id' },
            { source: 'email', target: 'mail' }, // rename trimmed
          ],
          createMissingTable: true,
        },
      ],
    });
  });

  it('builds watch triggers per strategy and clamps the poll interval to 1s', () => {
    const d = readyDraft();
    d.syncMode = 'live';
    d.triggerKind = 'watch';
    d.watchStrategy = 'increment';
    d.watchColumn = 'id';
    d.pollSeconds = 0.2;
    d.watchStartFrom = 'beginning';
    let input = buildInput(d, ctx());
    expect(input.trigger).toEqual({
      kind: 'watch',
      strategy: { strategy: 'increment', column: 'id' },
      pollIntervalMs: 1000,
      startFrom: 'beginning',
      maxPerPoll: 500,
    });

    d.watchStrategy = 'timestamp';
    d.watchColumn = 'updated_at';
    d.pollSeconds = 5;
    input = buildInput(d, ctx());
    expect(input.trigger).toEqual({
      kind: 'watch',
      strategy: { strategy: 'timestamp', column: 'updated_at', lookbackMs: 3000 },
      pollIntervalMs: 5000,
      startFrom: 'beginning',
      maxPerPoll: 500,
    });

    d.watchStrategy = 'snapshot';
    input = buildInput(d, ctx());
    expect(input.trigger).toEqual({
      kind: 'watch',
      strategy: { strategy: 'snapshot', maxTracked: 50000 },
      pollIntervalMs: 5000,
      startFrom: 'beginning',
      maxPerPoll: 500,
    });
  });

  it('builds a cdc trigger from the selected operations', () => {
    const d = readyDraft();
    d.syncMode = 'live';
    d.triggerKind = 'cdc';
    d.cdcOps = new Set(['update', 'delete']);
    expect(buildInput(d, ctx()).trigger).toEqual({
      kind: 'cdc',
      operations: ['update', 'delete'],
    });
  });

  it('round-trips a loaded bridge back into an equivalent save payload', () => {
    const bridge = httpBridge();
    const d = loadBridge(bridge);
    // simulate the columns-loaded effect applying the pinned fields
    d.included = new Set(['id', 'email']);
    const input = buildInput(d, ctx({ fallbackName: 'unused' }));
    expect(input.name).toBe(bridge.name);
    expect(input.source).toEqual({ ...bridge.source, filters: undefined, sort: [{ column: 'id', direction: 'asc' }] });
    expect(input.destination).toEqual(bridge.destination);
    expect(input.transform).toEqual(bridge.transform);
    expect(input.delivery).toEqual(bridge.delivery);
    expect(input.trigger).toEqual(bridge.trigger);
    expect(input.enabled).toBe(bridge.enabled);
  });
});
