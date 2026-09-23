/**
 * More than one API process on the same database and the same Redis.
 *
 * Nothing stopped anybody from running two — a second replica "for
 * availability", a rolling deploy that overlaps for a minute — and nothing made
 * it safe. Every process resumed EVERY live CDC bridge at boot and kept the
 * stream in a table of its own, so two processes meant two readers per bridge:
 * on PostgreSQL the second one looped on "replication slot is active"; on MySQL
 * both connected under the same server id and the server threw the older one
 * out, which reconnected and threw the newer one out; on MongoDB and Redis
 * every change was simply delivered twice.
 *
 * What is here is the little that processes need to agree on:
 *
 *   a LEADER  one process holds a lease in Redis and renews it. The work that
 *             must exist once — the live change streams, the periodic sweeps —
 *             runs there. When the leader goes (a deploy, a crash), another
 *             process takes the lease within its TTL and picks the work up from
 *             the positions that were saved: failover, which a single process
 *             never had.
 *   a BUS     so that "stop this bridge", said to a process that is not reading
 *             it, reaches the one that is — and is answered before the caller
 *             is told it is done.
 *   LOCKS     for work any process may pick up but only one may do at a time.
 *
 * A leader that cannot renew its lease for as long as the lease lasts has to
 * assume somebody else holds it by now, and STOPS what only a leader may do
 * (it fences itself). With one process that means a Redis outage longer than
 * the lease pauses the live streams until Redis is back; they continue from
 * their saved positions, so nothing is lost — and everything else that process
 * does (runs, polls, schedules) needs Redis anyway.
 *
 * With Redis unreachable at boot, nobody is leader until it answers.
 */
import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  BUS_CHANNEL,
  INSTANCE_PREFIX,
  LEADER_KEY,
  LOCK_PREFIX,
} from './instance-keys';
import { redisConnectionOptions, runtimeConfig } from './runtime-config';
import { resolveVersion } from './version';

/** renew / release only what is still OURS: the key may have expired and been taken */
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

interface BusMessage {
  id: string;
  from: string;
  type: string;
  payload?: unknown;
  /** set on a request: the id the answer has to carry */
  reply?: string;
  /** set on an answer */
  re?: string;
  error?: string;
  /** only the leader answers this one */
  toLeader?: boolean;
}

type Handler = (payload: unknown, from: string) => unknown | Promise<unknown>;

export interface InstanceInfo {
  id: string;
  startedAt: string;
  version: string;
  leader: boolean;
  /** this is the process that answered */
  self: boolean;
}

