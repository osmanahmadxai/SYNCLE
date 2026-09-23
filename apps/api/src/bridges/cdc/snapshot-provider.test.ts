import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@syncle/core';
import type { KeysetCheckpoint, ResolvedBridge } from '../bridges.types';
import type { TableOrder, TableRow } from '../table-reader.service';
import type {
  CdcChange,
  CdcProvider,
  CdcStreamContext,
  CdcStreamHandle,
  CdcStreamHandlers,
} from './cdc-provider';
import {
  HeldChanges,
  SnapshotCdcProvider,
  formatSnapshotCursor,
  isSnapshotCursor,
  parseSnapshotCursor,
  streamCursorOf,
  type SnapshotReader,
} from './snapshot-provider';

/* -------------------------------------------------------------------------- */
/* fakes                                                                      */
/* -------------------------------------------------------------------------- */

const bridge = {
  id: 'b1',
  source: { kind: 'table', connectionId: 'c1', table: 'users' },
  trigger: {
    kind: 'cdc',
    operations: ['insert', 'update', 'delete'],
    startFrom: 'beginning',
  },
  delivery: { pageSize: 2 },
} as unknown as ResolvedBridge;
const conn = { id: 'c1', engine: 'postgres' } as never;

/** everything that happened, in the order it happened */
type Event = string;

interface FakeInner extends CdcProvider {
  /** the handlers the engine's stream was opened with: call them to "make a change" */
  opened: CdcStreamHandlers | null;
  acked: string[];
  stops: number;
}

function fakeInner(
  events: Event[],
  opts: { durable?: boolean; position?: string | null; failOpen?: number } = {},
): FakeInner {
  let failOpen = opts.failOpen ?? 0;
  const inner: FakeInner = {
    engine: 'postgres',
    opened: null,
    acked: [],
    stops: 0,
    readiness: async () => ({}) as never,
    provision: async () => undefined,
    deprovision: async () => undefined,
    cursorAfter: (a, b) => b === null || a > b,
    startStream: async (ctx: CdcStreamContext): Promise<CdcStreamHandle> => {
      if (failOpen > 0) {
        failOpen--;
        events.push('open-failed');
        throw new Error('connection refused');
      }
      events.push(`open(${ctx.fromCursor})`);
      expect(ctx.snapshot).toBeUndefined();
      inner.opened = ctx.handlers;
      return {
        stop: async () => {
          inner.stops++;
        },
        ack: async (cursor) => {
          inner.acked.push(cursor);
        },
      };
    },
  };
  if (opts.durable !== false) {
    inner.capturePosition = async () => {
      events.push('capture');
      return opts.position === undefined ? 'pos-7' : opts.position;
    };
  }
  return inner;
}

function fakeReader(
  events: Event[],
  table: Array<Record<string, unknown>>,
  opts: {
    keyset?: string | null;
    failAt?: Array<number | 'always'>;
    onRow?: (index: number) => Promise<void> | void;
  } = {},
): SnapshotReader & {
  reads: Array<{ startOffset: number; resumeKey: KeysetCheckpoint | null }>;
} {
  const keyset = opts.keyset === undefined ? 'id' : opts.keyset;
  const failAt = [...(opts.failAt ?? [])];
  const reads: Array<{
    startOffset: number;
    resumeKey: KeysetCheckpoint | null;
  }> = [];
  return {
    reads,
    resolveOrder: async (): Promise<TableOrder> => ({
      sort: [{ column: 'id', direction: 'asc' }],
      total: table.length,
      keysetColumn: keyset,
    }),
    async *rows(_bridge, { startOffset, resumeKey }): AsyncGenerator<TableRow> {
      reads.push({ startOffset, resumeKey });
      events.push(`read(${startOffset})`);
      for (let index = startOffset; index < table.length; index++) {
        if (failAt[0] === 'always' || failAt[0] === index) {
          if (failAt[0] !== 'always') failAt.shift();
          throw new Error('server closed the connection');
        }
        await opts.onRow?.(index);
        const row = table[index]!;
        yield {
          row,
          index,
          ...(keyset ? { keyset: { column: keyset, value: row[keyset] } } : {}),
        };
      }
    },
  };
}

