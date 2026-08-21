/** shared BullMQ queue plumbing for the hook services */
import { AppError } from '@syncle/core';

/**
 * fail fast with a friendly message when Redis is unreachable, instead of
 * letting an enqueue hang on BullMQ's internal reconnect loop.
 */
export async function ensureQueueReady(queue: {
  waitUntilReady(): Promise<unknown>;
}): Promise<void> {
  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000),
      ),
    ]);
  } catch {
    throw new AppError(
      'CONNECTION_FAILED',
      'The job queue (Redis) is unavailable. Start it with `docker compose up -d redis` or set REDIS_URL.',
      503,
    );
  }
}
