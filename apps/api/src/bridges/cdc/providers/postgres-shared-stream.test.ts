/**
 * the shared change stream, with the replication client replaced by one the
 * test drives by hand: what each member is handed, in what order, how often —
 * and what the SERVER is told it may forget, which is the part that loses data
 * when it is wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdcChange } from '../cdc-provider';
import { PgSharedSlotService } from './postgres-shared-slot';

type Listener = (...args: never[]) => unknown;

/**
 * (hoisted: the mock below is set up before anything in this file runs, and it
 * needs the class. hence also no EventEmitter — nothing is imported yet there)
 */
const { FakeReader, readers } = vi.hoisted(() => {
  /** every reader the code under test has opened, oldest first */
  const readers: InstanceType<typeof FakeReader>[] = [];
  class FakeReader {
    acknowledged: string[] = [];
    stopped = false;
    // the real client's flow-control internals: data received and not yet handed over
    _messageQueue: unknown[] = [];
    _processing = false;
    private release: (() => void) | null = null;
    private readonly handlers = new Map<string, Listener[]>();
    constructor() {
      readers.push(this);
    }
    on(event: string, listener: Listener): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.handlers.get(event) ?? [])
        (listener as (...a: unknown[]) => unknown)(...args);
    }
    subscribe(): Promise<void> {
      return new Promise((resolve) => (this.release = resolve));
    }
    async stop(): Promise<void> {
      this.stopped = true;
      this.release?.();
    }
    async acknowledge(lsn: string): Promise<boolean> {
      this.acknowledged.push(lsn);
      return true;
    }
    /** one message, handled to the end before the next — as flow control does it */
    async send(lsn: string, msg: Record<string, unknown>): Promise<void> {
      for (const listener of this.handlers.get('data') ?? [])
        await (listener as (l: string, m: unknown) => Promise<void>)(lsn, msg);
    }
    /** a whole transaction of single-row inserts */
    async txn(
      commit: string,
      end: string,
      rows: Array<{ table: string; lsn: string; id: number }>,
    ): Promise<void> {
      await this.send(commit, { tag: 'begin', commitLsn: commit });
      for (const r of rows)
        await this.send(r.lsn, {
          tag: 'insert',
          relation: { schema: 'public', name: r.table, keyColumns: ['id'] },
          new: { id: r.id },
        });
      await this.send(end, {
        tag: 'commit',
        commitLsn: commit,
        commitEndLsn: end,
      });
    }
  }
  return { FakeReader, readers };
});

vi.mock('pg-logical-replication', () => ({
  LogicalReplicationService: FakeReader,
  PgoutputPlugin: class {},
}));

function rig(positions: Record<string, string>) {
  const rows = new Map(
    Object.entries(positions).map(([bridgeId, confirmedLsn]) => [
      bridgeId,
      { bridgeId, confirmedLsn },
    ]),
  );
  const prisma = {
    cdcSharedMember: {
      findUnique: async ({ where }: { where: { bridgeId: string } }) =>
        rows.get(where.bridgeId) ?? null,
      findMany: async () => [...rows.values()],
      updateMany: async ({
        where,
        data,
      }: {
        where: { bridgeId: string };
        data: { confirmedLsn: string };
      }) => {
        const row = rows.get(where.bridgeId);
        if (row) row.confirmedLsn = data.confirmedLsn;
      },
    },
  };
  const service = new PgSharedSlotService(prisma as never, {} as never);
  const got: Record<string, string[]> = {};
  const open = async (
    bridgeId: string,
    table: string,
    fromCursor: string | null = null,
    /** what the member's bridge writes to, and the primary key its orchestrator found */
    to: {
      keyColumns?: string[];
      http?: boolean;
      primaryKey?: string[] | null;
    } = {},
  ) => {
    got[bridgeId] = [];
    const handle = await service.open(
      {
        bridgeId,
        bridge: {
          id: bridgeId,
          source: { kind: 'table', connectionId: 'c1', table },
          trigger: {
            kind: 'cdc',
            operations: ['insert', 'update', 'delete'],
            startFrom: 'now',
            slot: 'shared',
          },
          destination: to.http
            ? { kind: 'http', url: 'https://example.test' }
            : {
                kind: 'database',
                targets: [
                  {
                    connectionId: 'd',
                    table: `${table}_copy`,
                    keyColumns: to.keyColumns ?? ['id'],
                    mapping: [],
                  },
                ],
              },
        } as never,
        conn: {} as never,
        fromCursor,
        primaryKey: to.primaryKey === undefined ? ['id'] : to.primaryKey,
        handlers: {
          onChange: async (c: CdcChange) =>
            void got[bridgeId]!.push(
              `${c.op}:${String(c.row.id)}${c.keyChanged ? ':moved' : ''}`,
            ),
          onSkip: async (cursor: string) =>
            void got[bridgeId]!.push(`skip:${cursor}`),
          onError: () => undefined,
        },
      },
      () => ({}),
    );
    return handle;
  };
  return { open, got, rows };
}