function recorder(events: Event[]): CdcStreamHandlers & {
  changes: CdcChange[];
  fatals: string[];
  errors: string[];
} {
  const changes: CdcChange[] = [];
  const fatals: string[] = [];
  const errors: string[] = [];
  return {
    changes,
    fatals,
    errors,
    onChange: async (change) => {
      changes.push(change);
      events.push(`${change.op}:${JSON.stringify(change.row)}`);
    },
    onSkip: async (cursor) => {
      events.push(`skip(${cursor})`);
    },
    onNotice: async (message, cursor) => {
      events.push(`notice:${message}`);
      changes.push({ op: 'insert', row: { $notice: message }, cursor });
    },
    onFatal: async (message) => {
      fatals.push(message);
      events.push('fatal');
    },
    onError: (err) => {
      errors.push(err.message);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 15));
/** for what takes several timer turns (a run of retries): wait for it, not for a guess at how long it takes */
async function until(done: () => boolean, withinMs = 3000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!done() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 5));
}
const noWait = { holdMax: 1000, retryDelayMs: () => 0 };
const USERS = [{ id: 1 }, { id: 2 }, { id: 3 }];

/* -------------------------------------------------------------------------- */

describe('the cursor of a copied row', () => {
  it('round-trips, and is told apart from an engine’s own', () => {
    const cursor = formatSnapshotCursor({
      index: 41,
      key: { column: 'id', value: 'a:b/c' },
      from: '0/16B3748',
      done: false,
    });
    expect(isSnapshotCursor(cursor)).toBe(true);
    expect(parseSnapshotCursor(cursor)).toEqual({
      index: 41,
      key: { column: 'id', value: 'a:b/c' },
      from: '0/16B3748',
      done: false,
    });
    for (const engines of [
      '0/16B3748',
      '{"f":"binlog.000003","p":4}',
      'binlog.000003:4:0:s',
      '',
      null,
      undefined,
    ]) {
      expect(isSnapshotCursor(engines)).toBe(false);
      expect(parseSnapshotCursor(engines)).toBeNull();
    }
  });

  it('carries a key JSON has no form for, and an end marker with no key at all', () => {
    const big = formatSnapshotCursor({
      index: 0,
      key: { column: 'id', value: 9007199254740993n },
      from: null,
      done: false,
    });
    expect(parseSnapshotCursor(big)?.key).toEqual({
      column: 'id',
      value: '9007199254740993',
    });
    const end = formatSnapshotCursor({
      index: 3,
      key: null,
      from: null,
      done: true,
    });
    expect(parseSnapshotCursor(end)).toEqual({
      index: 3,
      key: null,
      from: null,
      done: true,
    });
  });

  it('is not taken for one when it is damaged', () => {
    expect(parseSnapshotCursor('B:x:e30')).toBeNull();
    expect(parseSnapshotCursor('B:-1:e30')).toBeNull();
    expect(parseSnapshotCursor('B:3')).toBeNull();
    expect(parseSnapshotCursor('B:3:%%%')).toBeNull();
  });

  it('yields the engine’s cursor that is inside it: that is the place a copy in progress can lose', () => {
    expect(
      streamCursorOf(
        formatSnapshotCursor({
          index: 5,
          key: null,
          from: 'pos-7',
          done: false,
        }),
      ),
    ).toBe('pos-7');
    expect(
      streamCursorOf(
        formatSnapshotCursor({ index: 5, key: null, from: null, done: true }),
      ),
    ).toBeNull();
    expect(streamCursorOf('0/16B3748')).toBe('0/16B3748');
    expect(streamCursorOf(null)).toBeNull();
    expect(streamCursorOf('B:damaged')).toBeNull();
  });
});

