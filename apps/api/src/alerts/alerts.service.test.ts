import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredChannel } from './alert-channel.store';
import { AlertsService, type AlertInput } from './alerts.service';
import { runtimeConfig as frozen } from '../common/runtime-config';

/** read once at import and typed read-only; a test is where it gets changed */
const runtimeConfig = frozen as { alertThrottleSeconds: number };

const hook = (
  id: string,
  url = `https://93.184.216.${id.length}/${id}`,
): StoredChannel => ({
  id,
  kind: 'webhook',
  name: id,
  enabled: true,
  events: ['bridge.failed'],
  url,
});

const failed = (bridgeId = 'b-1'): AlertInput => ({
  type: 'bridge.failed',
  severity: 'critical',
  title: `Bridge "${bridgeId}" stopped`,
  message: 'boom',
  bridgeId,
  bridgeName: bridgeId,
});

function harness(
  channels: StoredChannel[],
  answer: (url: string, n: number) => number | Error = () => 200,
) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const outcomes: Array<{ id: string; ok: boolean; error: string | null }> = [];
  const store = {
    subscribers: vi.fn(async () => channels),
    resolve: vi.fn(async (id: string) => channels.find((c) => c.id === id)!),
    recordOutcome: vi.fn(
      async (id: string, ok: boolean, error: string | null) => {
        outcomes.push({ id, ok, error });
      },
    ),
  };
  const prisma = {
    bridgeJob: {
      findUnique: vi.fn(async () => ({
        bridgeId: 'b-9',
        bridge: { name: 'orders' },
      })),
    },
  };
  const service = new AlertsService(store as never, prisma as never);
  const counts = new Map<string, number>();
  service.deps = {
    version: 'test',
    fetch: (async (url: string, init: { body: string }) => {
      const n = (counts.get(url) ?? 0) + 1;
      counts.set(url, n);
      posts.push({
        url,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      const a = answer(url, n);
      if (a instanceof Error) throw a;
      return new Response(null, { status: a });
    }) as unknown as typeof fetch,
  };
  return { service, posts, outcomes, store, prisma };
}

const throttleBefore = runtimeConfig.alertThrottleSeconds;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  runtimeConfig.alertThrottleSeconds = 300;
});
afterEach(() => {
  vi.useRealTimers();
  runtimeConfig.alertThrottleSeconds = throttleBefore;
});

/** let everything emitted so far finish, retries' pauses included */
async function settle(service: AlertsService): Promise<void> {
  const done = service.idle();
  await vi.runAllTimersAsync();
  await done;
}

describe('emit', () => {
  it('tells every channel that asked for this kind of event, and records how each took it', async () => {
    const h = harness([hook('a'), hook('bb')]);
    h.service.emit(failed());
    await settle(h.service);
    expect(h.store.subscribers).toHaveBeenCalledWith('bridge.failed');
    expect(h.posts.map((p) => p.url).sort()).toEqual([
      'https://93.184.216.1/a',
      'https://93.184.216.2/bb',
    ]);
    expect(h.posts[0]!.body).toMatchObject({
      type: 'bridge.failed',
      bridgeId: 'b-1',
      title: 'Bridge "b-1" stopped',
    });
    expect(typeof h.posts[0]!.body.at).toBe('string');
    expect(h.outcomes).toEqual([
      { id: 'a', ok: true, error: null },
      { id: 'bb', ok: true, error: null },
    ]);
  });

  it('returns at once and never throws — not when a channel is down, not when the store is', async () => {
    const h = harness([hook('a')], () => new TypeError('fetch failed'));
    expect(() => h.service.emit(failed())).not.toThrow();
    await settle(h.service);
    expect(h.outcomes).toEqual([{ id: 'a', ok: false, error: 'fetch failed' }]);

    h.store.subscribers.mockRejectedValueOnce(new Error('store is down'));
    expect(() => h.service.emit(failed('b-2'))).not.toThrow();
    await expect(settle(h.service)).resolves.toBeUndefined();
  });

  it('tries a channel that did not take it once more, and only that one', async () => {
    const h = harness([hook('a'), hook('bb')], (url, n) =>
      url.endsWith('/a') && n === 1 ? 503 : 200,
    );
    h.service.emit(failed());
    await settle(h.service);
    expect(h.posts.filter((p) => p.url.endsWith('/a'))).toHaveLength(2);
    expect(h.posts.filter((p) => p.url.endsWith('/bb'))).toHaveLength(1);
    expect(h.outcomes.find((o) => o.id === 'a')).toEqual({
      id: 'a',
      ok: true,
      error: null,
    });
  });

  it('one channel that is down does not keep the others from hearing', async () => {
    const h = harness([hook('a'), hook('bb')], (url) =>
      url.endsWith('/a') ? new TypeError('fetch failed') : 200,
    );
    h.service.emit(failed());
    await settle(h.service);
    expect(h.outcomes).toContainEqual({ id: 'bb', ok: true, error: null });
    expect(h.outcomes).toContainEqual({
      id: 'a',
      ok: false,
      error: 'fetch failed',
    });
  });
});

