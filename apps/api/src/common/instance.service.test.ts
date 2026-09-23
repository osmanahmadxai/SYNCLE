/**
 * The lease, without a Redis: what a process does when it wins it, when it finds
 * it taken, and — the part no integration test can wait for — when Redis stops
 * answering for less, and for more, than the lease lasts.
 * (Two whole applications side by side are in test/integration/multi-instance.itest.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceService } from './instance.service';
import { runtimeConfig } from './runtime-config';

/** the three commands the lease uses, over one key that can be taken by somebody else */
function fakeRedis() {
  const state = { holder: null as string | null, down: false, sets: 0 };
  const check = () => {
    if (state.down) throw new Error('ECONNREFUSED');
  };
  return {
    state,
    set: async (key: string, value: string, ...args: unknown[]) => {
      check();
      state.sets++;
      if (key !== 'syncle:leader') return 'OK';
      if (args.includes('NX') && state.holder !== null) return null;
      state.holder = value;
      return 'OK';
    },
    eval: async (script: string, _n: number, key: string, id: string) => {
      check();
      if (key !== 'syncle:leader') return 1;
      if (state.holder !== id) return 0;
      if (script.includes("'del'")) state.holder = null;
      return 1;
    },
    get: async () => state.holder,
    del: async () => 1,
    publish: async () => {
      check();
      return 0;
    },
    quit: async () => 'OK',
    disconnect: () => undefined,
  };
}

function make() {
  const redis = fakeRedis();
  const service = new InstanceService();
  (service as unknown as { commands: unknown }).commands = redis;
  const events: string[] = [];
  service.onElected(() => void events.push('elected'));
  service.onDemoted((reason) => void events.push(`demoted: ${reason}`));
  const beat = () => (service as unknown as { tick(): Promise<void> }).tick();
  return { service, redis, events, beat };
}

const TTL_MS = Math.max(2, runtimeConfig.leaderTtlSeconds) * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('the lease', () => {
  it('is taken when it is free, and whoever waits for that is told once', async () => {
    const { service, events, beat } = make();
    expect(service.isLeader()).toBe(false);
    await beat();
    expect(service.isLeader()).toBe(true);
    await beat();
    await beat();
    expect(events).toEqual(['elected']);
    // somebody who asks later is told at once
    const late: string[] = [];
    service.onElected(() => void late.push('elected'));
    expect(late).toEqual(['elected']);
  });

  it('is not taken from a process that holds it — and is, the moment it lets go', async () => {
    const { service, redis, events, beat } = make();
    redis.state.holder = 'another-process';
    await beat();
    await beat();
    expect(service.isLeader()).toBe(false);
    redis.state.holder = null;
    await beat();
    expect(service.isLeader()).toBe(true);
    expect(events).toEqual(['elected']);
  });

  it('found in somebody else’s hands, it is given up at once: what only a leader may do has to stop', async () => {
    const { service, redis, events, beat } = make();
    await beat();
    redis.state.holder = 'another-process'; // (a partition that healed)
    await beat();
    expect(service.isLeader()).toBe(false);
    expect(events).toEqual([
      'elected',
      'demoted: another process holds the lease',
    ]);
  });

  it('is handed over on shutdown, not left to run out', async () => {
    const { service, redis, beat } = make();
    await beat();
    expect(redis.state.holder).toBe(service.id);
    await service.onModuleDestroy();
    expect(redis.state.holder).toBeNull();
  });
});

describe('when Redis stops answering', () => {
  it('for LESS than the lease lasts: the leader carries on (a restart of Redis is not a failover)', async () => {
    const { service, redis, events, beat } = make();
    await beat();
    redis.state.down = true;
    vi.advanceTimersByTime(TTL_MS - 1000);
    await beat();
    expect(service.isLeader()).toBe(true);
    redis.state.down = false;
    await beat();
    expect(service.isLeader()).toBe(true);
    expect(events).toEqual(['elected']);
  });

  it('for LONGER: the lease is somebody else’s by now for all it can tell — it stops, and leads again when it can', async () => {
    const { service, redis, events, beat } = make();
    await beat();
    redis.state.down = true;
    vi.advanceTimersByTime(TTL_MS + 1000);
    await beat();
    expect(service.isLeader()).toBe(false);
    expect(events[1]).toMatch(/^demoted: the lease could not be renewed/);
    // nobody took it in the meantime (Redis was down for everybody)
    redis.state.down = false;
    redis.state.holder = null;
    await beat();
    expect(service.isLeader()).toBe(true);
    expect(events).toHaveLength(3);
    expect(events[2]).toBe('elected');
  });

  it('a process that does not lead is not "demoted" by an outage', async () => {
    const { service, redis, events, beat } = make();
    redis.state.holder = 'another-process';
    await beat();
    redis.state.down = true;
    vi.advanceTimersByTime(TTL_MS * 3);
    await beat();
    expect(service.isLeader()).toBe(false);
    expect(events).toEqual([]);
  });

  it('work under a lock is done anyway: a lock nobody can take is no reason to stop', async () => {
    const { service, redis } = make();
    redis.state.down = true;
    await expect(
      service.withLock('anything', async () => 'done'),
    ).resolves.toBe('done');
  });

  it('asking the leader is answered with "nobody", not with an error', async () => {
    const { service, redis } = make();
    redis.state.down = true;
    await expect(
      service.askLeader('cdc.ping', null, 50),
    ).resolves.toBeUndefined();
  });
});

describe('a listener that throws', () => {
  it('does not keep the others from hearing, or the lease from being held', async () => {
    const { service, events, beat } = make();
    service.onElected(() => {
      throw new Error('a service that could not start');
    });
    service.onElected(() => void events.push('the next one'));
    await beat();
    expect(service.isLeader()).toBe(true);
    expect(events).toEqual(['elected', 'the next one']);
  });
});