describe('order', () => {
  const provider = new SnapshotCdcProvider(
    fakeInner([]),
    fakeReader([], []),
    noWait,
  );
  const row = (index: number) =>
    formatSnapshotCursor({ index, key: null, from: 'pos-7', done: false });
  const end = formatSnapshotCursor({
    index: 3,
    key: null,
    from: 'pos-7',
    done: true,
  });

  it('copied rows are in the order they were read, the end marker after the last of them', () => {
    expect(provider.cursorAfter(row(0), null)).toBe(true);
    expect(provider.cursorAfter(row(2), row(1))).toBe(true);
    expect(provider.cursorAfter(row(1), row(1))).toBe(false);
    expect(provider.cursorAfter(row(0), row(1))).toBe(false);
    expect(provider.cursorAfter(end, row(2))).toBe(true);
  });

  it('every change comes after the whole copy; a copied row never comes after a change', () => {
    expect(provider.cursorAfter('pos-1', row(2))).toBe(true);
    expect(provider.cursorAfter('pos-1', end)).toBe(true);
    expect(provider.cursorAfter(row(2), 'pos-1')).toBe(false);
    expect(provider.cursorAfter(end, 'pos-9')).toBe(false);
  });

  it('two of the engine’s cursors are the engine’s to compare', () => {
    expect(provider.cursorAfter('pos-8', 'pos-7')).toBe(true);
    expect(provider.cursorAfter('pos-7', 'pos-7')).toBe(false);
  });
});

describe('a bridge that did not ask for a copy', () => {
  it('gets the engine’s stream, from the cursor it has', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events);
    const reader = fakeReader(events, USERS);
    const provider = new SnapshotCdcProvider(inner, reader, noWait);
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: 'pos-3',
      handlers: recorder(events),
    });
    expect(events).toEqual(['open(pos-3)']);
    expect(reader.reads).toEqual([]);

    await handle.ack?.('pos-4');
    // stored by the orchestrator, confirmed by the orchestrator — and nothing the source knows
    await handle.ack?.(
      formatSnapshotCursor({ index: 1, key: null, from: null, done: false }),
    );
    expect(inner.acked).toEqual(['pos-4']);
    await handle.stop();
    expect(inner.stops).toBe(1);
  });

  it('…also with no cursor at all: `snapshot` is what asks, not the absence of a position', async () => {
    const events: Event[] = [];
    const provider = new SnapshotCdcProvider(
      fakeInner(events),
      fakeReader(events, USERS),
      noWait,
    );
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      handlers: recorder(events),
    });
    expect(events).toEqual(['open(null)']);
  });

  it('a copy is not started over a position the bridge already has', async () => {
    const events: Event[] = [];
    const provider = new SnapshotCdcProvider(
      fakeInner(events),
      fakeReader(events, USERS),
      noWait,
    );
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: 'pos-3',
      snapshot: true,
      handlers: recorder(events),
    });
    expect(events).toEqual(['open(pos-3)']);
  });
});

