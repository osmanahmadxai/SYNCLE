/**
 * DeadLetterService with in-memory doubles (no live database): parking is
 * complete and repeat-safe, and a retry converges the destination on the
 * source's CURRENT state instead of replaying a possibly outdated recording.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { CdcOperation, DatabaseTarget, FilterSpec } from '@syncle/core';
import {
  DeadLetterService,
  type NewDeadLetter,
} from '../src/bridges/dead-letter.service';
import { targetKey } from '../src/bridges/database-sink.service';
import type {
  DeliveryOutcome,
  ResolvedBridge,
} from '../src/bridges/bridges.types';

type Row = Record<string, unknown>;

/* ----- doubles ----- */

/** Prisma promises are lazy: nothing runs until awaited (or a transaction runs it) */
function lazy<T>(run: () => T): PromiseLike<T> {
  let p: Promise<T> | null = null;
  return {
    then: (ok, bad) => (p ??= Promise.resolve().then(run)).then(ok, bad),
  };
}

interface StoredLetter {
  id: string;
  bridgeId: string;
  jobId: string;
  sequence: number;
  op: string | null;
  rowsJson: string;
  rowCount: number;
  cursor: string | null;
  error: string | null;
  attempts: number;
  status: string;
  succeededTargetsJson: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface StoredDelivery {
  jobId: string;
  sequence: number;
  status: string;
  rowIndex: number;
  rowCount: number;
  rowKeysJson: string | null;
  httpStatus: number | null;
  attempts: number;
  requestBody: string | null;
  durationMs: number | null;
}

function matches(l: StoredLetter, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const actual = (l as unknown as Record<string, unknown>)[k];
    if (v && typeof v === 'object') {
      const cond = v as { in?: unknown[]; gte?: number; not?: unknown };
      if (cond.in && !cond.in.includes(actual)) return false;
      if (cond.gte !== undefined && !((actual as number) >= cond.gte))
        return false;
      if ('not' in cond && actual === cond.not) return false;
    } else if (actual !== v) return false;
  }
  return true;
}

function makePrisma(deliveries: StoredDelivery[] = []) {
  const letters: StoredLetter[] = [];
  let clock = 0;
  const bridgeDeadLetter = {
    createMany: ({ data }: { data: Partial<StoredLetter>[] }) =>
      lazy(() => {
        for (const d of data) {
          letters.push({
            attempts: 0,
            status: 'pending',
            resolvedAt: null,
            createdAt: new Date(1_000 + clock++),
            ...(d as StoredLetter),
          });
        }
        return { count: data.length };
      }),
    deleteMany: ({ where }: { where: Record<string, unknown> }) =>
      lazy(() => {
        const before = letters.length;
        for (let i = letters.length - 1; i >= 0; i--) {
          if (matches(letters[i]!, where)) letters.splice(i, 1);
        }
        return { count: before - letters.length };
      }),
    findMany: ({
      where,
      take,
    }: {
      where: Record<string, unknown>;
      take?: number;
    }) =>
      lazy(() =>
        letters
          .filter((l) => matches(l, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take ?? letters.length),
      ),
    aggregate: ({ where }: { where: Record<string, unknown> }) =>
      lazy(() => {
        const hit = letters.filter((l) => matches(l, where));
        return {
          _sum: { rowCount: hit.reduce((n, l) => n + l.rowCount, 0) || null },
          _count: hit.length,
        };
      }),
    count: ({ where }: { where: Record<string, unknown> }) =>
      lazy(() => letters.filter((l) => matches(l, where)).length),
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) =>
      lazy(() => {
        const l = letters.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          const inc = (v as { increment?: number } | null)?.increment;
          (l as unknown as Record<string, unknown>)[k] =
            inc !== undefined
              ? ((l as unknown as Record<string, number>)[k] ?? 0) + inc
              : v;
        }
        return l;
      }),
    updateMany: ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<StoredLetter>;
    }) =>
      lazy(() => {
        const hit = letters.filter((l) => matches(l, where));
        hit.forEach((l) => Object.assign(l, data));
        return { count: hit.length };
      }),
  };
  const bridgeDelivery = {
    findUnique: ({
      where,
    }: {
      where: { jobId_sequence: { jobId: string; sequence: number } };
    }) =>
      lazy(
        () =>
          deliveries.find(
            (d) =>
              d.jobId === where.jobId_sequence.jobId &&
              d.sequence === where.jobId_sequence.sequence,
          ) ?? null,
      ),
  };
  const prisma = {
    bridgeDeadLetter,
    bridgeDelivery,
    $transaction: async (ops: PromiseLike<unknown>[]) => {
      const out: unknown[] = [];
      for (const op of ops) out.push(await op); // in order, like the real thing
      return out;
    },
  };
  return { prisma, letters };
}

