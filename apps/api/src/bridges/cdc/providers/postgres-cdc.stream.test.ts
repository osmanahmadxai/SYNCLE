/**
 * The Postgres stream's acknowledgement rule, with the replication client
 * replaced by a double.
 *
 * The slot's confirmed LSN is the one thing Postgres will not give back: once
 * it moves, everything before it is gone for good. So the provider may confirm
 * a position only when told to, by an orchestrator that has made the changes
 * before it durable — never on its own initiative, and in particular never for
 * a BEGIN/COMMIT, whose own transaction's rows are usually still buffered.
 */
import { UNCHANGED } from '@syncle/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresCdcProvider } from './postgres-cdc.provider';

type Listener = (...args: unknown[]) => unknown;

// vi.mock is hoisted above the imports, so everything its factory touches has
// to be hoisted with it
const fake = vi.hoisted(() => {
  const state = {
    /** what the replication client was asked to confirm */
    acknowledged: [] as string[],
    client: null as null | {
      listeners(event: string): Listener[];
      emit(event: string, ...args: unknown[]): void;
    },
  };
  class FakeService {
    private readonly handlers = new Map<string, Listener[]>();
    constructor() {
      state.client = this;
    }
    on(event: string, fn: Listener): this {
      this.handlers.set(event, [...this.listeners(event), fn]);
      return this;
    }
    listeners(event: string): Listener[] {
      return this.handlers.get(event) ?? [];
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners(event)) fn(...args);
    }
    subscribe(): Promise<void> {
      return new Promise(() => undefined); // a live stream never resolves
    }
    async acknowledge(lsn: string): Promise<boolean> {
      state.acknowledged.push(lsn);
      return true;
    }
    async stop(): Promise<void> {}
  }
  return { state, FakeService };
});

vi.mock('pg-logical-replication', () => ({
  LogicalReplicationService: fake.FakeService,
  PgoutputPlugin: class {},
}));

const acknowledged = fake.state.acknowledged;

/** deliver one decoded message the way the library does, and wait for its handler */
async function emit(lsn: string, msg: Record<string, unknown>): Promise<void> {
  const [handler] = fake.state.client!.listeners('data');
  await handler!(lsn, msg);
}

const bridgeWith = (operations: string[]) =>
  ({
    id: 'b1',
    source: { kind: 'table', connectionId: 'c', table: 'users' },
    trigger: { kind: 'cdc', operations },
  }) as never;
const conn = { engine: 'postgres', host: 'h', port: 5432 } as never;
const relation = { name: 'users', schema: 'public', keyColumns: ['id'] };

/** a transaction's frame: BEGIN announces where it commits, COMMIT where it ends */
const begin = (commitLsn: string) => ({ tag: 'begin', commitLsn });
const commit = (commitLsn: string, commitEndLsn: string) => ({
  tag: 'commit',
  commitLsn,
  commitEndLsn,
});

async function start(
  handlers: {
    onChange?: (c: unknown) => Promise<void>;
    onSkip?: (cursor: string) => Promise<void>;
    onNotice?: (message: string, cursor: string) => Promise<void>;
  },
  opts: { operations?: string[]; fromCursor?: string | null } = {},
) {
  // no pool: the slot's own position cannot be looked up, which is best-effort
  const provider = new PostgresCdcProvider({} as never);
  const handle = await provider.startStream({
    bridgeId: 'b1',
    bridge: bridgeWith(opts.operations ?? ['insert', 'update']),
    conn,
    fromCursor: opts.fromCursor ?? null,
    handlers: {
      onChange: handlers.onChange ?? (async () => undefined),
      onSkip: handlers.onSkip,
      onNotice: handlers.onNotice,
      onError: () => undefined,
    },
  });
  await vi.waitFor(() => expect(fake.state.client).not.toBeNull());
  return handle;
}

beforeEach(() => {
  acknowledged.length = 0;
  fake.state.client = null;
});