describe('copy, then follow', () => {
  it('takes its place in the log BEFORE the first row is read, and opens the stream there AFTER the last', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events);
    const handlers = recorder(events);
    const provider = new SnapshotCdcProvider(
      inner,
      fakeReader(events, USERS),
      noWait,
    );
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();

    expect(events).toEqual([
      'capture',
      'read(0)',
      'insert:{"id":1}',
      'insert:{"id":2}',
      'insert:{"id":3}',
      'notice:Copied the 3 rows the table already had. Following its changes from the position taken before the copy began.',
      'open(pos-7)',
    ]);
    // each row says how far the copy has got, with what to resume by, and where the stream starts
    expect(handlers.changes.map((c) => parseSnapshotCursor(c.cursor))).toEqual([
      { index: 0, key: { column: 'id', value: 1 }, from: 'pos-7', done: false },
      { index: 1, key: { column: 'id', value: 2 }, from: 'pos-7', done: false },
      { index: 2, key: { column: 'id', value: 3 }, from: 'pos-7', done: false },
      { index: 3, key: null, from: 'pos-7', done: true },
    ]);
  });

  it('says "1 row", and copies an empty table', async () => {
    for (const [table, text] of [
      [[{ id: 1 }], 'Copied the 1 row the table'],
      [[], 'Copied the 0 rows the table'],
    ] as const) {
      const events: Event[] = [];
      const provider = new SnapshotCdcProvider(
        fakeInner(events),
        fakeReader(events, [...table]),
        noWait,
      );
      await provider.startStream({
        bridgeId: 'b1',
        bridge,
        conn,
        fromCursor: null,
        snapshot: true,
        handlers: recorder(events),
      });
      await settle();
      expect(events.find((e) => e.startsWith('notice:'))).toContain(text);
      expect(events.at(-1)).toBe('open(pos-7)');
    }
  });

  it('waits for each row to be taken before reading the next (the orchestrator’s backpressure)', async () => {
    const events: Event[] = [];
    const handlers = recorder(events);
    let release: (() => void) | null = null;
    handlers.onChange = (change) =>
      new Promise<void>((resolve) => {
        events.push(`offered:${JSON.stringify(change.row)}`);
        release = resolve;
      });
    const provider = new SnapshotCdcProvider(
      fakeInner(events),
      fakeReader(events, USERS),
      noWait,
    );
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();
    expect(events.filter((e) => e.startsWith('offered'))).toEqual([
      'offered:{"id":1}',
    ]);
    release!();
    await settle();
    expect(events.filter((e) => e.startsWith('offered'))).toEqual([
      'offered:{"id":1}',
      'offered:{"id":2}',
    ]);
  });

  it('resumes mid-copy from the row it had reached, with the place it took the FIRST time', async () => {
    const events: Event[] = [];
    const reader = fakeReader(events, USERS);
    const handlers = recorder(events);
    const provider = new SnapshotCdcProvider(fakeInner(events), reader, noWait);
    const saved = formatSnapshotCursor({
      index: 0,
      key: { column: 'id', value: 1 },
      from: 'pos-2',
      done: false,
    });
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: saved,
      handlers,
    });
    await settle();

    // no second `capture`: a place taken now would miss what changed since the first
    expect(events).toEqual([
      'read(1)',
      'insert:{"id":2}',
      'insert:{"id":3}',
      'notice:Copied the 3 rows the table already had. Following its changes from the position taken before the copy began.',
      'open(pos-2)',
    ]);
    expect(reader.reads).toEqual([
      { startOffset: 1, resumeKey: { column: 'id', value: 1 } },
    ]);
  });

  it('with the copy done, only opens the stream', async () => {
    const events: Event[] = [];
    const reader = fakeReader(events, USERS);
    const provider = new SnapshotCdcProvider(fakeInner(events), reader, noWait);
    const saved = formatSnapshotCursor({
      index: 3,
      key: null,
      from: 'pos-2',
      done: true,
    });
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: saved,
      handlers: recorder(events),
    });
    expect(events).toEqual(['open(pos-2)']);
    expect(reader.reads).toEqual([]);
    await handle.ack?.(saved);
    await handle.ack?.('pos-3');
  });

  it('where the server holds the place itself (a slot), the stream is opened with no cursor', async () => {
    const events: Event[] = [];
    const provider = new SnapshotCdcProvider(
      fakeInner(events, { position: null }),
      fakeReader(events, USERS),
      noWait,
    );
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers: recorder(events),
    });
    await settle();
    expect(events[0]).toBe('capture');
    expect(events.at(-1)).toBe('open(null)');
  });

  it('refuses a table it cannot page through while the caller is still waiting, having touched nothing', async () => {
    const events: Event[] = [];
    const reader = fakeReader(events, USERS);
    reader.resolveOrder = async () => {
      throw new BadRequestError('Table "users" has no primary key');
    };
    for (const durable of [true, false]) {
      const provider = new SnapshotCdcProvider(
        fakeInner(events, { durable }),
        reader,
        noWait,
      );
      await expect(
        provider.startStream({
          bridgeId: 'b1',
          bridge,
          conn,
          fromCursor: null,
          snapshot: true,
          handlers: recorder(events),
        }),
      ).rejects.toThrow('no primary key');
    }
    expect(events).toEqual([]);
  });

  it('confirms nothing to the source while copying, and the engine’s cursors once it follows', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events);
    const handlers = recorder(events);
    const provider = new SnapshotCdcProvider(
      inner,
      fakeReader(events, USERS),
      noWait,
    );
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await handle.ack?.('pos-early'); // no stream yet: nothing to tell, nothing thrown
    await settle();
    for (const c of handlers.changes) await handle.ack?.(c.cursor);
    await handle.ack?.('pos-8');
    expect(inner.acked).toEqual(['pos-8']);
  });
});