describe('throttling', () => {
  it('a bridge that fails again and again is ONE alert per window; the next says how many were held back', async () => {
    const h = harness([hook('a')]);
    for (let i = 0; i < 4; i++) {
      h.service.emit(failed());
      await settle(h.service);
    }
    expect(h.posts).toHaveLength(1);

    vi.setSystemTime(Date.now() + 301_000);
    h.service.emit(failed());
    await settle(h.service);
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]!.body.suppressed).toBe(3);

    // and the count starts again
    vi.setSystemTime(Date.now() + 301_000);
    h.service.emit(failed());
    await settle(h.service);
    expect(h.posts[2]!.body).not.toHaveProperty('suppressed');
  });

  it('is per bridge and per kind of event: another bridge failing is news', async () => {
    const h = harness([hook('a')]);
    h.service.emit(failed('b-1'));
    h.service.emit(failed('b-2'));
    h.service.emit({ ...failed('b-1'), type: 'bridge.dead_letters' });
    await settle(h.service);
    expect(h.posts).toHaveLength(3);
  });

  it('can be switched off', async () => {
    runtimeConfig.alertThrottleSeconds = 0;
    const h = harness([hook('a')]);
    for (let i = 0; i < 3; i++) {
      h.service.emit(failed());
      await settle(h.service);
    }
    expect(h.posts).toHaveLength(3);
  });
});

describe('emitForJob', () => {
  it('finds out which bridge the job belongs to, for the places that only know the job', async () => {
    const h = harness([hook('a')]);
    h.service.emitForJob('j-1', {
      type: 'bridge.failed',
      severity: 'critical',
      title: (name) => `Bridge "${name}" stopped`,
      message: 'boom',
    });
    await settle(h.service);
    expect(h.posts[0]!.body).toMatchObject({
      title: 'Bridge "orders" stopped',
      bridgeId: 'b-9',
      bridgeName: 'orders',
      jobId: 'j-1',
    });
  });

  it('still says something when the bridge is gone by then', async () => {
    const h = harness([hook('a')]);
    h.prisma.bridgeJob.findUnique.mockResolvedValueOnce(null as never);
    h.service.emitForJob('j-1', {
      type: 'bridge.failed',
      severity: 'critical',
      title: (n) => `Bridge "${n}" stopped`,
      message: 'm',
    });
    await settle(h.service);
    expect(h.posts[0]!.body.title).toBe('Bridge "a deleted bridge" stopped');
  });
});

describe('test', () => {
  it('goes to one channel, now, whatever it subscribes to and however recently it was told something', async () => {
    const h = harness([hook('a')]);
    h.service.emit(failed());
    await settle(h.service);
    const first = h.service.test('a');
    await vi.runAllTimersAsync();
    const second = h.service.test('a');
    await vi.runAllTimersAsync();
    expect(await first).toEqual({ ok: true, detail: 'HTTP 200' });
    expect(await second).toEqual({ ok: true, detail: 'HTTP 200' });
    expect(h.posts.filter((p) => p.body.type === 'test')).toHaveLength(2);
    expect(h.posts.at(-1)!.body.message).toContain('Nothing is wrong');
  });

  it('reports a channel that does not work, and records it — without retrying: someone is watching', async () => {
    const h = harness([hook('a')], () => 500);
    const result = h.service.test('a');
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ ok: false });
    expect(h.posts).toHaveLength(1);
    expect(h.outcomes).toEqual([{ id: 'a', ok: false, error: 'HTTP 500' }]);
  });
});