const settle = () => new Promise((r) => setTimeout(r, 160)); // past the restart's 100 ms

beforeEach(() => {
  readers.length = 0;
});

describe('who is handed what', () => {
  it('a change goes to the members whose table it is; the end of a transaction goes to everybody', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    await r.open('a', 'orders');
    await r.open('b', 'customers');
    await settle();
    expect(readers).toHaveLength(1); // two members resuming together are ONE reader
    await readers[0]!.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
      { table: 'customers', lsn: '0/1B0', id: 2 },
      { table: 'somebody_elses', lsn: '0/1C0', id: 3 },
    ]);
    expect(r.got.a).toEqual(['insert:1', 'skip:0/200#c:0/210']);
    expect(r.got.b).toEqual(['insert:2', 'skip:0/200#c:0/210']);
  });

  it('a transaction the server sends again is dropped by the members that have had it — each by its own watermark', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    await r.open('a', 'orders');
    await settle();
    await readers[0]!.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
      { table: 'customers', lsn: '0/1B0', id: 2 },
    ]);
    expect(r.got.a).toEqual(['insert:1', 'skip:0/200#c:0/210']);

    // `b` starts: the stream is read again from further back, and sends that transaction a second time
    await r.open('b', 'customers');
    await settle();
    expect(readers).toHaveLength(2);
    expect(readers[0]!.stopped).toBe(true);
    await readers[1]!.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
      { table: 'customers', lsn: '0/1B0', id: 2 },
    ]);
    expect(r.got.a).toEqual(['insert:1', 'skip:0/200#c:0/210']); // nothing twice
    expect(r.got.b).toEqual(['insert:2', 'skip:0/200#c:0/210']);
  });

  it('a member that joins is served ONLY by a reader started after it joined', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    await r.open('a', 'orders');
    await settle();
    const old = readers[0]!;
    await old.txn('0/200', '0/210', [{ table: 'orders', lsn: '0/1A0', id: 1 }]);

    // `b` needs everything after 0/100. the reader that is running is already
    // past 0/210, and hands out one more transaction while `b` is joining
    const joining = r.open('b', 'customers');
    await old.txn('0/300', '0/310', [
      { table: 'customers', lsn: '0/2A0', id: 9 },
    ]);
    await joining;
    // had `b` taken that, its watermark would be 0/300 — and transaction 0/200's
    // change to its table, sent by the new reader, would be dropped as a duplicate
    expect(r.got.b).toEqual([]);
    await settle();
    await readers[1]!.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
      { table: 'customers', lsn: '0/1B0', id: 8 },
    ]);
    await readers[1]!.txn('0/300', '0/310', [
      { table: 'customers', lsn: '0/2A0', id: 9 },
    ]);
    expect(r.got.b).toEqual([
      'insert:8',
      'skip:0/200#c:0/210',
      'insert:9',
      'skip:0/300#c:0/310',
    ]);
  });

  it('a saved cursor in the middle of a transaction: the rest of it arrives, the part that was had does not', async () => {
    const r = rig({ a: '0/100' });
    await r.open('a', 'orders', '0/200#0/1A0.0');
    await settle();
    await readers[0]!.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
      { table: 'orders', lsn: '0/1B0', id: 2 },
    ]);
    expect(r.got.a).toEqual(['insert:2', 'skip:0/200#c:0/210']);
  });

  it('rows that share one WAL position (a COPY) are told apart by their place in it', async () => {
    const r = rig({ a: '0/100' });
    await r.open('a', 'orders');
    await settle();
    await readers[0]!.txn(
      '0/200',
      '0/210',
      [1, 2, 3].map((id) => ({ table: 'orders', lsn: '0/1A0', id })),
    );
    expect(r.got.a).toEqual([
      'insert:1',
      'insert:2',
      'insert:3',
      'skip:0/200#c:0/210',
    ]);
  });
});