describe('a table that cannot be read for a moment', () => {
  it('is read again from the row it had reached — not from the top', async () => {
    const events: Event[] = [];
    const reader = fakeReader(events, USERS, { failAt: [2] });
    const handlers = recorder(events);
    const provider = new SnapshotCdcProvider(fakeInner(events), reader, noWait);
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();

    expect(events.filter((e) => e.startsWith('insert'))).toEqual([
      'insert:{"id":1}',
      'insert:{"id":2}',
      'insert:{"id":3}',
    ]);
    expect(reader.reads).toEqual([
      { startOffset: 0, resumeKey: null },
      { startOffset: 2, resumeKey: { column: 'id', value: 2 } },
    ]);
    expect(handlers.errors).toEqual([
      'reading the table failed (attempt 1/5): server closed the connection',
    ]);
    expect(handlers.fatals).toEqual([]);
    expect(events.at(-1)).toBe('open(pos-7)');
  });

  it('stops the bridge when it stays unreadable, saying how far it got; the stream is never opened', async () => {
    const events: Event[] = [];
    const handlers = recorder(events);
    const reader = fakeReader(events, USERS, { failAt: [1, 'always'] });
    // the first failure is at row 1; from then on every read fails
    const provider = new SnapshotCdcProvider(fakeInner(events), reader, {
      ...noWait,
      readAttempts: 3,
    });
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();

    expect(handlers.fatals).toEqual([
      'Stopped while copying the table (1 rows copied so far): server closed the connection. Start the bridge again to carry on from there.',
    ]);
    expect(handlers.errors).toHaveLength(2);
    expect(events.some((e) => e.startsWith('open'))).toBe(false);
    expect(events.some((e) => e.startsWith('notice'))).toBe(false);
  });

  it('a failure count is of failures IN A ROW: progress in between starts it again', async () => {
    const events: Event[] = [];
    const handlers = recorder(events);
    const table = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    const reader = fakeReader(events, table, { failAt: [1, 2, 3, 4, 5] });
    const provider = new SnapshotCdcProvider(fakeInner(events), reader, {
      ...noWait,
      readAttempts: 2,
    });
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    // five retries, each a timer turn: a fixed wait was too short on a busy machine
    await until(
      () =>
        events.filter((e) => e.startsWith('insert')).length >= 6 ||
        handlers.fatals.length > 0,
    );
    await settle();
    expect(handlers.fatals).toEqual([]);
    expect(events.filter((e) => e.startsWith('insert'))).toHaveLength(6);
  });

  it('retries opening the stream after the copy, and stops the bridge if it never opens', async () => {
    const events: Event[] = [];
    const ok = new SnapshotCdcProvider(
      fakeInner(events, { failOpen: 2 }),
      fakeReader(events, USERS),
      noWait,
    );
    await ok.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers: recorder(events),
    });
    await settle();
    expect(events.slice(-3)).toEqual([
      'open-failed',
      'open-failed',
      'open(pos-7)',
    ]);

    const later: Event[] = [];
    const handlers = recorder(later);
    const never = new SnapshotCdcProvider(
      fakeInner(later, { failOpen: 99 }),
      fakeReader(later, USERS),
      {
        ...noWait,
        readAttempts: 3,
      },
    );
    await never.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();
    expect(handlers.fatals).toEqual([
      'The table was copied, but its change stream could not be opened: connection refused',
    ]);
  });
});