const TARGET: DatabaseTarget = {
  connectionId: 'dst',
  table: 'users_copy',
  writeMode: 'upsert',
  keyColumns: ['id'],
  mapping: [],
  createMissingTable: true,
};

function makeBridge(over: Partial<ResolvedBridge> = {}): ResolvedBridge {
  return {
    id: 'b1',
    name: 'bridge',
    source: { kind: 'table', connectionId: 'src', table: 'users' },
    destination: { kind: 'database', targets: [TARGET] },
    transform: { template: '{{$row}}' },
    delivery: {
      batchSize: 1,
      maxAttempts: 1,
      backoffMs: 0,
      backoffMaxMs: 0,
      minDelayMs: 0,
      timeoutMs: 1000,
      pageSize: 200,
      onError: 'continue',
    },
    trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
    enabled: true,
    ...over,
  } as ResolvedBridge;
}

const OK: DeliveryOutcome = {
  status: 'success',
  httpStatus: null,
  attempts: 1,
  error: null,
  requestBody: null,
  responseBody: null,
  durationMs: 1,
};
const failed = (
  error: string,
  succeededTargets: string[] = [],
): DeliveryOutcome => ({
  ...OK,
  status: 'failed',
  error,
  succeededTargets,
});

interface Harness {
  service: DeadLetterService;
  letters: StoredLetter[];
  /** writes made through the database sink: [targets, rows, op] */
  dbWrites: { targets: string[]; rows: Row[]; op: CdcOperation | undefined }[];
  /** deliveries made through the generic sink (HTTP / as-recorded) */
  sinkCalls: {
    rows: Row[];
    op: CdcOperation | undefined;
    skipTargets?: string[];
    idem?: string;
  }[];
  recorded: { jobId: string; sequence: number; status: string }[];
  browses: FilterSpec[][];
  /** what the schema-drift check says about the source table; a test may change it */
  drift: { stop: string | null; missingUsed: string[]; drift: null };
}