describe('a table that sends whole rows (REPLICA IDENTITY FULL), read by members keyed differently', () => {
  // PostgreSQL marks EVERY column of such a table as an identity column
  const relation = {
    schema: 'public',
    name: 'users',
    keyColumns: ['id', 'email', 'name'],
  };
  const row = { id: 1, email: 'a@example.test', name: 'a' };
  const update = (now: Record<string, unknown>) => ({
    tag: 'update',
    relation,
    old: row,
    new: now,
  });

  it('an ordinary UPDATE is an update for everybody; a move is a move only for the member whose key moved', async () => {
    const r = rig({ byId: '0/100', byEmail: '0/100', hook: '0/100' });
    await r.open('byId', 'users');
    await r.open('byEmail', 'users', null, { keyColumns: ['email'] });
    await r.open('hook', 'users', null, { http: true });
    await settle();
    const reader = readers[0]!;

    await reader.send('0/200', { tag: 'begin', commitLsn: '0/200' });
    await reader.send('0/1A0', update({ ...row, name: 'b' }));
    expect(r.got.byId).toEqual(['update:1']);
    expect(r.got.byEmail).toEqual(['update:1']);
    expect(r.got.hook).toEqual(['update:1']);

    await reader.send('0/1B0', update({ ...row, email: 'b@example.test' }));
    expect(r.got.byId).toEqual(['update:1', 'update:1']);
    expect(r.got.byEmail).toEqual(['update:1', 'delete:1', 'update:1:moved']);
    expect(r.got.hook).toEqual(['update:1', 'update:1']);
  });

  it('a member that was NOT handed the old row is not left waiting for it', async () => {
    const r = rig({ byId: '0/100', byEmail: '0/100' });
    await r.open('byId', 'users');
    await r.open('byEmail', 'users', null, { keyColumns: ['email'] });
    await settle();
    const reader = readers[0]!;
    await reader.send('0/200', { tag: 'begin', commitLsn: '0/200' });
    await reader.send('0/1B0', update({ ...row, email: 'b@example.test' }));
    await reader.send('0/1C0', { tag: 'insert', relation, new: { id: 2 } });
    // byId was handed no delete, and still takes the insert that follows: the
    // position it skipped is not one it is waiting for
    expect(r.got.byId).toEqual(['update:1', 'insert:2']);
    expect(r.got.byEmail).toEqual(['delete:1', 'update:1:moved', 'insert:2']);
  });
});

describe('what the server is told it may forget', () => {
  it('never more than the SLOWEST member has confirmed — a member that is not running included', async () => {
    // `paused` is a member of the slot and is not started here
    const r = rig({ a: '0/100', b: '0/100', paused: '0/150' });
    const a = await r.open('a', 'orders');
    const b = await r.open('b', 'customers');
    await settle();
    const reader = readers[0]!;
    await reader.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
    ]);

    await a.ack!('0/200#c:0/210');
    // `b` has confirmed nothing yet: the server is told 0/100 (sent as 0/FF: the client adds one)
    expect(reader.acknowledged.at(-1)).toBe('0/FF');
    await b.ack!('0/200#c:0/210');
    // both are at 0/210 now, and `paused` still needs everything after 0/150
    expect(reader.acknowledged.at(-1)).toBe('0/14F');
    // a position INSIDE a transaction confirms nothing
    const before = reader.acknowledged.length;
    await a.ack!('0/300#0/2A0.0');
    expect(reader.acknowledged).toHaveLength(before);
  });

  it('a member that stops keeps holding the slot where it stopped; its position outlives it', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    const a = await r.open('a', 'orders');
    const b = await r.open('b', 'customers');
    await settle();
    await readers[0]!.txn('0/200', '0/210', []);
    await a.ack!('0/200#c:0/210');
    await b.ack!('0/200#c:0/210');
    await a.stop();
    expect(r.rows.get('a')!.confirmedLsn).toBe('0/210');

    await readers[0]!.txn('0/300', '0/310', []);
    await b.ack!('0/300#c:0/310');
    // `b` is at 0/310; `a`, stopped, is at 0/210 — and that is all the server hears
    expect(readers[0]!.acknowledged.at(-1)).toBe('0/20F');
  });

  it('the last member to stop ends the reader', async () => {
    const r = rig({ a: '0/100' });
    const a = await r.open('a', 'orders');
    await settle();
    await a.stop();
    expect(readers[0]!.stopped).toBe(true);
  });
});