describe('stopping mid-copy', () => {
  it('hands nothing more over once stop() has returned, and never opens the stream', async () => {
    const events: Event[] = [];
    const handlers = recorder(events);
    let handle: CdcStreamHandle | null = null;
    // (in an object: assigned inside a callback, which the compiler cannot see from here)
    const stop = { done: Promise.resolve() };
    const reader = fakeReader(events, USERS, {
      onRow: (index) => {
        if (index === 1) stop.done = handle!.stop();
      },
    });
    const inner = fakeInner(events);
    const provider = new SnapshotCdcProvider(inner, reader, noWait);
    handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();
    await stop.done;
    const after = events.length;
    await settle();

    expect(events.filter((e) => e.startsWith('insert'))).toEqual([
      'insert:{"id":1}',
    ]);
    expect(
      events.some((e) => e.startsWith('open') || e.startsWith('notice')),
    ).toBe(false);
    expect(events.length).toBe(after);
    expect(handlers.fatals).toEqual([]);
  });
});

describe('an engine with no log to hold a place in', () => {
  const change = (
    key: string,
    value: unknown,
    op: CdcChange['op'] = 'update',
  ): CdcChange => ({
    op,
    row: { id: key, value },
    cursor: `r-${key}-${String(value)}`,
  });

  it('listens FIRST, holds what it hears until the copy is done, then hands it over in order', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events, { durable: false });
    const handlers = recorder(events);
    const reader = fakeReader(events, [{ id: 'a' }, { id: 'b' }], {
      onRow: async (index) => {
        // while the copy is reading: `a` changes twice, `c` appears, `b` is deleted, `a` changes again
        if (index !== 1) return;
        await inner.opened!.onChange(change('a', 1));
        await inner.opened!.onChange(change('c', 1, 'insert'));
        await inner.opened!.onChange(change('b', null, 'delete'));
        await inner.opened!.onChange(change('a', 2));
      },
    });
    const provider = new SnapshotCdcProvider(inner, reader, noWait);
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();

    expect(events).toEqual([
      'open(null)',
      'read(0)',
      'insert:{"id":"a"}',
      'insert:{"id":"b"}',
      'notice:Copied the 2 rows the table already had. Following its changes from the position taken before the copy began.',
      // the newest change per key, in the order things LAST happened: a's first
      // change is superseded, and a=2 happened after b was deleted
      'insert:{"id":"c","value":1}',
      'delete:{"id":"b","value":null}',
      'update:{"id":"a","value":2}',
    ]);

    // from here on nothing is held
    await inner.opened!.onChange(change('d', 9, 'insert'));
    expect(events.at(-1)).toBe('insert:{"id":"d","value":9}');
  });

  it('a change that arrives WHILE the held ones are handed over goes behind them', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events, { durable: false });
    const handlers = recorder(events);
    const taken: string[] = [];
    handlers.onChange = async (c) => {
      taken.push(`${c.op}:${String(c.row.id)}`);
      // the orchestrator is busy with the first held change when another arrives
      if (c.row.id === 'x')
        await inner.opened!.onChange(change('z', 1, 'insert'));
    };
    const reader = fakeReader(events, [{ id: 'a' }], {
      onRow: async () => {
        await inner.opened!.onChange(change('x', 1));
        await inner.opened!.onChange(change('y', 1));
      },
    });
    const provider = new SnapshotCdcProvider(inner, reader, noWait);
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();
    expect(taken).toEqual(['insert:a', 'update:x', 'update:y', 'insert:z']);
  });

  it('stops the bridge — once — rather than hold without limit', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events, { durable: false });
    const handlers = recorder(events);
    const reader = fakeReader(events, [{ id: 'a' }, { id: 'b' }], {
      onRow: async (index) => {
        if (index !== 0) return;
        for (let i = 0; i < 5; i++)
          await inner.opened!.onChange(change(`k${i}`, i));
      },
    });
    const provider = new SnapshotCdcProvider(inner, reader, {
      ...noWait,
      holdMax: 3,
    });
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();
    expect(handlers.fatals).toHaveLength(1);
    expect(handlers.fatals[0]).toContain('More than 3 different rows changed');
    expect(handlers.fatals[0]).toContain('SYNCLE_SNAPSHOT_HOLD_MAX');
    // and nothing of the held changes is delivered as if the copy had finished
    expect(
      events.some((e) => e.startsWith('notice') || e.startsWith('update')),
    ).toBe(false);
  });

  it('many changes to FEW keys are not many: only the newest per key is held', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events, { durable: false });
    const handlers = recorder(events);
    const reader = fakeReader(events, [{ id: 'a' }], {
      onRow: async () => {
        for (let i = 0; i < 500; i++)
          await inner.opened!.onChange(change(i % 2 ? 'hot' : 'warm', i));
      },
    });
    const provider = new SnapshotCdcProvider(inner, reader, {
      ...noWait,
      holdMax: 3,
    });
    await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers,
    });
    await settle();
    expect(handlers.fatals).toEqual([]);
    expect(events.slice(-2)).toEqual([
      'update:{"id":"warm","value":498}',
      'update:{"id":"hot","value":499}',
    ]);
  });

  it('stop() closes the stream it opened first', async () => {
    const events: Event[] = [];
    const inner = fakeInner(events, { durable: false });
    const provider = new SnapshotCdcProvider(
      inner,
      fakeReader(events, USERS),
      noWait,
    );
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: null,
      snapshot: true,
      handlers: recorder(events),
    });
    await handle.stop();
    expect(inner.stops).toBeGreaterThan(0);
  });
});