@Injectable()
export class InstanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('Instance');
  readonly id = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly version = resolveVersion().version;

  private commands: Redis | null = null;
  private subscriber: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  private leader = false;
  /** when the lease was last known to be ours (acquired or renewed) */
  private leaseSeenAt = 0;
  private campaigning: Promise<void> = Promise.resolve();

  private readonly elected: Array<() => void | Promise<void>> = [];
  private readonly demoted: Array<(reason: string) => void | Promise<void>> =
    [];
  private readonly handlers = new Map<string, Handler>();
  private readonly waiting = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private get ttlMs(): number {
    return Math.max(2, runtimeConfig.leaderTtlSeconds) * 1000;
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** run when this process becomes the leader (at once, if it already is) */
  onElected(listener: () => void | Promise<void>): void {
    this.elected.push(listener);
    if (this.leader) void (async () => listener())().catch(() => undefined);
  }

  /** run when this process stops being the leader: whatever only a leader may do has to stop */
  onDemoted(listener: (reason: string) => void | Promise<void>): void {
    this.demoted.push(listener);
  }

  /* ----- lifecycle ----- */

  async onApplicationBootstrap(): Promise<void> {
    this.connect();
    await this.tick();
    const every = Math.max(500, Math.floor(this.ttlMs / 3));
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('this process is shutting down'));
    }
    this.waiting.clear();
    // hand the lease over NOW, so that the next leader does not have to wait for it to run out
    if (this.leader) {
      this.leader = false;
      await this.commands
        ?.eval(RELEASE, 1, LEADER_KEY, this.id)
        .catch(() => undefined);
    }
    await this.commands
      ?.del(`${INSTANCE_PREFIX}${this.id}`)
      .catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
    await this.commands?.quit().catch(() => undefined);
    this.subscriber = null;
    this.commands = null;
  }

  private connect(): void {
    if (this.commands) return;
    const options = { ...redisConnectionOptions(), maxRetriesPerRequest: 1 };
    this.commands = new Redis(options);
    this.subscriber = new Redis(options);
    // said by the tick, once per outage, not by every command
    this.commands.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (_channel, text) => void this.receive(text));
    void this.subscriber.subscribe(BUS_CHANNEL).catch(() => undefined);
  }

  /* ----- the lease ----- */

  /** one heartbeat: say that this process is alive, and hold — or try for — the lease */
  private tick(): Promise<void> {
    this.campaigning = this.campaigning
      .then(() => this.heartbeat())
      .catch(() => undefined);
    return this.campaigning;
  }

  private outage = false;

  private async heartbeat(): Promise<void> {
    if (this.closed || !this.commands) return;
    try {
      await this.commands.set(
        `${INSTANCE_PREFIX}${this.id}`,
        JSON.stringify({
          id: this.id,
          startedAt: this.startedAt,
          version: this.version,
        }),
        'PX',
        this.ttlMs * 2,
      );
      if (this.leader) {
        const kept = await this.commands.eval(
          RENEW,
          1,
          LEADER_KEY,
          this.id,
          String(this.ttlMs),
        );
        if (kept === 1) this.leaseSeenAt = Date.now();
        else await this.stepDown('another process holds the lease');
      } else {
        const won = await this.commands.set(
          LEADER_KEY,
          this.id,
          'PX',
          this.ttlMs,
          'NX',
        );
        if (won === 'OK') await this.stepUp();
      }
      if (this.outage) {
        this.outage = false;
        this.logger.log('Redis answers again.');
      }
    } catch (err) {
      if (!this.outage) {
        this.outage = true;
        this.logger.warn(`Redis does not answer (${(err as Error).message}).`);
      }
      // a lease that could not be renewed for as long as it lasts is, as far as
      // anybody can tell, somebody else's by now
      if (this.leader && Date.now() - this.leaseSeenAt > this.ttlMs) {
        await this.stepDown(
          'the lease could not be renewed: Redis has not answered for as long as it lasts',
        );
      }
    }
  }

  private async stepUp(): Promise<void> {
    this.leader = true;
    this.leaseSeenAt = Date.now();
    this.logger.log(
      `This process (${this.id.slice(0, 8)}) is the leader: it runs the live change streams and the periodic sweeps.`,
    );
    for (const listener of this.elected) {
      await (async () => listener())().catch((err) =>
        this.logger.error(`after being elected: ${(err as Error).message}`),
      );
    }
  }

  private async stepDown(reason: string): Promise<void> {
    if (!this.leader) return;
    this.leader = false;
    this.logger.warn(
      `This process is no longer the leader (${reason}); it stops what only the leader may do.`,
    );
    for (const listener of this.demoted) {
      await (async () => listener(reason))().catch((err) =>
        this.logger.error(`after being demoted: ${(err as Error).message}`),
      );
    }
  }

  /** the processes that are alive, as Redis knows them */
  async instances(): Promise<InstanceInfo[]> {
    if (!this.commands) return [];
    const leader = await this.commands.get(LEADER_KEY);
    const out: InstanceInfo[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.commands.scan(
        cursor,
        'MATCH',
        `${INSTANCE_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of keys) {
        const text = await this.commands.get(key);
        if (!text) continue;
        try {
          const info = JSON.parse(text) as {
            id: string;
            startedAt: string;
            version: string;
          };
          out.push({
            ...info,
            leader: info.id === leader,
            self: info.id === this.id,
          });
        } catch {
          /* not one of ours */
        }
      }
    } while (cursor !== '0');
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /* ----- the bus ----- */

  /** answer requests of this type. one handler per type */
  handle(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  /** tell every OTHER process; nobody is waited for */
  async publish(type: string, payload?: unknown): Promise<void> {
    await this.send({ id: randomUUID(), from: this.id, type, payload }).catch(
      () => undefined,
    );
  }

  /**
   * ask the LEADER, and wait for its answer. resolves to `undefined` when
   * nobody answered in time — there is no leader just now, which the caller has
   * to be able to live with (the work is picked up by whoever is elected next).
   * rejects with the leader's error when it refused.
   */
  askLeader<T = unknown>(
    type: string,
    payload?: unknown,
    timeoutMs = 15_000,
  ): Promise<T | undefined> {
    if (!this.commands) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({
        id,
        from: this.id,
        type,
        payload,
        reply: id,
        toLeader: true,
      }).catch(() => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(undefined);
      });
    });
  }

  private async send(message: BusMessage): Promise<void> {
    await this.commands?.publish(BUS_CHANNEL, JSON.stringify(message));
  }

  private async receive(text: string): Promise<void> {
    let message: BusMessage;
    try {
      message = JSON.parse(text) as BusMessage;
    } catch {
      return;
    }
    if (message.from === this.id) return;
    if (message.re) {
      const waiting = this.waiting.get(message.re);
      if (!waiting) return;
      this.waiting.delete(message.re);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new RemoteError(message.error));
      else waiting.resolve(message.payload);
      return;
    }
    if (message.toLeader && !this.leader) return;
    const handler = this.handlers.get(message.type);
    if (!handler) return;
    try {
      const answer = await handler(message.payload, message.from);
      if (message.reply)
        await this.send({
          id: randomUUID(),
          from: this.id,
          type: message.type,
          re: message.reply,
          payload: answer ?? null,
        });
    } catch (err) {
      if (message.reply) {
        await this.send({
          id: randomUUID(),
          from: this.id,
          type: message.type,
          re: message.reply,
          error: (err as Error).message,
        }).catch(() => undefined);
      }
    }
  }

  /* ----- locks ----- */

  /**
   * do this unless another process is doing it. returns `null` — having done
   * nothing — when the lock is held elsewhere. the lock is renewed while `work`
   * runs, and if Redis cannot be reached the work is done anyway: a lock nobody
   * can take is no reason to stop (with one process it is never contended)
   */
  async withLock<T>(
    name: string,
    work: () => Promise<T>,
    ttlMs = 60_000,
  ): Promise<T | null> {
    const key = `${LOCK_PREFIX}${name}`;
    const token = `${this.id}:${randomUUID()}`;
    let held = false;
    try {
      const won = await this.commands?.set(key, token, 'PX', ttlMs, 'NX');
      if (this.commands && won !== 'OK') return null;
      held = won === 'OK';
    } catch {
      /* Redis is away: see above */
    }
    const renew = held
      ? setInterval(
          () =>
            void this.commands
              ?.eval(RENEW, 1, key, token, String(ttlMs))
              .catch(() => undefined),
          Math.max(1000, Math.floor(ttlMs / 3)),
        )
      : null;
    renew?.unref?.();
    try {
      return await work();
    } finally {
      if (renew) clearInterval(renew);
      if (held)
        await this.commands
          ?.eval(RELEASE, 1, key, token)
          .catch(() => undefined);
    }
  }

  /* ----- for tests: a process that dies without saying goodbye ----- */

  /** stop the heartbeat and drop the connections, leaving the lease to run out */
  async crashForTest(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.subscriber?.disconnect();
    this.commands?.disconnect();
    this.subscriber = null;
    this.commands = null;
  }
}

/** what the leader answered a request with, when it refused */
export class RemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}
