import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import type { LiveEvent } from '@syncle/core';
import { queryKeys } from './queries';
import {
  connect,
  invalidateFor,
  pollEvery,
  SLOW_POLL_MS,
  type EventStream,
} from './live-events';

type Call = {
  queryKey?: readonly unknown[];
  exact?: boolean;
  predicate?: (q: { queryKey: readonly unknown[] }) => boolean;
};

function client() {
  const calls: Call[] = [];
  const qc = {
    invalidateQueries: vi.fn(async (filters?: Call) => {
      calls.push(filters ?? {});
    }),
  } as unknown as QueryClient;
  return { qc, calls };
}

const at = new Date().toISOString();

/** which of these keys an invalidation set touches */
function touched(
  calls: Call[],
  keys: Array<readonly unknown[]>,
): Array<readonly unknown[]> {
  return keys.filter((key) =>
    calls.some((c) => {
      if (c.predicate) return c.predicate({ queryKey: key });
      if (!c.queryKey) return true; // everything
      if (c.exact) return JSON.stringify(c.queryKey) === JSON.stringify(key);
      return c.queryKey.every(
        (part, i) => JSON.stringify(part) === JSON.stringify(key[i]),
      );
    }),
  );
}

describe('what an event makes stale', () => {
  const B = 'b1';
  const J = 'j1';
  const W = 'w1';
  const KEYS = [
    // the lists are keyed under their workspace, as the hooks in queries.ts key them
    [...queryKeys.bridges, W],
    queryKeys.bridge(B),
    queryKeys.bridgeJobs(B),
    queryKeys.bridgeJob(B, J),
    [...queryKeys.bridgeDeliveries(B, J), { limit: 2000 }],
    queryKeys.bridgeDeliveries('other', 'j9'),
    queryKeys.verifications(B),
    queryKeys.deadLetters(B),
    queryKeys.bridgeLoops(B),
    queryKeys.schemaDrift(B),
    ['bridgeStatuses', W],
    [...queryKeys.connections, W],
    queryKeys.connection('c1'),
    queryKeys.schema('c1', 'db'),
    queryKeys.workspaces,
    queryKeys.settings,
    queryKeys.users,
    queryKeys.apiKeys,
    queryKeys.audit,
    queryKeys.alertChannels,
  ] as Array<readonly unknown[]>;

  const after = (event: Omit<LiveEvent, 'at'>) => {
    const { qc, calls } = client();
    invalidateFor(qc, { ...event, at });
    return touched(calls, KEYS).map((k) => JSON.stringify(k));
  };
  const K = (k: readonly unknown[]) => JSON.stringify(k);

  it('a run: the runs of its bridge, the statuses, the list — not the deliveries of every run', () => {
    const stale = after({ type: 'bridge.job', bridgeId: B, jobId: J });
    expect(stale).toEqual(
      expect.arrayContaining([
        K(queryKeys.bridgeJobs(B)),
        K(queryKeys.bridgeJob(B, J)),
        K(['bridgeStatuses', 'w1']),
        K([...queryKeys.bridges, W]),
      ]),
    );
    expect(stale).not.toContain(
      K([...queryKeys.bridgeDeliveries(B, J), { limit: 2000 }]),
    );
    expect(stale).not.toContain(K(queryKeys.verifications(B)));
  });

  it('deliveries: the windows open on that run, whatever their options — and no other run’s', () => {
    const stale = after({ type: 'bridge.deliveries', jobId: J });
    expect(stale).toEqual([
      K([...queryKeys.bridgeDeliveries(B, J), { limit: 2000 }]),
    ]);
  });

  it('deliveries of no run in particular (details pruned): every window', () => {
    const stale = after({ type: 'bridge.deliveries' });
    expect(stale).toEqual(
      expect.arrayContaining([
        K([...queryKeys.bridgeDeliveries(B, J), { limit: 2000 }]),
        K(queryKeys.bridgeDeliveries('other', 'j9')),
      ]),
    );
    expect(stale).toHaveLength(2);
  });

  it('a bridge: the bridge, the list, what is derived from it — not its runs', () => {
    const stale = after({ type: 'bridge', bridgeId: B });
    expect(stale).toEqual(
      expect.arrayContaining([
        K([...queryKeys.bridges, W]),
        K(queryKeys.bridge(B)),
        K(queryKeys.bridgeLoops(B)),
        K(queryKeys.schemaDrift(B)),
        K(['bridgeStatuses', 'w1']),
      ]),
    );
    expect(stale).not.toContain(K(queryKeys.bridgeJobs(B)));
    expect(stale).not.toContain(
      K([...queryKeys.bridgeDeliveries(B, J), { limit: 2000 }]),
    );
  });

  it('a verification, a dead letter: theirs', () => {
    expect(after({ type: 'bridge.verification', bridgeId: B })).toEqual([
      K(queryKeys.verifications(B)),
    ]);
    expect(after({ type: 'bridge.deadLetters', bridgeId: B })).toEqual([
      K(queryKeys.deadLetters(B)),
    ]);
  });

  it('a connection: the list, everything under that connection, and the bridges that name it', () => {
    const stale = after({ type: 'connection', id: 'c1' });
    expect(stale).toEqual(
      expect.arrayContaining([
        K([...queryKeys.connections, W]),
        K(queryKeys.connection('c1')),
        K(queryKeys.schema('c1', 'db')),
        K([...queryKeys.bridges, W]),
        K(queryKeys.bridge(B)),
      ]),
    );
    expect(stale).toHaveLength(5);
    // another connection's schema is left alone
    expect(after({ type: 'connection', id: 'c2' })).not.toContain(
      K(queryKeys.schema('c1', 'db')),
    );
  });

  it('the rest: one family each, by the keys queries.ts uses', () => {
    expect(after({ type: 'workspace' })).toEqual([K(queryKeys.workspaces)]);
    expect(after({ type: 'settings' })).toEqual([K(queryKeys.settings)]);
    expect(after({ type: 'users' })).toEqual([K(queryKeys.users)]);
    expect(after({ type: 'apiKeys' })).toEqual([K(queryKeys.apiKeys)]);
    expect(after({ type: 'audit' })).toEqual([K(queryKeys.audit)]);
    expect(after({ type: 'alertChannels' })).toEqual([
      K(queryKeys.alertChannels),
    ]);
  });

  it('an event of a kind it does not know is ignored', () => {
    expect(after({ type: 'weather' as LiveEvent['type'] })).toEqual([]);
  });
});

