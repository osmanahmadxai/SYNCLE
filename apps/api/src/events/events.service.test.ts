import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import type { LiveEvent } from '@syncle/core';
import type { InstanceService } from '../common/instance.service';
import type { PrismaService } from '../common/prisma.service';
import type { PrismaWrite, WriteListener } from './write-events';
import {
  COALESCE_MS,
  EVENTS_BUS_TYPE,
  EventsService,
  HEARTBEAT_MS,
  isLiveEvent,
  RETRY_MS,
  STREAM_MAX_AGE_MS,
} from './events.service';

type Handler = (payload: unknown, from: string) => unknown;

function build() {
  let listener: WriteListener | null = null;
  const handlers = new Map<string, Handler>();
  const prisma = {
    onWrite: (l: WriteListener) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  } as unknown as PrismaService;
  const instance = {
    handle: (type: string, h: Handler) => handlers.set(type, h),
    publish: vi.fn(async () => undefined),
  } as unknown as InstanceService;
  const service = new EventsService(prisma, instance);
  service.onModuleInit();
  const write = (w: PrismaWrite) => listener?.(w);
  const fromBus = (payload: unknown) =>
    handlers.get(EVENTS_BUS_TYPE)?.(payload, 'other');
  const listen = () => {
    const got: MessageEvent[] = [];
    let done = false;
    const sub = service
      .stream()
      .subscribe({ next: (m) => got.push(m), complete: () => (done = true) });
    return { got, isDone: () => done, stop: () => sub.unsubscribe() };
  };
  return {
    service,
    instance,
    write,
    fromBus,
    listen,
    hasListener: () => listener !== null,
  };
}

const job = (jobId: string, bridgeId = 'b1'): PrismaWrite => ({
  model: 'BridgeJob',
  action: 'update',
  args: { where: { id: jobId } },
  result: { id: jobId, bridgeId, status: 'running' },
});

const events = (got: MessageEvent[]) =>
  got.filter((m) => m.data).map((m) => m.data as LiveEvent);

describe('the stream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens with how long to wait before coming back, and counts who is listening', () => {
    const { service, listen } = build();
    const a = listen();
    expect(a.got).toEqual([{ retry: RETRY_MS, comment: 'hello' }]);
    expect(service.open).toBe(1);
    const b = listen();
    expect(service.open).toBe(2);
    a.stop();
    b.stop();
    expect(service.open).toBe(0);
  });

  it('a write becomes an event here — and a word to the other processes', () => {
    const { instance, write, listen } = build();
    const s = listen();
    write(job('j1'));
    expect(events(s.got)).toEqual([
      expect.objectContaining({
        type: 'bridge.job',
        bridgeId: 'b1',
        jobId: 'j1',
      }),
    ]);
    expect(instance.publish).toHaveBeenCalledWith(
      EVENTS_BUS_TYPE,
      expect.objectContaining({ jobId: 'j1' }),
    );
    s.stop();
  });

  it('a burst about one thing: the first at once, the newest when it pauses — other things untouched', () => {
    const { instance, write, listen } = build();
    const s = listen();
    for (let i = 0; i < 5; i++) write(job('j1'));
    write(job('j2'));
    expect(events(s.got).map((e) => e.jobId)).toEqual(['j1', 'j2']);
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(events(s.got)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(events(s.got).map((e) => e.jobId)).toEqual(['j1', 'j2', 'j1']);
    // quiet again: nothing more is said, and the next word goes at once
    vi.advanceTimersByTime(COALESCE_MS * 3);
    expect(events(s.got)).toHaveLength(3);
    write(job('j1'));
    expect(events(s.got)).toHaveLength(4);
    expect(instance.publish).toHaveBeenCalledTimes(4);
    s.stop();
  });

  it('what another process said is passed on, once, and not said back to it', () => {
    const { instance, fromBus, listen } = build();
    const s = listen();
    const said: LiveEvent = {
      type: 'workspace',
      id: 'w1',
      at: new Date().toISOString(),
    };
    fromBus(said);
    expect(events(s.got)).toEqual([said]);
    expect(instance.publish).not.toHaveBeenCalled();
    fromBus({ type: 'weather', at: 'now' });
    fromBus('nonsense');
    fromBus(null);
    expect(events(s.got)).toHaveLength(1);
    s.stop();
  });

  it('a heartbeat while nothing happens, and an end after a while', () => {
    const { listen } = build();
    const s = listen();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(s.got.at(-1)).toEqual({ comment: 'ping' });
    vi.advanceTimersByTime(STREAM_MAX_AGE_MS - HEARTBEAT_MS);
    expect(s.isDone()).toBe(true);
    // one every HEARTBEAT_MS — except the one that would fall on the end itself
    expect(s.got.filter((m) => m.comment === 'ping').length).toBe(
      Math.ceil(STREAM_MAX_AGE_MS / HEARTBEAT_MS) - 1,
    );
  });

  it('stops listening to the store when the module goes down', () => {
    const { service, hasListener } = build();
    expect(hasListener()).toBe(true);
    service.onModuleDestroy();
    expect(hasListener()).toBe(false);
  });
});

describe('what counts as an event off the bus', () => {
  it('a known kind with a time; nothing else', () => {
    expect(isLiveEvent({ type: 'bridge', at: 'x' })).toBe(true);
    expect(
      isLiveEvent({ type: 'bridge.deliveries', jobId: 'j', at: 'x' }),
    ).toBe(true);
    expect(isLiveEvent({ type: 'weather', at: 'x' })).toBe(false);
    expect(isLiveEvent({ type: 'bridge' })).toBe(false);
    expect(isLiveEvent(null)).toBe(false);
    expect(isLiveEvent('bridge')).toBe(false);
  });
});