describe('postgres stream acknowledgements', () => {
  it('never confirms a transaction by itself', async () => {
    const skipped: string[] = [];
    const changes: Array<{ cursor: string }> = [];
    const handle = await start({
      onChange: async (c) => void changes.push(c as { cursor: string }),
      onSkip: async (c) => void skipped.push(c),
    });

    await emit('0/10', begin('0/30'));
    await emit('0/20', { tag: 'insert', relation, new: { id: 1 } });
    await emit('0/60', commit('0/30', '0/60'));

    // the row has only been handed over, not delivered: confirming the COMMIT
    // here is exactly what used to strand it
    expect(acknowledged).toEqual([]);
    expect(changes.map((c) => c.cursor)).toEqual(['0/30#0/20.0']);
    // BEGIN is not a position. the end of the transaction is, and says what may
    // be confirmed once it has been reached
    expect(skipped).toEqual(['0/30#c:0/60']);
    await handle.stop();
  });

  it('hands every undelivered CHANGE to the orchestrator; a description of one is not a position', async () => {
    const skipped: string[] = [];
    const changes: unknown[] = [];
    const handle = await start({
      onChange: async (c) => void changes.push(c),
      onSkip: async (c) => void skipped.push(c),
    });

    await emit('0/1', begin('0/90'));
    // relation/type/origin/message are tagged with the NEXT change's position:
    // passing one would be passing that change
    await emit('0/2', { tag: 'relation' });
    await emit('0/2', { tag: 'type' });
    await emit('0/2', { tag: 'delete', relation, old: { id: 1 } }); // operation not enabled
    await emit('0/3', {
      tag: 'insert',
      relation: { name: 'other', schema: 'public' },
      new: {},
    });
    await emit('0/4', {
      tag: 'insert',
      relation: { name: 'users', schema: 'audit' },
      new: {},
    });
    await emit('0/5', {
      tag: 'truncate',
      relations: [{ name: 'other', schema: 'public' }],
    });
    await emit('0/6', { tag: 'update', relation, new: { id: 1 } });

    expect(skipped).toEqual([
      '0/90#0/2.0',
      '0/90#0/3.0',
      '0/90#0/4.0',
      '0/90#0/5.0',
    ]);
    expect(changes).toEqual([
      { op: 'update', row: { id: 1 }, cursor: '0/90#0/6.0' },
    ]);
    expect(acknowledged).toEqual([]);
    await handle.stop();
  });

  it('waits for the orchestrator before reading on (backpressure covers skips too)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = await start({ onSkip: () => gate });

    let done = false;
    const pending = emit('0/10', commit('0/8', '0/10')).then(
      () => (done = true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await pending;
    expect(done).toBe(true);
    await handle.stop();
  });

  it('confirms the END of a transaction, and exactly that', async () => {
    const handle = await start({ onSkip: async () => undefined });
    await emit('0/60', commit('0/30', '0/60'));
    expect(acknowledged).toEqual([]);

    await handle.ack!('0/30#c:0/60');
    // the client sends "lsn + 1". 0/5F + 1 = 0/60, the end itself. confirming
    // 0/61 reaches into whatever starts at 0/60 — the next commit, at worst
    expect(acknowledged).toEqual(['0/5F']);
    await handle.stop();
  });

  it('a position INSIDE a transaction confirms nothing', async () => {
    const handle = await start({ onSkip: async () => undefined });
    await handle.ack!('0/30#0/20.0');
    await handle.ack!('0/30#0/28.3');
    // the server can only forget whole transactions. after a restart it sends
    // this one again from the top and the watermark drops what was delivered
    expect(acknowledged).toEqual([]);
    await handle.stop();
  });

  it('still confirms a cursor saved before transactions were tracked', async () => {
    const handle = await start({ onSkip: async () => undefined });
    await handle.ack!('0/40');
    expect(acknowledged).toEqual(['0/3F']);
    await handle.stop();
  });

  it('answers keepalives with the last CONFIRMED position, never a skipped one', async () => {
    const handle = await start({ onSkip: async () => undefined });
    await emit('0/50', commit('0/48', '0/50'));

    fake.state.client!.emit('heartbeat', '0/60', Date.now(), true);
    expect(acknowledged).toEqual([]); // nothing confirmed yet, so nothing to repeat

    await handle.ack!('0/38#c:0/40');
    fake.state.client!.emit('heartbeat', '0/60', Date.now(), true);
    expect(acknowledged).toEqual(['0/3F', '0/3F']);
    // a keepalive that does not ask for an answer does not get one
    fake.state.client!.emit('heartbeat', '0/60', Date.now(), false);
    expect(acknowledged).toEqual(['0/3F', '0/3F']);
    await handle.stop();
  });

  it('resumes answering from the saved cursor', async () => {
    const handle = await start({}, { fromCursor: '0/38#c:0/40' });
    fake.state.client!.emit('heartbeat', '0/60', Date.now(), true);
    expect(acknowledged).toEqual(['0/3F']);
    await handle.stop();
  });

  it('a cursor saved mid-transaction has nothing to answer with', async () => {
    const handle = await start({}, { fromCursor: '0/38#0/20.0' });
    fake.state.client!.emit('heartbeat', '0/60', Date.now(), true);
    expect(acknowledged).toEqual([]);
    await handle.stop();
  });

  it('an orchestrator that does not take skips leaves the slot where it is', async () => {
    const handle = await start({});
    await emit('0/10', commit('0/8', '0/10'));
    // holding WAL a little longer is recoverable; confirming too far is not
    expect(acknowledged).toEqual([]);
    await handle.stop();
  });
});

describe('postgres stream positions', () => {
  it('gives rows that share a WAL record (COPY) a position each', async () => {
    const cursors: string[] = [];
    const handle = await start({
      onChange: async (c) =>
        void cursors.push((c as { cursor: string }).cursor),
    });

    await emit('0/10', begin('0/90'));
    for (const id of [1, 2, 3])
      await emit('0/20', { tag: 'insert', relation, new: { id } });
    await emit('0/40', { tag: 'insert', relation, new: { id: 4 } });
    await emit('0/40', { tag: 'insert', relation, new: { id: 5 } });

    expect(cursors).toEqual([
      '0/90#0/20.0',
      '0/90#0/20.1',
      '0/90#0/20.2',
      '0/90#0/40.0',
      '0/90#0/40.1',
    ]);
    await handle.stop();
  });

  it('counts a skipped row in the same record too, so a re-sent transaction lines up', async () => {
    const seen: string[] = [];
    const handle = await start({
      onChange: async (c) => void seen.push((c as { cursor: string }).cursor),
      onSkip: async (c) => void seen.push(`skip ${c}`),
    });
    await emit('0/10', begin('0/90'));
    await emit('0/20', {
      tag: 'insert',
      relation: { name: 'other', schema: 'public' },
      new: {},
    });
    await emit('0/20', { tag: 'insert', relation, new: { id: 1 } });
    expect(seen).toEqual(['skip 0/90#0/20.0', '0/90#0/20.1']);
    await handle.stop();
  });

  it('starts each transaction from its own BEGIN, in the form Postgres prints', async () => {
    const cursors: string[] = [];
    const handle = await start({
      onChange: async (c) =>
        void cursors.push((c as { cursor: string }).cursor),
      onSkip: async (c) => void cursors.push(c),
    });
    // the protocol messages zero-pad; the stream's own LSNs do not
    await emit('1/BD940500', begin('00000001/BD940508'));
    await emit('1/BD940500', { tag: 'insert', relation, new: { id: 1 } });
    await emit('1/BD940538', commit('00000001/BD940508', '00000001/BD940538'));
    await emit('1/BD940400', begin('00000001/BD940538'));
    await emit('1/BD940400', { tag: 'insert', relation, new: { id: 2 } });

    expect(cursors).toEqual([
      '1/BD940508#1/BD940500.0',
      '1/BD940508#c:1/BD940538',
      // written EARLIER in the WAL than the row above, committed later
      '1/BD940538#1/BD940400.0',
    ]);
    await handle.stop();
  });

  it('a reconnect forgets the half-read transaction', async () => {
    const cursors: string[] = [];
    const handle = await start({
      onChange: async (c) =>
        void cursors.push((c as { cursor: string }).cursor),
    });
    await emit('0/10', begin('0/90'));
    await emit('0/20', { tag: 'insert', relation, new: { id: 1 } });
    await emit('0/20', { tag: 'insert', relation, new: { id: 2 } });
    // the server sends the transaction again from its BEGIN
    await emit('0/10', begin('0/90'));
    await emit('0/20', { tag: 'insert', relation, new: { id: 1 } });
    expect(cursors).toEqual(['0/90#0/20.0', '0/90#0/20.1', '0/90#0/20.0']);
    await handle.stop();
  });
});

describe('postgres stream changes', () => {
  it('marks a column the message left out as UNCHANGED, not as NULL', async () => {
    const changes: Array<{ row: Record<string, unknown> }> = [];
    const handle = await start({
      onChange: async (c) => void changes.push(c as never),
    });
    await emit('0/10', begin('0/90'));
    await emit('0/20', {
      tag: 'update',
      relation,
      new: { id: 1, status: 'done', body: undefined, note: null },
    });

    expect(changes[0]!.row).toEqual({
      id: 1,
      status: 'done',
      body: UNCHANGED,
      note: null,
    });
    await handle.stop();
  });

  it('turns an UPDATE of the key into the old row leaving and the new one arriving', async () => {
    const changes: unknown[] = [];
    const handle = await start(
      { onChange: async (c) => void changes.push(c) },
      { operations: ['insert', 'update', 'delete'] },
    );
    await emit('0/10', begin('0/90'));
    await emit('0/20', {
      tag: 'update',
      relation,
      key: { id: 1 },
      new: { id: 2, name: 'moved' },
    });

    expect(changes).toEqual([
      { op: 'delete', row: { id: 1 }, cursor: '0/90#0/20.0' },
      // flagged: nothing at the destination holds this row under its new key,
      // so a column left out as unchanged has to be read back, not left out
      {
        op: 'update',
        row: { id: 2, name: 'moved' },
        cursor: '0/90#0/20.1',
        keyChanged: true,
      },
    ]);
    await handle.stop();
  });

  it('does not invent a move when the old row arrives whole and the key is the same', async () => {
    const changes: Array<{ op: string }> = [];
    const handle = await start({
      onChange: async (c) => void changes.push(c as never),
    });
    await emit('0/10', begin('0/90'));
    // REPLICA IDENTITY FULL: `old` is sent on every update
    await emit('0/20', {
      tag: 'update',
      relation,
      old: { id: 1, name: 'a' },
      new: { id: 1, name: 'b' },
    });
    expect(changes.map((c) => c.op)).toEqual(['update']);
    expect(changes[0]).not.toHaveProperty('keyChanged');
    await handle.stop();
  });

  it('a delete carries only the columns the message really has', async () => {
    const changes: Array<{ row: Record<string, unknown> }> = [];
    const handle = await start(
      { onChange: async (c) => void changes.push(c as never) },
      { operations: ['delete'] },
    );
    await emit('0/10', begin('0/90'));
    await emit('0/20', {
      tag: 'delete',
      relation,
      key: { id: 7, name: undefined },
    });
    expect(changes[0]!.row).toEqual({ id: 7 });
    await handle.stop();
  });

  it('mirrors a TRUNCATE only for a bridge that captures them', async () => {
    const changes: unknown[] = [];
    const handle = await start(
      { onChange: async (c) => void changes.push(c) },
      { operations: ['insert', 'truncate'] },
    );
    await emit('0/10', begin('0/90'));
    await emit('0/20', {
      tag: 'truncate',
      relations: [{ name: 'users', schema: 'public' }],
    });
    expect(changes).toEqual([
      { op: 'truncate', row: {}, cursor: '0/90#0/20.0' },
    ]);
    await handle.stop();
  });

  it('otherwise says so on the timeline instead of staying quiet', async () => {
    const notices: Array<[string, string]> = [];
    const changes: unknown[] = [];
    const handle = await start({
      onChange: async (c) => void changes.push(c),
      onNotice: async (m, c) => void notices.push([m, c]),
    });
    await emit('0/10', begin('0/90'));
    await emit('0/20', {
      tag: 'truncate',
      relations: [{ name: 'users', schema: 'public' }],
    });

    expect(changes).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]![0]).toMatch(/TRUNCATEd at the source/);
    expect(notices[0]![0]).toMatch(/not applied/);
    expect(notices[0]![1]).toBe('0/90#0/20.0');
    await handle.stop();
  });
});
