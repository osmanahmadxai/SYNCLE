/**
 * when the bulb lights, and what it says. each rule is held to the situation
 * it is for — and to staying quiet where it is not.
 */
import { describe, expect, it } from 'vitest';
import type {
  Bridge,
  BridgeJob,
  BridgeSourceHold,
  ConnectionConfig,
  DeadLetterPage,
} from '@syncle/core';
import {
  diagnose,
  formatBytes,
  topSeverity,
  type DiagnoseInput,
} from './diagnose';

const connections = [
  { id: 'pg', name: 'Shop (source)', engine: 'postgres' },
  { id: 'replica', name: 'Shop Replica (target)', engine: 'postgres' },
  { id: 'cache', name: 'cache', engine: 'redis' },
] as ConnectionConfig[];

/** the bridge the bulb was built for: CDC, every change inserted */
const replica = {
  id: 'b1',
  name: 'Customers → Replica',
  enabled: true,
  trigger: {
    kind: 'cdc',
    operations: ['insert', 'update', 'delete'],
    startFrom: 'now',
  },
  source: {
    kind: 'table',
    connectionId: 'pg',
    database: 'shop',
    table: 'customers',
  },
  destination: {
    kind: 'database',
    targets: [
      {
        connectionId: 'replica',
        database: 'shop_replica',
        table: 'customers',
        writeMode: 'insert',
        keyColumns: ['id'],
        mapping: [],
      },
    ],
  },
  transform: { template: '{{$row}}' },
  delivery: { onError: 'continue', maxAttempts: 3 },
} as unknown as Bridge;

const with_ = (b: Bridge, over: Record<string, unknown>) =>
  ({ ...b, ...over }) as Bridge;

function input(over: Partial<DiagnoseInput> = {}): DiagnoseInput {
  return {
    bridges: [replica],
    connections,
    statuses: new Map([['b1', { active: true, lastStatus: 'running' }]]),
    deadLetters: new Map(),
    jobs: new Map(),
    sourceHolds: new Map(),
    drift: new Map(),
    loaded: true,
    ...over,
  };
}

const rules = (i: DiagnoseInput) =>
  diagnose(i).map((h) => `${h.rule}:${h.severity}`);

const duplicate: DeadLetterPage = {
  items: [
    {
      id: 'd1',
      bridgeId: 'b1',
      jobId: 'j1',
      sequence: 7,
      op: 'update',
      rowCount: 1,
      rows: [{ id: 1, name: 'Ada Lovelace' }],
      error:
        'customers: duplicate key value violates unique constraint "customers_pkey" — 1 row moved to the dead-letter queue',
      attempts: 1,
    } as unknown as DeadLetterPage['items'][number],
  ],
  pendingEntries: 1,
  pendingRows: 1,
};

describe('a live bridge that inserts every change', () => {
  it('is warned about before an update ever comes', () => {
    const hint = diagnose(input()).find((h) => h.rule === 'insert-on-live');
    expect(hint).toMatchObject({
      severity: 'warning',
      bridgeId: 'b1',
      values: { bridge: 'Customers → Replica', table: 'customers', keys: 'id' },
      actions: [{ kind: 'edit-bridge', bridgeId: 'b1' }],
      guide: 'write-modes',
    });
  });

  it('is critical once an update has been refused as a duplicate — and the set-aside rows say why', () => {
    const hints = diagnose(
      input({ deadLetters: new Map([['b1', duplicate]]) }),
    );
    expect(hints.find((h) => h.rule === 'insert-on-live')?.severity).toBe(
      'critical',
    );
    expect(hints.find((h) => h.rule === 'dead-letters')).toMatchObject({
      severity: 'critical',
      cause: 'duplicate-key',
      values: { count: 1 },
      detail: expect.stringContaining('customers_pkey'),
    });
    // a dismissed warning comes back now that it has happened
    const before = diagnose(input()).find((h) => h.rule === 'insert-on-live')!;
    const after = hints.find((h) => h.rule === 'insert-on-live')!;
    expect(after.id).toBe(before.id);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('is fine as an upsert, on a one-time job, or on a watch that only sees new rows', () => {
    const upsert = with_(replica, {
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: 'replica',
            table: 'customers',
            writeMode: 'upsert',
            keyColumns: ['id'],
          },
        ],
      },
    });
    const once = with_(replica, { trigger: { kind: 'replay' } });
    const byId = with_(replica, {
      trigger: {
        kind: 'watch',
        strategy: { strategy: 'increment', column: 'id' },
        pollIntervalMs: 5000,
      },
    });
    const byTime = with_(replica, {
      trigger: {
        kind: 'watch',
        strategy: { strategy: 'timestamp', column: 'updated_at' },
        pollIntervalMs: 5000,
      },
    });
    for (const b of [upsert, once, byId]) {
      expect(rules(input({ bridges: [b] }))).not.toContain(
        'insert-on-live:warning',
      );
    }
    // an updated row moves past a timestamp cursor again: the same trap
    expect(rules(input({ bridges: [byTime] }))).toContain(
      'insert-on-live:warning',
    );
  });
});