/** an EventSource of the test's own */
class FakeStream implements EventStream {
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  /** the browser gave up (a response it did not like) */
  die(): void {
    this.readyState = 2;
    this.onerror?.({} as Event);
  }
  /** a network error: the browser retries by itself */
  drop(): void {
    this.readyState = 0;
    this.onerror?.({} as Event);
  }
  send(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('the connection', () => {
  const streams: FakeStream[] = [];
  const open = (url: string) => {
    const s = new FakeStream(url);
    streams.push(s);
    return s;
  };

  beforeEach(() => {
    streams.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the events URL; polls slow down once it is up, and speed up again when it is closed', () => {
    const { qc } = client();
    expect(pollEvery(1500)).toBe(1500);
    const stop = connect(qc, open, '/api/events');
    expect(streams[0]!.url).toBe('/api/events');
    expect(pollEvery(1500)).toBe(1500); // not up yet
    streams[0]!.open();
    expect(pollEvery(1500)).toBe(SLOW_POLL_MS);
    expect(pollEvery(60_000)).toBe(60_000);
    stop();
    expect(streams[0]!.closed).toBe(true);
    expect(pollEvery(1500)).toBe(1500);
  });

  it('an event invalidates what it is about; noise is ignored', () => {
    const { qc, calls } = client();
    const stop = connect(qc, open);
    streams[0]!.open();
    streams[0]!.send(JSON.stringify({ type: 'users', at }));
    expect(calls).toEqual([{ queryKey: ['users'], exact: false }]);
    streams[0]!.send('not json');
    streams[0]!.send(JSON.stringify({ hello: 'there' }));
    streams[0]!.send('42');
    expect(calls).toHaveLength(1);
    stop();
  });

  it('back after a gap, everything is asked for again — not on the first open', () => {
    const { qc, calls } = client();
    const stop = connect(qc, open);
    streams[0]!.open();
    expect(calls).toEqual([]);
    streams[0]!.drop(); // the browser reconnects by itself…
    expect(pollEvery(1500)).toBe(1500);
    expect(streams).toHaveLength(1);
    streams[0]!.open();
    expect(calls).toEqual([{}]);
    stop();
  });

  it('when the browser gives up, a try of our own after a while — backing off, and not once stopped', () => {
    const { qc } = client();
    const stop = connect(qc, open);
    streams[0]!.die();
    expect(streams).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(streams).toHaveLength(2);
    streams[1]!.die();
    vi.advanceTimersByTime(5_000);
    expect(streams).toHaveLength(2); // longer this time
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(3);
    streams[2]!.open(); // and a success resets the wait
    streams[2]!.die();
    vi.advanceTimersByTime(5_000);
    expect(streams).toHaveLength(4);
    streams[3]!.die();
    stop();
    vi.advanceTimersByTime(120_000);
    expect(streams).toHaveLength(4);
  });
});
