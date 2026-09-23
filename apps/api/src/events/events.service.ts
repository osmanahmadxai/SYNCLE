/**
 * what happens, told as it happens: a stream of {@link LiveEvent}s for the
 * page (over server-sent events, see {@link EventsController}), instead of the
 * page asking every few seconds whether anything did.
 *
 * an event says only THAT something changed and what it was about; the
 * listener asks for the thing itself. so nothing here has to be reliable the
 * way a delivery is: a missed event is a little staleness, which the page's
 * remaining (slow) polls take care of.
 *
 * where the events come from: every write to the metadata store (a Prisma
 * middleware, see `write-events.ts`) — and every other API process, over the
 * instance bus, so that a page connected to one process hears what another
 * did. a burst of writes about one thing (the deliveries of a run, ten a
 * second) is thinned to one event now and one when the burst pauses.
 */
import {
  Injectable,
  type MessageEvent,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { LIVE_EVENT_TYPES, type LiveEvent } from '@syncle/core';
import { interval, merge, Observable, Subject, timer } from 'rxjs';
import { map, startWith, takeUntil } from 'rxjs/operators';
import { InstanceService } from '../common/instance.service';
import { PrismaService } from '../common/prisma.service';
import { eventOf } from './write-events';

/** a second event about the same thing within this many ms waits, and only the last of them is sent */
export const COALESCE_MS = 750;
/** a comment on the stream this often, so that nothing between the two ends decides it is idle */
export const HEARTBEAT_MS = 25_000;
/** a stream is ended after this long; the browser opens a new one — and is looked at again by the guard */
export const STREAM_MAX_AGE_MS = 15 * 60_000;
/** what the browser is told to wait before opening a new stream */
export const RETRY_MS = 2_000;
/** the bus message that carries an event to the other processes */
export const EVENTS_BUS_TYPE = 'events.emit';

const KNOWN = new Set<string>(LIVE_EVENT_TYPES);

/** an event as it came over the bus: only what looks like one is passed on */
export function isLiveEvent(value: unknown): value is LiveEvent {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.type === 'string' && KNOWN.has(e.type) && typeof e.at === 'string'
  );
}

interface Quiet {
  timer: ReturnType<typeof setTimeout>;
  /** the newest event about this thing that arrived during the quiet time */
  held: LiveEvent | null;
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly subject = new Subject<LiveEvent>();
  private readonly quiet = new Map<string, Quiet>();
  private unhook: (() => void) | null = null;
  private streams = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly instance: InstanceService,
  ) {}

  onModuleInit(): void {
    this.unhook = this.prisma.onWrite((write) => {
      const event = eventOf(write);
      if (event) this.emit(event);
    });
    // what another process did is passed straight on: it thinned it already
    this.instance.handle(EVENTS_BUS_TYPE, (payload) => {
      if (isLiveEvent(payload)) this.subject.next(payload);
      return undefined;
    });
  }

  onModuleDestroy(): void {
    this.unhook?.();
    this.unhook = null;
    for (const q of this.quiet.values()) clearTimeout(q.timer);
    this.quiet.clear();
    this.subject.complete();
  }

  /**
   * say it: to every stream here, and to every other process. the first word
   * about a thing goes at once; more within {@link COALESCE_MS} wait, and only
   * the newest of them is said when the time is up (then the time starts again)
   */
  emit(event: LiveEvent): void {
    const key = keyOf(event);
    const q = this.quiet.get(key);
    if (q) {
      q.held = event;
      return;
    }
    this.send(event);
    this.quiet.set(key, { held: null, timer: this.later(key) });
  }

  /** how many streams are open on this process */
  get open(): number {
    return this.streams;
  }

  /**
   * a stream for one listener: what is said from now on, a heartbeat, and an
   * end after {@link STREAM_MAX_AGE_MS} (the browser comes back by itself)
   */
  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.streams++;
      const subscription = merge(
        this.subject.pipe(map((event): MessageEvent => ({ data: event }))),
        interval(HEARTBEAT_MS).pipe(
          map((): MessageEvent => ({ comment: 'ping' })),
        ),
      )
        .pipe(
          startWith<MessageEvent>({ retry: RETRY_MS, comment: 'hello' }),
          takeUntil(timer(STREAM_MAX_AGE_MS)),
        )
        .subscribe(subscriber);
      return () => {
        this.streams--;
        subscription.unsubscribe();
      };
    });
  }

  private later(key: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.settle(key), COALESCE_MS);
    t.unref?.();
    return t;
  }

  private settle(key: string): void {
    const q = this.quiet.get(key);
    if (!q) return;
    if (q.held) {
      const event = q.held;
      q.held = null;
      this.send(event);
      q.timer = this.later(key);
    } else {
      this.quiet.delete(key);
    }
  }

  private send(event: LiveEvent): void {
    this.subject.next(event);
    void this.instance.publish(EVENTS_BUS_TYPE, event);
  }
}

/** what an event is about, for thinning: its kind and its ids */
const keyOf = (e: LiveEvent): string =>
  [e.type, e.bridgeId ?? '', e.jobId ?? '', e.id ?? ''].join('|');