describe('quiet tables in a busy database', () => {
  // PostgreSQL 15+ sends nothing for transactions that touch nothing published:
  // members on quiet tables see keepalives only, and would hold the slot — and
  // all the WAL the rest of the database writes — where their last change left it
  const beat = (
    reader: (typeof readers)[number],
    lsn: string,
    shouldRespond = true,
  ) => reader.emit('heartbeat', lsn, Date.now(), shouldRespond);

  it('running members with nothing in flight move to the position the keepalive reports', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    await r.open('a', 'orders');
    await r.open('b', 'customers');
    await settle();
    beat(readers[0]!, '0/9000');
    expect(readers[0]!.acknowledged.at(-1)).toBe('0/8FFF');
    // …and that is kept, for the day they are not running
    await new Promise((res) => setTimeout(res, 20));
    expect(r.rows.get('a')!.confirmedLsn).toBe('0/9000');
  });

  it('a member that is NOT running holds the slot where it stopped, however idle the others are', async () => {
    const r = rig({ a: '0/100', paused: '0/150' });
    await r.open('a', 'orders');
    await settle();
    beat(readers[0]!, '0/9000');
    expect(readers[0]!.acknowledged.at(-1)).toBe('0/14F');
    expect(r.rows.get('paused')!.confirmedLsn).toBe('0/150');
  });

  it('a member with a change it has not confirmed holds it too — until it has', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    const a = await r.open('a', 'orders');
    const b = await r.open('b', 'customers');
    await settle();
    const reader = readers[0]!;
    await reader.txn('0/200', '0/210', [
      { table: 'orders', lsn: '0/1A0', id: 1 },
    ]);
    await b.ack!('0/200#c:0/210'); // `b` has passed the transaction; `a` still has its row in hand
    beat(reader, '0/9000');
    expect(reader.acknowledged.at(-1)).toBe('0/FF');
    await a.ack!('0/200#c:0/210');
    beat(reader, '0/9000');
    expect(reader.acknowledged.at(-1)).toBe('0/8FFF');
  });

  it('not in the middle of a transaction, and not while the client still has data to hand over', async () => {
    const r = rig({ a: '0/100' });
    await r.open('a', 'orders');
    await settle();
    const reader = readers[0]!;
    await reader.send('0/200', { tag: 'begin', commitLsn: '0/200' });
    beat(reader, '0/9000');
    expect(reader.acknowledged.at(-1)).toBe('0/FF');
    await reader.send('0/210', {
      tag: 'commit',
      commitLsn: '0/200',
      commitEndLsn: '0/210',
    });
    reader._messageQueue = [{ lsn: '0/300' }];
    beat(reader, '0/9000');
    expect(reader.acknowledged.at(-1)).toBe('0/FF');
  });

  it('a member that joined after the reader began is not moved by it: nothing has been read for it yet', async () => {
    const r = rig({ a: '0/100', b: '0/100' });
    await r.open('a', 'orders');
    await settle();
    const old = readers[0]!;
    const joining = r.open('b', 'customers');
    beat(old, '0/9000'); // from the reader that `b` is not served by
    await joining;
    expect(r.rows.get('b')!.confirmedLsn).toBe('0/100');
  });
});
