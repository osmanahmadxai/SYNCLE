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

const bridge = {
  id: 'b1',
  source: { kind: 'table', connectionId: 'c', table: 'users' },
  trigger: { kind: 'cdc', operations: ['insert', 'update'] },
} as never;
const conn = { engine: 'postgres', host: 'h', port: 5432 } as never;
const relation = { name: 'users', schema: 'public' };

async function start(handlers: {
  onChange?: (c: unknown) => Promise<void>;
  onSkip?: (cursor: string) => Promise<void>;
}) {
  const provider = new PostgresCdcProvider({} as never);
  const handle = await provider.startStream({
    bridgeId: 'b1',
    bridge,
    conn,
    fromCursor: null,
    handlers: {
      onChange: handlers.onChange ?? (async () => undefined),
      onSkip: handlers.onSkip,
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
  it('never confirms a transaction marker by itself', async () => {
    const skipped: string[] = [];
    const handle = await start({ onSkip: async (c) => void skipped.push(c) });

    await emit('0/10', { tag: 'begin' });
    await emit('0/20', { tag: 'insert', relation, new: { id: 1 } });
    await emit('0/30', { tag: 'commit' });

    // the row at 0/20 has only been handed over, not delivered: confirming the
    // COMMIT at 0/30 here is exactly what used to strand it
    expect(acknowledged).toEqual([]);
    expect(skipped).toEqual(['0/10', '0/30']);
    await handle.stop();
  });

  it('hands every kind of undelivered message to the orchestrator instead', async () => {
    const skipped: string[] = [];
    const changes: unknown[] = [];
    const handle = await start({
      onChange: async (c) => void changes.push(c),
      onSkip: async (c) => void skipped.push(c),
    });

    await emit('0/1', { tag: 'relation' });
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
    await emit('0/5', { tag: 'truncate' });
    await emit('0/6', { tag: 'update', relation, new: { id: 1 } });

    expect(skipped).toEqual(['0/1', '0/2', '0/3', '0/4', '0/5']);
    expect(changes).toEqual([{ op: 'update', row: { id: 1 }, cursor: '0/6' }]);
    expect(acknowledged).toEqual([]);
    await handle.stop();
  });

  it('waits for the orchestrator before reading on (backpressure covers skips too)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = await start({ onSkip: () => gate });

    let done = false;
    const pending = emit('0/10', { tag: 'commit' }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await pending;
    expect(done).toBe(true);
    await handle.stop();
  });

  it('confirms exactly what it is told to, when it is told to', async () => {
    const handle = await start({ onSkip: async () => undefined });
    await emit('0/10', { tag: 'commit' });
    expect(acknowledged).toEqual([]);

    await handle.ack!('0/10');
    expect(acknowledged).toEqual(['0/10']);
    await handle.stop();
  });

  it('answers keepalives with the last CONFIRMED position, never a skipped one', async () => {
    const handle = await start({ onSkip: async () => undefined });
    await emit('0/50', { tag: 'commit' });

    fake.state.client!.emit('heartbeat', '0/60', Date.now(), true);
    expect(acknowledged).toEqual([]); // nothing confirmed yet, so nothing to repeat

    await handle.ack!('0/40');
    fake.state.client!.emit('heartbeat', '0/60', Date.now(), true);
    expect(acknowledged).toEqual(['0/40', '0/40']);
    await handle.stop();
  });

  it('an orchestrator that does not take skips leaves the slot where it is', async () => {
    const handle = await start({});
    await emit('0/10', { tag: 'commit' });
    // holding WAL a little longer is recoverable; confirming too far is not
    expect(acknowledged).toEqual([]);
    await handle.stop();
  });
});
