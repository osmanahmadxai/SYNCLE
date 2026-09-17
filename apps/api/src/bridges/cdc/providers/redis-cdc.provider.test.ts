import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig } from '@syncle/core';
import type { ResolvedBridge } from '../../bridges.types';
import type { CdcChange, CdcStreamContext } from '../cdc-provider';
import { RedisCdcProvider, isSyncleOwnKey } from './redis-cdc.provider';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** just enough of an ioredis client for startStream's subscriber connection */
class FakeSub extends EventEmitter {
  async connect(): Promise<void> {}
  async psubscribe(_pattern: string): Promise<void> {}
  disconnect(): void {}
}

/**
 * Value reader whose round-trips take real (fake) time.
 *
 * The provider reads values through a PIPELINE — one round trip covering a
 * whole batch of keys — so the double models that rather than single commands.
 * `exec` keeps the delay that opens the window a DEL used to slip through, so
 * the ordering tests still exercise the race they were written for.
 */
class FakeReader {
  constructor(private readonly values: Map<string, string>) {}
  async connect(): Promise<void> {}
  disconnect(): void {}

  async type(key: string): Promise<string> {
    await delay(15);
    return this.values.has(key) ? 'string' : 'none';
  }
  async get(key: string): Promise<string | null> {
    await delay(5);
    return this.values.get(key) ?? null;
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this.values);
  }
}

/** the subset of ioredis's pipeline the provider uses */
class FakePipeline {
  private readonly queued: Array<() => unknown> = [];
  constructor(private readonly values: Map<string, string>) {}

  type(key: string): this {
    this.queued.push(() => (this.values.has(key) ? 'string' : 'none'));
    return this;
  }
  get(key: string): this {
    this.queued.push(() => this.values.get(key) ?? null);
    return this;
  }
  hgetall(key: string): this {
    this.queued.push(() => ({ value: this.values.get(key) ?? null }));
    return this;
  }
  lrange(key: string): this {
    this.queued.push(() => [this.values.get(key) ?? null]);
    return this;
  }
  smembers(key: string): this {
    this.queued.push(() => [this.values.get(key) ?? null]);
    return this;
  }
  zrange(key: string): this {
    this.queued.push(() => [this.values.get(key) ?? null]);
    return this;
  }

  /** ioredis shape: one [error, result] pair per queued command, in order */
  async exec(): Promise<Array<[Error | null, unknown]>> {
    await delay(15);
    return this.queued.map((run) => [null, run()] as [Error | null, unknown]);
  }
}

const BRIDGE = {
  source: { kind: 'table', connectionId: 'c1', table: 'keys' },
  trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
} as unknown as ResolvedBridge;

const CONN = { engine: 'redis' } as unknown as ConnectionConfig;

async function startFakeStream(reader: FakeReader) {
  const provider = new RedisCdcProvider();
  const sub = new FakeSub();
  vi.spyOn(provider as unknown as { newClient: () => unknown }, 'newClient')
    .mockImplementationOnce(() => sub)
    .mockImplementationOnce(() => reader);

  const seen: string[] = [];
  const errors: string[] = [];
  const handle = await provider.startStream({
    bridgeId: 'h1',
    bridge: BRIDGE,
    conn: CONN,
    fromCursor: null,
    handlers: {
      onChange: async (change: CdcChange) => {
        if (change.row.key === 'boom') throw new Error('sink exploded');
        seen.push(`${change.op}:${String(change.row.key)}`);
      },
      onError: (err: Error) => {
        errors.push(err.message);
      },
    },
  } as CdcStreamContext);

  const emit = (event: string, key: string) =>
    sub.emit('pmessage', '__keyevent@0__:*', `__keyevent@0__:${event}`, key);
  return { seen, errors, handle, emit };
}

describe('RedisCdcProvider event ordering', () => {
  it('SET then DEL delivers as update then delete, never resurrecting the key', async () => {
    const { seen, emit, handle } = await startFakeStream(
      new FakeReader(new Map([['user:1', 'v1']])),
    );

    // the SET's value read is in flight when the DEL arrives; unchained, the
    // DEL's instant buildRow would win and the order would invert
    emit('set', 'user:1');
    emit('del', 'user:1');

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual(['update:user:1', 'delete:user:1']);
    await handle.stop();
  });

  it('keeps arrival order across keys too', async () => {
    const { seen, emit, handle } = await startFakeStream(
      new FakeReader(
        new Map([
          ['a', '1'],
          ['b', '2'],
        ]),
      ),
    );

    emit('set', 'a');
    emit('set', 'b');
    emit('del', 'a');

    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen).toEqual(['update:a', 'update:b', 'delete:a']);
    await handle.stop();
  });

  it('a failing delivery reports onError and later events still flow', async () => {
    const { seen, errors, emit, handle } = await startFakeStream(
      new FakeReader(new Map([['ok', 'v']])),
    );

    emit('set', 'boom');
    emit('set', 'ok');

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual(['update:ok']);
    expect(errors).toEqual(['sink exploded']);
    await handle.stop();
  });
});

