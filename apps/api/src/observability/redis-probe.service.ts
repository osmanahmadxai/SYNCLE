/**
 * "is Redis there?", asked on a connection of its own.
 *
 * The job queue's connection retries for ever and queues commands while it is
 * down (that is what a queue wants), so a PING on it does not fail when Redis
 * is gone — it waits. This one does not queue and does not wait.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { redisConnectionOptions } from '../common/runtime-config';

const PROBE_TIMEOUT_MS = 1_500;

@Injectable()
export class RedisProbeService implements OnModuleDestroy {
  private client: Redis | null = null;

  private connection(): Redis {
    if (this.client) return this.client;
    const client = new Redis({
      ...redisConnectionOptions(),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: PROBE_TIMEOUT_MS,
      // keep trying in the background, slowly: a probe is asked again and again
      retryStrategy: (times) => Math.min(5_000, 250 * times),
    });
    // an 'error' event with no listener takes the process down
    client.on('error', () => undefined);
    this.client = client;
    return client;
  }

  /** null when Redis answered; otherwise why it did not */
  async check(): Promise<string | null> {
    const client = this.connection();
    let timer: NodeJS.Timeout | undefined;
    try {
      const ping = (async () => {
        if (client.status === 'wait' || client.status === 'end')
          await client.connect();
        return client.ping();
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS} ms`)),
          PROBE_TIMEOUT_MS,
        );
      });
      const pong = await Promise.race([ping, timeout]);
      return pong === 'PONG' ? null : `unexpected answer: ${String(pong)}`;
    } catch (err) {
      return (err as Error).message || 'unreachable';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
  }
}