function makeHarness(opts: {
  bridge?: ResolvedBridge;
  sourceRows?: Row[];
  primaryKey?: string[];
  dbOutcome?: (
    targets: DatabaseTarget[],
    rows: Row[],
    op: CdcOperation | undefined,
  ) => DeliveryOutcome;
  sinkOutcome?: () => DeliveryOutcome;
  deliveries?: StoredDelivery[];
}): Harness {
  const bridge = opts.bridge ?? makeBridge();
  const sourceRows = opts.sourceRows ?? [];
  const primaryKey = opts.primaryKey ?? ['id'];
  const { prisma, letters } = makePrisma(opts.deliveries);
  const h: Harness = {
    service: null as never,
    letters,
    dbWrites: [],
    sinkCalls: [],
    recorded: [],
    browses: [],
    drift: { stop: null, missingUsed: [], drift: null },
  };

  const adapter = {
    browse: async (p: { filters?: FilterSpec[]; limit: number }) => {
      const filters = p.filters ?? [];
      h.browses.push(filters);
      const rows = sourceRows.filter((r) =>
        filters.every((f) =>
          f.operator === 'in'
            ? (f.value as unknown[]).map(String).includes(String(r[f.column]))
            : String(r[f.column]) === String(f.value),
        ),
      );
      return { rows: rows.slice(0, p.limit), primaryKey };
    },
  };
  const store = { get: async () => bridge, resolve: async () => bridge };
  const pool = {
    withAdapter: async (
      _id: string,
      _db: unknown,
      fn: (a: unknown) => unknown,
    ) => fn(adapter),
  };
  const sink = {
    deliver: async (
      _b: ResolvedBridge,
      rows: Row[],
      ctx: { op?: CdcOperation; skipTargets?: string[] },
      _signal: AbortSignal,
      idem?: string,
    ) => {
      h.sinkCalls.push({
        rows,
        op: ctx.op,
        skipTargets: ctx.skipTargets,
        idem,
      });
      return { outcome: opts.sinkOutcome?.() ?? OK, warnings: [] };
    },
  };
  const databaseSink = {
    deliver: async (
      _b: ResolvedBridge,
      targets: DatabaseTarget[],
      rows: Row[],
      op: CdcOperation | undefined,
    ) => {
      h.dbWrites.push({ targets: targets.map(targetKey), rows, op });
      return opts.dbOutcome?.(targets, rows, op) ?? OK;
    },
  };
  const jobs = {
    recordDelivery: async (
      jobId: string,
      meta: { sequence: number },
      outcome: DeliveryOutcome,
    ) => {
      h.recorded.push({
        jobId,
        sequence: meta.sequence,
        status: outcome.status,
      });
    },
  };

  h.service = new DeadLetterService(
    prisma as never,
    store as never,
    pool as never,
    sink as never,
    databaseSink as never,
    jobs as never,
    // alerts are fire-and-forget; what they say is tested with the alerts
    { emit: () => undefined, emitForJob: () => undefined } as never,
    // the source table is what the bridge was built on, unless a test says otherwise
    { check: async () => h.drift } as never,
  );
  return h;
}

const letter = (over: Partial<NewDeadLetter> = {}): NewDeadLetter => ({
  bridgeId: 'b1',
  jobId: 'j1',
  sequence: 5,
  op: 'update',
  rows: [{ id: 1, name: 'recorded' }],
  cursor: '0/16B3748',
  error: 'violates check constraint',
  succeededTargets: [],
  ...over,
});

/* ----- tests ----- */

describe('park', () => {
  it('stores the complete rows, however large, and counts them', async () => {
    const h = makeHarness({});
    const wide = {
      id: 1,
      blob: Buffer.alloc(200_000, 7),
      at: new Date('2026-09-17T00:00:00.000Z'),
    };
    await h.service.park([
      letter({ rows: [wide] }),
      letter({ rows: [{ id: 2 }, { id: 3 }] }),
    ]);

    expect(h.letters).toHaveLength(2);
    // nothing is capped: the 16 KB display limit is exactly what loses rows
    expect(h.letters[0]!.rowsJson.length).toBeGreaterThan(200_000);
    expect(await h.service.pendingRows('b1')).toBe(3);
  });

  it('a repeat after a crash replaces the earlier attempt instead of doubling it', async () => {
    const h = makeHarness({});
    await h.service.park([letter({ sequence: 5 })], { replaceFrom: 5 });
    // the process died before the cursor was saved: same batch, same sequence
    await h.service.park([letter({ sequence: 5 })], { replaceFrom: 5 });
    expect(h.letters).toHaveLength(1);
  });

  it('never replaces settled sequences, resolved entries, or another job', async () => {
    const h = makeHarness({});
    await h.service.park([letter({ sequence: 2 })]); // earlier, already checkpointed
    await h.service.park([letter({ sequence: 9, jobId: 'other-job' })]);
    await h.service.park([letter({ sequence: 5 })]);
    h.letters.find((l) => l.sequence === 5)!.status = 'resolved';

    await h.service.park([letter({ sequence: 5 })], { replaceFrom: 5 });
    expect(
      h.letters.map((l) => `${l.jobId}:${l.sequence}:${l.status}`).sort(),
    ).toEqual([
      'j1:2:pending',
      'j1:5:pending',
      'j1:5:resolved',
      'other-job:9:pending',
    ]);
  });
});

