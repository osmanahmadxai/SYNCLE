import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig } from '@syncle/core';
import type { ResolvedBridge } from '../../bridges.types';
import type { CdcChange, CdcStreamContext } from '../cdc-provider';
import { RedisCdcProvider } from './redis-cdc.provider';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** just enough of an ioredis client for startStream's subscriber connection */
class FakeSub extends EventEmitter {
  async connect(): Promise<void> {}
  async psubscribe(_pattern: string): Promise<void> {}
  disconnect(): void {}
}

/** value reader whose TYPE/GET round-trips take real (fake) time */
class FakeReader {
  constructor(private readonly values: Map<string, string>) {}
  async connect(): Promise<void> {}
  disconnect(): void {}
  async type(key: string): Promise<string> {
    await delay(15); // the window the DEL used to slip through
    return this.values.has(key) ? 'string' : 'none';
  }
  async get(key: string): Promise<string | null> {
    await delay(5);
    return this.values.get(key) ?? null;
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
