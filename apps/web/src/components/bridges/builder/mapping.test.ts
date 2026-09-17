import { describe, expect, it } from 'vitest';
import type { Bridge } from '@syncle/core';
import { blankDbTarget, builderReducer, initialDraft } from './draft';
import {
  buildInput,
  coerceFilterValue,
  draftTransforms,
  loadBridge,
  type BuildInputContext,
} from './mapping';

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
      onSchemaChange: 'stop',
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
      onSchemaChange: 'stop',
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
      httpBridge({ trigger: { kind: 'cdc', operations: ['insert', 'delete'], startFrom: 'now', slot: 'own' } }),
    );
    expect(d.syncMode).toBe('live');
    expect(d.triggerKind).toBe('cdc');
    expect([...d.cdcOps]).toEqual(['insert', 'delete']);
    expect(d.cdcStartFrom).toBe('now');
  });

  it('keeps "copy what is there first" through a load and a save — and a bridge saved before it existed follows from now', () => {
    const copying = loadBridge(
      httpBridge({ trigger: { kind: 'cdc', operations: ['insert'], startFrom: 'beginning', slot: 'own' } }),
    );
    expect(copying.cdcStartFrom).toBe('beginning');
    expect(buildInput(copying, ctx()).trigger).toEqual({ kind: 'cdc', operations: ['insert'], startFrom: 'beginning', slot: 'own' });

    // stored before the option existed: no `startFrom` at all
    const older = loadBridge(httpBridge({ trigger: { kind: 'cdc', operations: ['insert'] } as never }));
    expect(older.cdcStartFrom).toBe('now');
    // a new bridge never copies a table nobody asked it to
    expect(initialDraft().cdcStartFrom).toBe('now');
  });

  it('the reducer switches it', () => {
    let d = readyDraft();
    d = builderReducer(d, { type: 'setCdcStartFrom', startFrom: 'beginning' });
    expect(d.cdcStartFrom).toBe('beginning');
    // the polling trigger has a start-from of its own; neither moves the other
    expect(d.watchStartFrom).toBe('now');
  });

  it('keeps the opt-in truncate operation through a load and a save', () => {
    const d = loadBridge(
      httpBridge({
        trigger: { kind: 'cdc', operations: ['insert', 'truncate'], startFrom: 'now', slot: 'own' },
      }),
    );
    expect(d.cdcOps.has('truncate')).toBe(true);
    expect(buildInput(d, ctx()).trigger).toEqual({
      kind: 'cdc',
      operations: ['insert', 'truncate'],
      startFrom: 'now',
      slot: 'own',
    });
  });

  it('carries the parts of a watch trigger it has no control for through an edit', () => {
    // saving used to write 500 / 50,000 / 3,000 every time: opening a bridge
    // and pressing Save undid whatever had been set through the API
    const timestamp = loadBridge(
      httpBridge({
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'timestamp', column: 'updated_at', lookbackMs: 45_000 },
          pollIntervalMs: 30_000,
          startFrom: 'beginning',
          maxPerPoll: 2000,
        },
      }),
    );
    expect(buildInput(timestamp, ctx()).trigger).toEqual({
      kind: 'watch',
      strategy: { strategy: 'timestamp', column: 'updated_at', lookbackMs: 45_000 },
      pollIntervalMs: 30_000,
      startFrom: 'beginning',
      maxPerPoll: 2000,
    });

    const snapshot = loadBridge(
      httpBridge({
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'snapshot', maxTracked: 120_000 },
          pollIntervalMs: 5000,
          startFrom: 'now',
          maxPerPoll: 50,
        },
      }),
    );
    expect(buildInput(snapshot, ctx()).trigger).toMatchObject({
      strategy: { strategy: 'snapshot', maxTracked: 120_000 },
      maxPerPoll: 50,
    });
  });

  it('a new bridge starts from the saved defaults, not from constants', () => {
    const d = initialDraft({
      pollIntervalMs: 60_000,
      maxPerPoll: 50,
      cdcOperations: ['insert'],
    });
    expect(d.pollSeconds).toBe(60);
    expect(d.maxPerPoll).toBe(50);
    expect([...d.cdcOps]).toEqual(['insert']);
    // and with none saved, from the built-in ones
    const plain = initialDraft();
    expect([plain.pollSeconds, plain.maxPerPoll, [...plain.cdcOps]]).toEqual([
      5,
      500,
      ['insert', 'update', 'delete'],
    ]);
  });

  it('never starts a bridge that captures nothing, whatever was saved', () => {
    expect([...initialDraft({ pollIntervalMs: 5000, maxPerPoll: 500, cdcOperations: [] }).cdcOps]).toEqual([
      'insert',
      'update',
      'delete',
    ]);
  });

  it('does not switch truncate on for a new bridge: it empties a table', () => {
    expect(initialDraft().cdcOps.has('truncate')).toBe(false);
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
              onDelete: 'delete',
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
        onDelete: 'delete',
        softDeleteColumn: 'deleted_at',
        softDeleteValue: 'timestamp',
        // a table: nothing of Redis about it
        redisMode: 'columns',
        redisKeyTemplate: '',
        redisType: 'hash',
        redisValueColumn: '',
        redisTtlSeconds: null,
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
        onSchemaChange: 'stop',
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
        ...blankDbTarget(),
        connectionId: 'c2',
        table: '  users_copy  ',
        keyColumns: ['id'],
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
          onDelete: 'delete',
          softDelete: undefined,
        },
      ],
    });
  });

  it('what a delete does to a target: kept through an edit; the marker only while it means something', () => {
    const d = loadBridge(
      httpBridge({
        destination: {
          kind: 'database',
          targets: [
            { connectionId: 'c2', table: 'a', writeMode: 'upsert', keyColumns: ['id'], mapping: [], createMissingTable: true, onDelete: 'soft', softDelete: { column: 'gone_at', value: 'timestamp' } },
            { connectionId: 'c2', table: 'b', writeMode: 'upsert', keyColumns: ['id'], mapping: [], createMissingTable: true, onDelete: 'ignore' },
            // saved before the option existed
            { connectionId: 'c2', table: 'c', writeMode: 'upsert', keyColumns: ['id'], mapping: [], createMissingTable: true } as never,
          ],
        },
      }),
    );
    expect(d.dbTargets.map((t) => [t.onDelete, t.softDeleteColumn, t.softDeleteValue])).toEqual([
      ['soft', 'gone_at', 'timestamp'],
      ['ignore', 'deleted_at', 'timestamp'],
      ['delete', 'deleted_at', 'timestamp'],
    ]);
    d.included = new Set(['id']);
    const saved = buildInput(d, ctx()).destination;
    expect(saved.kind === 'database' && saved.targets.map((t) => [t.onDelete, t.softDelete])).toEqual([
      ['soft', { column: 'gone_at', value: 'timestamp' }],
      ['ignore', undefined],
      ['delete', undefined],
    ]);

    // switched from soft to delete: the marker column goes with it
    d.dbTargets[0] = { ...d.dbTargets[0]!, onDelete: 'delete' };
    const again = buildInput(d, ctx()).destination;
    expect(again.kind === 'database' && again.targets[0]!.softDelete).toBeUndefined();
    // a new target removes rows, like every target before this
    expect(blankDbTarget()).toMatchObject({ onDelete: 'delete', softDeleteColumn: 'deleted_at', softDeleteValue: 'timestamp' });
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
      startFrom: 'now',
      slot: 'own',
    });
  });

  it('a shared replication slot is a PostgreSQL setting: kept through an edit there, and never sent for another engine', () => {
    const d = readyDraft();
    d.syncMode = 'live';
    d.triggerKind = 'cdc';
    expect(initialDraft().cdcSlot).toBe('own');
    const shared = builderReducer(d, { type: 'setCdcSlot', slot: 'shared' });
    expect(buildInput(shared, ctx({ sourceEngine: 'postgres' })).trigger).toMatchObject({ kind: 'cdc', slot: 'shared' });
    // the draft still remembers it, and what is saved does not claim it
    expect(buildInput(shared, ctx({ sourceEngine: 'mysql' })).trigger).toMatchObject({ slot: 'own' });
    expect(buildInput(shared, ctx()).trigger).toMatchObject({ slot: 'own' });

    const loaded = loadBridge(httpBridge({ trigger: { kind: 'cdc', operations: ['insert'], startFrom: 'now', slot: 'shared' } }));
    expect(loaded.cdcSlot).toBe('shared');
    expect(buildInput(loaded, ctx({ sourceEngine: 'postgres' })).trigger).toMatchObject({ slot: 'shared' });
    // saved before there was a choice: a slot of its own, as it has
    expect(loadBridge(httpBridge({ trigger: { kind: 'cdc', operations: ['insert'], startFrom: 'now' } as never })).cdcSlot).toBe('own');
  });

  it('choosing another slot asks the server again: what it said was about the other one', () => {
    const d = { ...readyDraft(), readiness: { ready: true } as never };
    expect(builderReducer(d, { type: 'setCdcSlot', slot: 'shared' }).readiness).toBeNull();
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

/* -------------------------------------------------------------------------- */
/* filters and column transforms                                              */
/* -------------------------------------------------------------------------- */

describe('what to do when the source table changes', () => {
  it('a new bridge stops rather than write NULL; a saved choice survives an edit', () => {
    expect(initialDraft().delivery.onSchemaChange).toBe('stop');
    const saved = httpBridge();
    saved.delivery = { ...saved.delivery, onSchemaChange: 'continue' };
    const d = loadBridge(saved);
    expect(d.delivery.onSchemaChange).toBe('continue');
    expect(buildInput(d, ctx()).delivery?.onSchemaChange).toBe('continue');
  });

  it('a bridge saved before the setting existed loads as `stop`', () => {
    const old = httpBridge();
    delete (old.delivery as Partial<Bridge['delivery']>).onSchemaChange;
    expect(loadBridge(old).delivery.onSchemaChange).toBe('stop');
  });

  it('`evolve` alters a destination table: switching to a webhook falls back to `stop`, and nothing else is touched', () => {
    let d = builderReducer(initialDraft(), { type: 'setDestKind', destKind: 'database', sourcePk: 'id' });
    d = builderReducer(d, { type: 'patchDelivery', patch: { onSchemaChange: 'evolve', maxAttempts: 9 } });
    const http = builderReducer(d, { type: 'setDestKind', destKind: 'http', sourcePk: 'id' });
    expect(http.delivery).toEqual({ ...d.delivery, onSchemaChange: 'stop' });
    // `continue` is as valid for a webhook as for a table
    d = builderReducer(d, { type: 'patchDelivery', patch: { onSchemaChange: 'continue' } });
    expect(builderReducer(d, { type: 'setDestKind', destKind: 'http', sourcePk: 'id' }).delivery.onSchemaChange).toBe('continue');
  });
});

describe('source filters', () => {
  const filtered = () =>
    httpBridge({
      source: {
        kind: 'table',
        connectionId: 'c1',
        database: 'app',
        schema: 'public',
        table: 'users',
        filters: [
          { column: 'id', operator: 'in', value: [1, 2] },
          { column: 'age', operator: 'gte', value: 18 },
          { column: 'deleted_at', operator: 'isNull' },
          { column: 'active', operator: 'eq', value: true },
          // nothing in the editor can show these two
          { column: 'country', operator: 'in', value: ['IT', 'AF'] },
          { column: 'meta', operator: 'eq', value: { a: 1 } as never },
        ],
      },
    });

  it('loads the editable ones into rows and sets the rest aside, untouched', () => {
    const d = loadBridge(filtered());
    expect(d.mode).toBe('selected');
    expect([...d.selectedKeys.values()]).toEqual([1, 2]);
    expect(d.filters.map(({ id: _id, ...f }) => f)).toEqual([
      { column: 'age', operator: 'gte', value: '18' },
      { column: 'deleted_at', operator: 'isNull', value: '' },
      { column: 'active', operator: 'eq', value: 'true' },
    ]);
    expect(d.extraFilters).toEqual([
      { column: 'country', operator: 'in', value: ['IT', 'AF'] },
      { column: 'meta', operator: 'eq', value: { a: 1 } },
    ]);
    // ids are what React keys the rows by
    expect(new Set(d.filters.map((f) => f.id)).size).toBe(3);
  });

  it('saves every filter it loaded: an edit used to delete all but the row selection', () => {
    const bridge = filtered();
    const d = loadBridge(bridge);
    d.included = new Set(['id', 'email']);
    const input = buildInput(
      d,
      ctx({ columnTypes: { age: 'number', active: 'boolean' } }),
    );
    expect(input.source.kind === 'table' && input.source.filters).toEqual(
      bridge.source.kind === 'table' ? bridge.source.filters : [],
    );
  });

  it('sends a number for a numeric column, and text where a number would be rounded', () => {
    expect(coerceFilterValue('42', 'number')).toBe(42);
    expect(coerceFilterValue(' 4.5 ', 'number')).toBe(4.5);
    expect(coerceFilterValue('-7', 'bigint')).toBe(-7);
    // 2^53 + 1 is not a number JavaScript can hold; the engine compares the text
    expect(coerceFilterValue('9007199254740993', 'number')).toBe('9007199254740993');
    expect(coerceFilterValue('abc', 'number')).toBe('abc');
    expect(coerceFilterValue('', 'number')).toBe('');
    expect(coerceFilterValue('TRUE', 'boolean')).toBe(true);
    expect(coerceFilterValue('false', 'boolean')).toBe(false);
    expect(coerceFilterValue('yes', 'boolean')).toBe('yes');
    // text stays exactly as typed, spaces and all, and "42" in a text column is text
    expect(coerceFilterValue(' 42 ', 'string')).toBe(' 42 ');
    expect(coerceFilterValue('42', undefined)).toBe('42');
  });

  it('never turns a half-written condition into "no condition"', () => {
    const d = readyDraft();
    d.filters = [
      { id: 'a', column: 'age', operator: 'gt', value: '  ' },
      { id: 'b', column: '', operator: 'eq', value: 'x' },
      { id: 'c', column: 'name', operator: 'notNull', value: 'ignored' },
    ];
    // (the builder does not let such a draft be saved; this is the belt to that brace)
    const input = buildInput(d, ctx());
    expect(input.source.kind === 'table' && input.source.filters).toEqual([
      { column: 'name', operator: 'notNull' },
    ]);
  });

  it('the reducer adds, edits and removes a condition, and a new table starts clean', () => {
    let d = readyDraft();
    d = builderReducer(d, { type: 'addFilter', column: 'age' });
    const id = d.filters[0]!.id;
    expect(d.filters[0]).toMatchObject({ column: 'age', operator: 'eq', value: '' });
    d = builderReducer(d, { type: 'patchFilter', id, patch: { operator: 'lt', value: '30' } });
    expect(d.filters[0]).toMatchObject({ column: 'age', operator: 'lt', value: '30' });
    d = builderReducer(d, { type: 'addFilter', column: 'name' });
    d = builderReducer(d, { type: 'removeFilter', id });
    expect(d.filters.map((f) => f.column)).toEqual(['name']);
    d = builderReducer(d, { type: 'addTransform', transform: { kind: 'text', column: 'name', op: 'trim' } });
    const rules = d;
    // conditions and steps name columns of the table they were written for
    for (const leave of [
      { type: 'selectTable', table: 'orders' },
      { type: 'selectDatabase', database: 'other' },
      { type: 'selectConnection', connectionId: 'c9' },
    ] as const) {
      const left = builderReducer({ ...rules, extraFilters: [{ column: 'x', operator: 'in', value: [1] }] }, leave);
      expect(left.filters, leave.type).toEqual([]);
      expect(left.extraFilters, leave.type).toEqual([]);
      expect(left.transforms, leave.type).toEqual([]);
    }
    // each of them gets lists of its own: one draft's edits must not show up in another
    const a = builderReducer(rules, { type: 'selectTable', table: 'a' });
    const b = builderReducer(rules, { type: 'selectTable', table: 'b' });
    expect(a.filters).not.toBe(b.filters);
  });
});

describe('column transforms', () => {
  const steps = [
    { kind: 'text', column: 'email', op: 'lower' },
    { kind: 'mask', column: 'email', mode: 'hash', keepStart: 0, keepEnd: 4, fill: '*', salt: 's' },
    { kind: 'cast', column: 'id', to: 'string', onError: 'null' },
    { kind: 'set', column: 'label', template: '{{name}} <{{email}}>' },
    { kind: 'default', column: 'tier', value: 'free' },
  ] as const;

  it('round-trips: loaded in order, saved in order, with nothing of the editor in the payload', () => {
    const bridge = httpBridge({
      transform: {
        template: '{"user": "{{name}}"}',
        rename: { email: 'mail' },
        fields: ['id', 'email', 'label', 'tier'],
        columns: [...steps],
      },
    });
    const d = loadBridge(bridge);
    expect(d.transforms.map((t) => t.kind)).toEqual(['text', 'mask', 'cast', 'set', 'default']);
    d.included = new Set(['id', 'email']);
    const input = buildInput(d, ctx());
    // template and rename have no control in the builder: an edit used to reset them
    expect(input.transform).toEqual(bridge.transform);
    expect(JSON.stringify(input.transform.columns)).not.toContain('"id":"d');
  });

  it('a column the steps ADD is sent like any other: in fields, and in every target mapping', () => {
    const d = readyDraft();
    d.transforms = steps.map((t, i) => ({ ...t, id: `t${i}` }));
    const http = buildInput(d, ctx());
    // every source column is ticked, and still the list is pinned: "all" would not include the new ones
    expect(http.transform.fields).toEqual(['id', 'email', 'name', 'label', 'tier']);

    d.destKind = 'database';
    d.dbTargets = [
      {
        ...blankDbTarget(),
        connectionId: 'c2',
        table: 'users_copy',
        keyColumns: ['id'],
        renames: { label: 'display_name' },
      },
    ];
    const db = buildInput(d, ctx());
    expect(db.destination.kind === 'database' && db.destination.targets[0]!.mapping).toEqual([
      { source: 'id', target: 'id' },
      { source: 'email', target: 'email' },
      { source: 'name', target: 'name' },
      { source: 'label', target: 'display_name' },
      { source: 'tier', target: 'tier' },
    ]);
  });

  it('a step that REPLACES an existing column adds nothing, and an unticked column stays out', () => {
    const d = readyDraft();
    d.included = new Set(['id', 'name']);
    d.transforms = [
      { id: 'a', kind: 'set', column: 'name', template: '{{name}}!' },
      { id: 'b', kind: 'default', column: 'email', value: 'none' },
    ];
    expect(buildInput(d, ctx()).transform.fields).toEqual(['id', 'name']);
  });

  it('a default typed for a numeric or boolean column is sent as one; a loaded one is left as it is', () => {
    const d = readyDraft();
    d.transforms = [
      { id: 'a', kind: 'default', column: 'age', value: '0' },
      { id: 'b', kind: 'default', column: 'active', value: 'true' },
      { id: 'c', kind: 'default', column: 'name', value: '0' },
      // these came from the API as they are, and nobody retyped them
      { id: 'd', kind: 'default', column: 'score', value: 5 },
      { id: 'e', kind: 'default', column: 'note', value: null },
    ];
    const types = { age: 'number', active: 'boolean', name: 'string', score: 'number' };
    expect(draftTransforms(d, types).map((t) => (t.kind === 'default' ? t.value : '?'))).toEqual([
      0,
      true,
      '0',
      5,
      null,
    ]);
    // what is saved and what the preview runs are the same list
    expect(buildInput(d, ctx({ columnTypes: types })).transform.columns).toEqual(draftTransforms(d, types));
    // with nothing known about the columns, what was typed is what is sent
    expect(draftTransforms(d).map((t) => (t.kind === 'default' ? t.value : '?'))).toEqual(['0', 'true', '0', 5, null]);
  });

  it('no steps means no `columns` key, so an untouched bridge saves as it was', () => {
    expect(buildInput(readyDraft(), ctx()).transform.columns).toBeUndefined();
  });

  it('the reducer replaces a step in place and moves it within bounds', () => {
    let d = readyDraft();
    for (const t of steps.slice(0, 3)) d = builderReducer(d, { type: 'addTransform', transform: { ...t } });
    const [a, b, c] = d.transforms.map((t) => t.id);
    d = builderReducer(d, {
      type: 'replaceTransform',
      id: b!,
      transform: { kind: 'mask', column: 'email', mode: 'redact', keepStart: 0, keepEnd: 4, fill: '#' },
    });
    expect(d.transforms[1]).toMatchObject({ id: b, mode: 'redact', fill: '#' });
    d = builderReducer(d, { type: 'moveTransform', id: c!, by: -1 });
    expect(d.transforms.map((t) => t.id)).toEqual([a, c, b]);
    // already first / already last: nothing happens, nothing is lost
    d = builderReducer(d, { type: 'moveTransform', id: a!, by: -1 });
    d = builderReducer(d, { type: 'moveTransform', id: b!, by: 1 });
    expect(d.transforms.map((t) => t.id)).toEqual([a, c, b]);
    d = builderReducer(d, { type: 'removeTransform', id: c! });
    expect(d.transforms.map((t) => t.id)).toEqual([a, b]);
  });
});