describe('retry: database destination, keyed source', () => {
  it('writes the CURRENT source row, not the outdated recording', async () => {
    const h = makeHarness({ sourceRows: [{ id: 1, name: 'newer' }] });
    await h.service.park([letter({ rows: [{ id: 1, name: 'recorded' }] })]);

    const res = await h.service.retry('b1', { force: false });

    expect(res).toEqual({ resolved: 1, stillFailing: 0, needsForce: 0 });
    expect(h.dbWrites).toEqual([
      {
        targets: [targetKey(TARGET)],
        rows: [{ id: 1, name: 'newer' }],
        op: undefined,
      },
    ]);
    expect(h.letters[0]).toMatchObject({
      status: 'resolved',
      attempts: 1,
      error: null,
    });
    expect(h.letters[0]!.resolvedAt).toBeInstanceOf(Date);
  });

  it('deletes at the destination when the source row is gone', async () => {
    const h = makeHarness({ sourceRows: [] });
    await h.service.park([letter({ rows: [{ id: 1, name: 'recorded' }] })]);

    const res = await h.service.retry('b1', { force: false });

    expect(res.resolved).toBe(1);
    expect(h.dbWrites).toEqual([
      {
        targets: [targetKey(TARGET)],
        rows: [{ id: 1, name: 'recorded' }],
        op: 'delete',
      },
    ]);
  });

  it('re-reads many rows by key in one query', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      name: `r${i}`,
    }));
    const h = makeHarness({ sourceRows: rows });
    await h.service.park(
      rows.map((r) => letter({ rows: [{ ...r, name: 'old' }] })),
    );

    const res = await h.service.retry('b1', { force: false });
    expect(res.resolved).toBe(40);
    expect(h.dbWrites.every((w) => w.rows[0]!.name !== 'old')).toBe(true);
  });

  it('looks a composite key up column by column', async () => {
    const h = makeHarness({
      primaryKey: ['tenant', 'id'],
      sourceRows: [
        { tenant: 'a', id: 1, name: 'a1-now' },
        { tenant: 'b', id: 1, name: 'b1-now' },
      ],
    });
    await h.service.park([
      letter({ rows: [{ tenant: 'b', id: 1, name: 'old' }] }),
    ]);

    await h.service.retry('b1', { force: false });
    expect(h.dbWrites[0]!.rows).toEqual([
      { tenant: 'b', id: 1, name: 'b1-now' },
    ]);
  });

  it('writes nothing for a row that has left the bridge filter scope', async () => {
    const bridge = makeBridge({
      source: {
        kind: 'table',
        connectionId: 'src',
        table: 'users',
        filters: [{ column: 'active', operator: 'eq', value: true }],
      },
    });
    const h = makeHarness({ bridge, sourceRows: [{ id: 1, active: false }] });
    await h.service.park([letter({ rows: [{ id: 1, active: true }] })]);

    const res = await h.service.retry('b1', { force: false });
    expect(res.resolved).toBe(1);
    expect(h.dbWrites).toEqual([]);
  });

  describe('source row gone, and the bridge does not propagate deletes', () => {
    const bridge = makeBridge({
      trigger: { kind: 'cdc', operations: ['insert', 'update'] },
    });

    it('refuses to guess: the entry waits for an explicit decision', async () => {
      const h = makeHarness({ bridge, sourceRows: [] });
      await h.service.park([letter()]);

      const res = await h.service.retry('b1', { force: false });

      expect(res).toEqual({ resolved: 0, stillFailing: 0, needsForce: 1 });
      expect(h.dbWrites).toEqual([]);
      expect(h.letters[0]).toMatchObject({ status: 'pending', attempts: 0 });
      expect(h.letters[0]!.error).toMatch(/force/);
    });

    it('writes the recording when forced, and never issues a delete', async () => {
      const h = makeHarness({ bridge, sourceRows: [] });
      await h.service.park([letter({ rows: [{ id: 1, name: 'recorded' }] })]);

      const res = await h.service.retry('b1', { force: true });

      expect(res.resolved).toBe(1);
      expect(h.dbWrites).toEqual([
        {
          targets: [targetKey(TARGET)],
          rows: [{ id: 1, name: 'recorded' }],
          op: undefined,
        },
      ]);
    });
  });

  it('a polling (watch) bridge never deletes on a retry', async () => {
    const bridge = makeBridge({
      trigger: {
        kind: 'watch',
        strategy: { strategy: 'increment', column: 'id' },
        pollIntervalMs: 5000,
        startFrom: 'now',
        maxPerPoll: 500,
      },
    });
    const h = makeHarness({ bridge, sourceRows: [] });
    await h.service.park([letter({ op: null })]);
    const res = await h.service.retry('b1', { force: false });
    expect(res.needsForce).toBe(1);
    expect(h.dbWrites).toEqual([]);
  });

  it('keeps an entry that still fails, with the new error and the attempt counted', async () => {
    const h = makeHarness({
      sourceRows: [{ id: 1, name: 'still-bad' }],
      dbOutcome: () => failed('users_copy: violates check constraint'),
    });
    await h.service.park([letter()]);

    const res = await h.service.retry('b1', { force: false });
    expect(res).toEqual({ resolved: 0, stillFailing: 1, needsForce: 0 });
    expect(h.letters[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'users_copy: violates check constraint',
    });
  });

  describe('fan-out', () => {
    const APPEND: DatabaseTarget = {
      ...TARGET,
      table: 'users_log',
      writeMode: 'insert',
      keyColumns: [],
    };
    const bridge = makeBridge({
      destination: { kind: 'database', targets: [TARGET, APPEND] },
    });

    it('a keyed target gets the current row; an append-only target gets the event', async () => {
      const h = makeHarness({ bridge, sourceRows: [{ id: 1, name: 'newer' }] });
      await h.service.park([
        letter({ rows: [{ id: 1, name: 'recorded' }], op: 'update' }),
      ]);

      await h.service.retry('b1', { force: false });

      expect(h.dbWrites).toEqual([
        {
          targets: [targetKey(TARGET)],
          rows: [{ id: 1, name: 'newer' }],
          op: undefined,
        },
        {
          targets: [targetKey(APPEND)],
          rows: [{ id: 1, name: 'recorded' }],
          op: 'update',
        },
      ]);
    });

    it('never rewrites a target that already holds the row', async () => {
      const h = makeHarness({ bridge, sourceRows: [{ id: 1, name: 'newer' }] });
      await h.service.park([letter({ succeededTargets: [targetKey(APPEND)] })]);

      await h.service.retry('b1', { force: false });
      // the append-only log already took this event: appending again duplicates it
      expect(h.dbWrites.map((w) => w.targets)).toEqual([[targetKey(TARGET)]]);
    });

    it('remembers a target that went through when another one fails again', async () => {
      const h = makeHarness({
        bridge,
        sourceRows: [{ id: 1, name: 'newer' }],
        dbOutcome: (targets) =>
          targets[0]!.table === 'users_log'
            ? OK
            : failed('users_copy: still rejected'),
      });
      await h.service.park([letter()]);

      await h.service.retry('b1', { force: false });
      expect(h.letters[0]!.status).toBe('pending');
      expect(JSON.parse(h.letters[0]!.succeededTargetsJson!)).toEqual([
        targetKey(APPEND),
      ]);
    });
  });
});

