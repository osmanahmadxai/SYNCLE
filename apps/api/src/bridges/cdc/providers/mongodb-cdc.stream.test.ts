/**
 * MongoDB: what happens when the oplog has rolled past the bridge's resume
 * token, with the driver replaced by a double.
 *
 * It used to log a warning and restart the stream from "now". Nothing on the
 * bridge showed that a stretch of changes had never been read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MongodbCdcProvider } from './mongodb-cdc.provider';

const fake = vi.hoisted(() => {
  const state = {
    /** one entry per `watch()` call: what that stream does */
    scripts: [] as Array<{
      fail?: Error & { code?: number; codeName?: string };
      changes?: unknown[];
    }>,
    watched: [] as Array<Record<string, unknown>>,
    closed: 0,
  };
  class FakeClient {
    async connect(): Promise<void> {}
    async close(): Promise<void> {
      state.closed++;
    }
    db() {
      return {
        collection: () => ({
          watch: (_pipeline: unknown, options: Record<string, unknown>) => {
            state.watched.push(options);
            const script = state.scripts.shift() ?? {};
            return {
              close: async () => undefined,
              async *[Symbol.asyncIterator]() {
                for (const change of script.changes ?? []) yield change;
                if (script.fail) throw script.fail;
                // an open stream with nothing more to say
                await new Promise(() => undefined);
              },
            };
          },
        }),
      };
    }
  }
  return { state, FakeClient };
});

vi.mock('mongodb', async (original) => ({
  ...(await original<typeof import('mongodb')>()),
  MongoClient: fake.FakeClient,
}));

const bridge = {
  id: 'b1',
  source: { kind: 'table', connectionId: 'c', table: 'orders' },
  trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
} as never;
const conn = {
  engine: 'mongodb',
  host: 'h',
  port: 27017,
  database: 'app',
} as never;

const historyLost = Object.assign(
  new Error(
    'Resume of change stream was not possible, as the resume point may no longer be in the oplog.',
  ),
  {
    code: 286,
    codeName: 'ChangeStreamHistoryLost',
  },
);

beforeEach(() => {
  fake.state.scripts = [];
  fake.state.watched = [];
  fake.state.closed = 0;
});

describe('a resume token older than the oplog', () => {
  it('stops and reports the position lost, instead of restarting from now', async () => {
    fake.state.scripts = [{ fail: historyLost }];
    const lost: string[] = [];
    const errors: string[] = [];
    const provider = new MongodbCdcProvider();
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: JSON.stringify({ _data: '8265' }),
      handlers: {
        onChange: async () => undefined,
        onPositionLost: async (m) => void lost.push(m),
        onError: (e) => void errors.push(e.message),
      },
    });
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    expect(lost[0]).toMatch(/older than the MongoDB oplog window/);
    // it did not open a second stream from "now"
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.state.watched).toHaveLength(1);
    expect(fake.state.watched[0]).toHaveProperty('startAfter');
    expect(errors).toEqual([]);
    await handle.stop();
  });

  it('is recognised by code as well as by name', async () => {
    fake.state.scripts = [
      { fail: Object.assign(new Error('history lost'), { code: 286 }) },
    ];
    const lost: string[] = [];
    const provider = new MongodbCdcProvider();
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: JSON.stringify({ _data: '8265' }),
      handlers: {
        onChange: async () => undefined,
        onPositionLost: async (m) => void lost.push(m),
        onError: () => undefined,
      },
    });
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    await handle.stop();
  });

  it('any OTHER failure is still retried from the same token', async () => {
    fake.state.scripts = [{ fail: new Error('connection reset') }, {}];
    const lost: string[] = [];
    const errors: string[] = [];
    const provider = new MongodbCdcProvider();
    const handle = await provider.startStream({
      bridgeId: 'b1',
      bridge,
      conn,
      fromCursor: JSON.stringify({ _data: '8265' }),
      handlers: {
        onChange: async () => undefined,
        onPositionLost: async (m) => void lost.push(m),
        onError: (e) => void errors.push(e.message),
      },
    });
    await vi.waitFor(() => expect(fake.state.watched).toHaveLength(2), {
      timeout: 5_000,
    });
    expect(errors).toEqual(['connection reset']);
    expect(lost).toEqual([]);
    expect(fake.state.watched[1]).toHaveProperty('startAfter');
    await handle.stop();
  });
});