describe("Syncle's own keys", () => {
  it('are recognised: the spool streams and both job queues', () => {
    expect(
      isSyncleOwnKey('syncle:cdc:spool:e59dd729-c355-42bc-ad33-cbdb47d443c3'),
    ).toBe(true);
    expect(isSyncleOwnKey('bull:bridge-jobs:42')).toBe(true);
    expect(isSyncleOwnKey('bull:bridge-watch:repeat:abc:1700000000')).toBe(
      true,
    );
  });

  it('nothing of the user’s is: not even keys that look similar', () => {
    for (const key of [
      'user:1',
      'syncle',
      'syncle:cdc',
      'syncle:report:2026',
      'bull:emails:7', // somebody else's BullMQ queue is their data
      'bull:bridge-jobs', // no trailing colon: not one of the queue's keys
      'mybull:bridge-jobs:1',
    ]) {
      expect(isSyncleOwnKey(key), key).toBe(false);
    }
  });

  it('never reach a bridge, which would otherwise capture its own spool writes for ever', async () => {
    const { seen, emit, handle } = await startFakeStream(
      new FakeReader(new Map([['user:1', 'v']])),
    );

    // what one spooled batch produces in a shared Redis: the XADD, the trim
    emit('xadd', 'syncle:cdc:spool:b1');
    emit('xtrim', 'syncle:cdc:spool:b1');
    emit('hset', 'bull:bridge-watch:meta');
    emit('set', 'user:1');

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['update:user:1']);
    await handle.stop();
  });
});

describe('a bridge that writes into the Redis database it listens to', () => {
  const provider = new RedisCdcProvider();
  // never reached by these tests: the refusal comes first
  (
    provider as unknown as { enableNotifications: () => Promise<void> }
  ).enableNotifications = async () => undefined;

  const redis = (over: Partial<ConnectionConfig>): ConnectionConfig =>
    ({
      id: 'x',
      name: 'x',
      engine: 'redis',
      host: 'cache.internal',
      port: 6379,
      ...over,
    }) as ConnectionConfig;
  const bridgeTo = (...connectionIds: string[]): ResolvedBridge =>
    ({
      source: { kind: 'table', connectionId: 'src', table: '*' },
      trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      destination: {
        kind: 'database',
        targets: connectionIds.map((connectionId) => ({
          connectionId,
          table: 't',
        })),
      },
    }) as unknown as ResolvedBridge;
  const lookup =
    (map: Record<string, ConnectionConfig>) => async (id: string) => {
      const found = map[id];
      if (!found) throw new Error('no such connection');
      return found;
    };

  it('is refused: it would capture its own writes without end', async () => {
    await expect(
      provider.provision(
        'b',
        bridgeTo('dst'),
        redis({}),
        lookup({ dst: redis({ id: 'other-record' }) }),
      ),
    ).rejects.toThrow(
      /listens to Redis database cache\.internal:6379\/0 and also writes into it/,
    );
  });

  it('sees through the ways one database can be spelled', async () => {
    const source = redis({ host: 'localhost', options: { db: 2 } });
    for (const same of [
      redis({ host: '127.0.0.1', options: { db: 2 } }),
      redis({ host: 'LOCALHOST', database: '2' }),
      redis({
        host: undefined,
        connectionString: 'redis://:secret@localhost:6379/2',
      }),
      redis({
        host: undefined,
        port: undefined,
        connectionString: 'rediss://[::1]/2',
      }),
    ]) {
      await expect(
        provider.provision('b', bridgeTo('dst'), source, lookup({ dst: same })),
        JSON.stringify(same),
      ).rejects.toThrow(/also writes into it/);
    }
  });

  it('another db number, port or host is another database', async () => {
    const source = redis({ options: { db: 0 } });
    for (const other of [
      redis({ options: { db: 1 } }),
      redis({ port: 6380 }),
      redis({ host: 'cache-2.internal' }),
      redis({ connectionString: 'redis://cache.internal:6379/5' }),
    ]) {
      await expect(
        provider.provision(
          'b',
          bridgeTo('dst'),
          source,
          lookup({ dst: other }),
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('checks every target, and only the Redis ones', async () => {
    const source = redis({});
    const pg = {
      id: 'pg',
      name: 'pg',
      engine: 'postgres',
      host: 'cache.internal',
      port: 6379,
    } as ConnectionConfig;
    await expect(
      provider.provision('b', bridgeTo('pg'), source, lookup({ pg })),
    ).resolves.toBeUndefined();
    await expect(
      provider.provision(
        'b',
        bridgeTo('pg', 'loop'),
        source,
        lookup({ pg, loop: redis({}) }),
      ),
    ).rejects.toThrow(/also writes into it/);
  });

  it('an HTTP destination, or a target that cannot be looked up, does not stop it', async () => {
    const http = {
      ...bridgeTo(),
      destination: { kind: 'http', url: 'https://example.test' },
    } as unknown as ResolvedBridge;
    await expect(
      provider.provision('b', http, redis({}), lookup({})),
    ).resolves.toBeUndefined();
    await expect(
      provider.provision('b', bridgeTo('gone'), redis({}), lookup({})),
    ).resolves.toBeUndefined();
  });
});