describe('retry: recordings replayed as they were read', () => {
  it('HTTP destinations get the event itself, with a stable idempotency key', async () => {
    const bridge = makeBridge({
      destination: {
        kind: 'http',
        url: 'https://example.test/hook',
        method: 'POST',
        auth: { type: 'none' },
        idempotency: true,
      },
    });
    const h = makeHarness({ bridge });
    await h.service.park([
      letter({ rows: [{ id: 1 }, { id: 2 }], op: 'insert' }),
    ]);

    const res = await h.service.retry('b1', { force: false });

    expect(res.resolved).toBe(1);
    expect(h.browses).toHaveLength(1); // only the primary-key probe; no refresh
    expect(h.sinkCalls).toHaveLength(1);
    expect(h.sinkCalls[0]).toMatchObject({
      rows: [{ id: 1 }, { id: 2 }],
      op: 'insert',
    });
    expect(h.sinkCalls[0]!.idem).toBe(`j1:dl:${h.letters[0]!.id}`);
  });

  it('a source without a primary key has nothing to re-read by', async () => {
    const h = makeHarness({ primaryKey: [] });
    await h.service.park([
      letter({ rows: [{ name: 'no-key' }], op: 'insert' }),
    ]);

    await h.service.retry('b1', { force: false });
    expect(h.dbWrites).toEqual([]);
    expect(h.sinkCalls[0]).toMatchObject({
      rows: [{ name: 'no-key' }],
      op: 'insert',
    });
  });

  it('a delete image that lacks the key is replayed, not refreshed', async () => {
    const h = makeHarness({});
    await h.service.park([
      letter({ rows: [{ name: 'only-this' }], op: 'delete' }),
    ]);
    await h.service.retry('b1', { force: false });
    expect(h.sinkCalls[0]).toMatchObject({ op: 'delete' });
  });

  it('bytes, dates and bigints reach the destination as the values they were', async () => {
    const h = makeHarness({ primaryKey: [] });
    const at = new Date('2026-09-17T08:00:00.000Z');
    await h.service.park([
      letter({
        rows: [{ blob: Buffer.from('xyz'), at, big: 12n }],
        op: 'insert',
      }),
    ]);

    await h.service.retry('b1', { force: false });
    const row = h.sinkCalls[0]!.rows[0]!;
    expect((row.blob as Buffer).toString()).toBe('xyz');
    expect((row.at as Date).getTime()).toBe(at.getTime());
    expect(row.big).toBe(12n);
  });
});