describe('what has gone wrong', () => {
  it('names a failed run by its error', () => {
    const job = {
      id: 'j2',
      error: 'password authentication failed for user "x"',
      prunedDeliveries: 0,
    } as BridgeJob;
    const hint = diagnose(
      input({
        statuses: new Map([['b1', { active: false, lastStatus: 'failed' }]]),
        jobs: new Map([['b1', [job]]]),
      }),
    ).find((h) => h.rule === 'failed');
    expect(hint).toMatchObject({
      severity: 'critical',
      cause: 'auth-failed',
      guide: 'connections',
    });
  });

  it('says a bridge points at a connection that is gone — once the lists are in', () => {
    const orphan = with_(replica, {
      source: { kind: 'table', connectionId: 'deleted', table: 't' },
    });
    expect(rules(input({ bridges: [orphan] }))).toContain(
      'missing-connection:critical',
    );
    expect(rules(input({ bridges: [orphan], loaded: false }))).not.toContain(
      'missing-connection:critical',
    );
  });

  it('warns of change log piling up on the source, louder when it is critical', () => {
    const hold = (level: BridgeSourceHold['level']) =>
      ({
        level,
        retainedBytes: 3 * 1024 ** 3,
        running: false,
        message: 'slot inactive',
      }) as BridgeSourceHold;
    const warn = diagnose(
      input({ sourceHolds: new Map([['b1', hold('warn')]]) }),
    ).find((h) => h.rule === 'source-hold');
    expect(warn).toMatchObject({
      severity: 'warning',
      values: { size: '3.0 GB', running: 'no' },
    });
    expect(
      rules(input({ sourceHolds: new Map([['b1', hold('critical')]]) })),
    ).toContain('source-hold:critical');
    expect(
      rules(input({ sourceHolds: new Map([['b1', hold('ok')]]) })),
    ).not.toContain('source-hold:warning');
  });

  it('tells a schema change that stops the bridge from one that does not', () => {
    const drift = (missingUsed: string[]) =>
      new Map([
        [
          'b1',
          {
            drift: { added: [], removed: [], retyped: [] },
            missingUsed,
            checkedAt: '2026-10-19T00:00:00Z',
            baselineAt: null,
          },
        ],
      ]) as unknown as DiagnoseInput['drift'];
    expect(rules(input({ drift: drift(['plan']) }))).toContain(
      'schema-drift:critical',
    );
    expect(rules(input({ drift: drift([]) }))).toContain('schema-drift:info');
  });
});

describe('good to know', () => {
  it('a CDC bridge from now has not copied what was there', () => {
    expect(rules(input())).toContain('cdc-from-now:info');
    const backfilled = with_(replica, {
      trigger: { ...replica.trigger, startFrom: 'beginning' },
    });
    expect(rules(input({ bridges: [backfilled] }))).not.toContain(
      'cdc-from-now:info',
    );
  });

  it('Redis change capture is not durable', () => {
    const fromRedis = with_(replica, {
      source: { kind: 'table', connectionId: 'cache', table: 'user:*' },
    });
    expect(rules(input({ bridges: [fromRedis] }))).toContain('redis-cdc:info');
  });

  it('a live bridge that stops on one bad row; an endpoint that can be sent a row twice', () => {
    const aborting = with_(replica, { delivery: { onError: 'abort' } });
    expect(rules(input({ bridges: [aborting] }))).toContain(
      'abort-on-live:info',
    );
    const hook = with_(replica, {
      trigger: { kind: 'replay' },
      destination: {
        kind: 'http',
        url: 'https://x.example/hook',
        method: 'POST',
        idempotency: false,
      },
      delivery: { maxAttempts: 3 },
    });
    expect(rules(input({ bridges: [hook] }))).toContain(
      'http-no-idempotency:info',
    );
    const safe = with_(hook, {
      destination: { ...hook.destination, idempotency: true },
    });
    expect(rules(input({ bridges: [safe] }))).not.toContain(
      'http-no-idempotency:info',
    );
  });

  it('a run whose old deliveries lost their details — why its table looks empty', () => {
    const job = { id: 'j1', error: null, prunedDeliveries: 6 } as BridgeJob;
    const hint = diagnose(input({ jobs: new Map([['b1', [job]]]) })).find(
      (h) => h.rule === 'history-pruned',
    );
    expect(hint).toMatchObject({
      severity: 'info',
      values: { count: 6 },
      guide: 'monitoring',
    });
  });

  it('where to start, in an empty workspace', () => {
    expect(rules(input({ bridges: [], connections: [] }))).toEqual([
      'no-connections:info',
    ]);
    expect(rules(input({ bridges: [] }))).toEqual(['no-bridges:info']);
    expect(
      rules(input({ bridges: [], connections: [], loaded: false })),
    ).toEqual([]);
  });
});

describe('the bulb', () => {
  it('lists the worst first, and is lit by the worst', () => {
    const hints = diagnose(
      input({ deadLetters: new Map([['b1', duplicate]]) }),
    );
    const order = hints.map((h) => h.severity);
    expect(order).toEqual(
      [...order].sort(
        (a, b) =>
          ['critical', 'warning', 'info'].indexOf(a) -
          ['critical', 'warning', 'info'].indexOf(b),
      ),
    );
    expect(topSeverity(hints)).toBe('critical');
    expect(topSeverity(hints.filter((h) => h.severity === 'info'))).toBe(
      'info',
    );
    expect(topSeverity([])).toBeNull();
  });

  it('says sizes as people read them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 ** 2)).toBe('20 MB');
  });
});