describe('HeldChanges', () => {
  it('keeps changes with no key apart, in arrival order', () => {
    const held = new HeldChanges('id');
    held.add({ op: 'insert', row: { other: 1 }, cursor: 'a' });
    held.add({ op: 'insert', row: { id: null }, cursor: 'b' });
    held.add({ op: 'insert', row: { other: 1 }, cursor: 'c' });
    expect(held.size).toBe(3);
    expect([
      held.shift()?.cursor,
      held.shift()?.cursor,
      held.shift()?.cursor,
      held.shift(),
    ]).toEqual(['a', 'b', 'c', undefined]);
  });

  it('with no key column, holds everything as it came', () => {
    const held = new HeldChanges(null);
    held.add({ op: 'update', row: { id: 1 }, cursor: 'a' });
    held.add({ op: 'update', row: { id: 1 }, cursor: 'b' });
    expect(held.size).toBe(2);
  });

  it('tells 1 from "1": they are different keys', () => {
    const held = new HeldChanges('id');
    held.add({ op: 'update', row: { id: 1 }, cursor: 'a' });
    held.add({ op: 'update', row: { id: '1' }, cursor: 'b' });
    expect(held.size).toBe(2);
  });
});

describe('what the rest of the orchestrator sees', () => {
  it('the engine’s capabilities, unchanged', () => {
    const inner = fakeInner([]);
    Object.assign(inner, {
      handlesSourceFilters: true,
      capturesTruncate: true,
    });
    const provider = new SnapshotCdcProvider(inner, fakeReader([], []), noWait);
    expect(provider.engine).toBe('postgres');
    expect(provider.handlesSourceFilters).toBe(true);
    expect(provider.capturesTruncate).toBe(true);
  });

  it('inspects the place the STREAM holds, also while the saved position is the copy’s', async () => {
    const asked: Array<string | null> = [];
    const inner = fakeInner([]);
    inner.inspect = async (_id, _bridge, _conn, cursor) => {
      asked.push(cursor);
      return null;
    };
    const provider = new SnapshotCdcProvider(inner, fakeReader([], []), noWait);
    await provider.inspect(
      'b1',
      bridge,
      conn,
      formatSnapshotCursor({ index: 9, key: null, from: 'pos-7', done: false }),
    );
    await provider.inspect('b1', bridge, conn, 'pos-9');
    await provider.inspect('b1', bridge, conn, null);
    expect(asked).toEqual(['pos-7', 'pos-9', null]);

    const none = new SnapshotCdcProvider(
      fakeInner([]),
      fakeReader([], []),
      noWait,
    );
    expect(await none.inspect('b1', bridge, conn, 'pos-9')).toBeNull();
  });
});