describe('retry: bookkeeping', () => {
  const delivery = (over: Partial<StoredDelivery> = {}): StoredDelivery => ({
    jobId: 'j1',
    sequence: 5,
    status: 'failed',
    rowIndex: 5,
    rowCount: 2,
    rowKeysJson: '[1,2]',
    httpStatus: null,
    attempts: 1,
    requestBody: '[]',
    durationMs: 3,
    ...over,
  });

  it('turns the delivery green once every row from it has been delivered', async () => {
    const h = makeHarness({
      sourceRows: [{ id: 1 }, { id: 2 }],
      deliveries: [delivery()],
    });
    await h.service.park([
      letter({ rows: [{ id: 1 }] }),
      letter({ rows: [{ id: 2 }] }),
    ]);

    await h.service.retry('b1', { force: false });
    expect(h.recorded).toEqual([
      { jobId: 'j1', sequence: 5, status: 'success' },
    ]);
  });

  it('leaves the delivery red while any of its rows is still waiting', async () => {
    const h = makeHarness({
      sourceRows: [{ id: 1 }, { id: 2 }],
      deliveries: [delivery()],
      dbOutcome: (_t, rows) => (rows[0]!.id === 2 ? failed('nope') : OK),
    });
    await h.service.park([
      letter({ rows: [{ id: 1 }] }),
      letter({ rows: [{ id: 2 }] }),
    ]);

    await h.service.retry('b1', { force: false });
    expect(h.recorded).toEqual([]);
  });

  it('leaves the delivery red when some of its rows were discarded', async () => {
    const h = makeHarness({
      sourceRows: [{ id: 1 }, { id: 2 }],
      deliveries: [delivery()],
    });
    await h.service.park([
      letter({ rows: [{ id: 1 }] }),
      letter({ rows: [{ id: 2 }] }),
    ]);
    await h.service.discard('b1', { ids: [h.letters[1]!.id] });

    await h.service.retry('b1', { force: false });
    // row 2 never arrived: claiming the delivery succeeded would be a lie
    expect(h.recorded).toEqual([]);
  });

  it('retries only the entries asked for, and never discarded or resolved ones', async () => {
    const h = makeHarness({ sourceRows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    await h.service.park([1, 2, 3].map((id) => letter({ rows: [{ id }] })));
    await h.service.discard('b1', { ids: [h.letters[2]!.id] });

    const res = await h.service.retry('b1', {
      ids: [h.letters[0]!.id, h.letters[2]!.id],
      force: false,
    });
    expect(res.resolved).toBe(1);
    expect(h.letters.map((l) => l.status)).toEqual([
      'resolved',
      'pending',
      'discarded',
    ]);
  });

  it('refuses a second retry while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = makeHarness({ sourceRows: [{ id: 1 }] });
    await h.service.park([letter()]);
    // hold the first retry open inside its destination write
    (
      h.service as unknown as {
        databaseSink: { deliver: () => Promise<DeliveryOutcome> };
      }
    ).databaseSink.deliver = async () => {
      await gate;
      return OK;
    };

    const first = h.service.retry('b1', { force: false });
    await new Promise((r) => setTimeout(r, 10));
    await expect(h.service.retry('b1', { force: false })).rejects.toThrow(
      /already running/,
    );
    release();
    await expect(first).resolves.toMatchObject({ resolved: 1 });
    // and the lock is released afterwards
    await expect(
      h.service.retry('b1', { force: false }),
    ).resolves.toBeDefined();
  });

  it('refuses while the source has lost a column the bridge maps: the re-read row would carry NULL for it', async () => {
    const h = makeHarness({ sourceRows: [{ id: 1, name: 'Ada' }] });
    await h.service.park([letter()]);
    h.drift = {
      stop: 'uses a column that is gone: email',
      missingUsed: ['email'],
      drift: null,
    };
    await expect(h.service.retry('b1', { force: false })).rejects.toMatchObject(
      {
        message: 'uses a column that is gone: email',
        details: { reason: 'schema-drift', missingUsed: ['email'] },
      },
    );
    // nothing was read, nothing written, the entry still waits — and the lock is not left held
    expect(h.browses).toEqual([]);
    expect(h.dbWrites).toEqual([]);
    expect(h.letters.map((l) => l.status)).toEqual(['pending']);
    h.drift = { stop: null, missingUsed: [], drift: null };
    await expect(
      h.service.retry('b1', { force: false }),
    ).resolves.toMatchObject({ resolved: 1 });
  });

  it('an unreadable stored payload fails that entry without stopping the rest', async () => {
    const h = makeHarness({ sourceRows: [{ id: 2 }] });
    await h.service.park([
      letter({ rows: [{ id: 1 }] }),
      letter({ rows: [{ id: 2 }] }),
    ]);
    h.letters[0]!.rowsJson = '{not json';

    const res = await h.service.retry('b1', { force: false });
    expect(res).toEqual({ resolved: 1, stillFailing: 1, needsForce: 0 });
    expect(h.letters[0]!.error).toMatch(/cannot be read/);
  });
});

describe('page and discard', () => {
  it('reports what is waiting across the whole bridge, and shows rows safely', async () => {
    const h = makeHarness({});
    await h.service.park([
      letter({ rows: [{ id: 1n, blob: Buffer.alloc(64) }] }),
      letter({ rows: [{ id: 2 }, { id: 3 }] }),
    ]);
    await h.service.discard('b1', { ids: [h.letters[1]!.id] });

    const page = await h.service.page('b1');
    expect(page.pendingEntries).toBe(1);
    expect(page.pendingRows).toBe(1);
    const first = page.items.find((i) => i.status === 'pending')!;
    expect(first.rows).toEqual([{ id: '1', blob: '<64 bytes>' }]);
    expect(first).toMatchObject({ op: 'update', sequence: 5, attempts: 0 });
  });

  it('discard touches pending entries only', async () => {
    const h = makeHarness({ sourceRows: [{ id: 1 }] });
    await h.service.park([
      letter({ rows: [{ id: 1 }] }),
      letter({ rows: [{ id: 9 }] }),
    ]);
    await h.service.retry('b1', { ids: [h.letters[0]!.id], force: false });

    const res = await h.service.discard('b1', {});
    expect(res.discarded).toBe(1);
    expect(h.letters.map((l) => l.status)).toEqual(['resolved', 'discarded']);
  });
});
