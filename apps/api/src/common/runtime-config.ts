/** server runtime config, resolved once from the environment */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveDataDir(): string {
  const dir = process.env.SYNCLE_DATA_DIR
    ? resolve(process.env.SYNCLE_DATA_DIR)
    : resolve(process.cwd(), '.syncle');
  // 0o700: the dir holds the master key, keep it out of reach of other users
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const dataDir = resolveDataDir();

export const runtimeConfig = {
  dataDir,
  storeFile: resolve(dataDir, 'syncle.db'),
  keyFile: resolve(dataDir, 'master.key'),
  masterKey: process.env.SYNCLE_MASTER_KEY ?? null,
  maxQueryRows: Number(process.env.SYNCLE_MAX_QUERY_ROWS ?? 5000),
  poolIdleMs: Number(process.env.SYNCLE_POOL_IDLE_MS ?? 300_000),
  port: Number(process.env.PORT ?? 4000),
  // never fall back to reflecting arbitrary origins: with credentialed CORS
  // that would let any web page the operator visits call this API
  webOrigin: process.env.WEB_ORIGIN
    ? process.env.WEB_ORIGIN.split(',').map((o) => o.trim())
    : `http://localhost:${process.env.WEB_PORT ?? '3002'}`,
  /** Redis URL backing the BullMQ bridge-job queue */
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /**
   * worker concurrency: how many bridge jobs may run in parallel.
   * SYNCLE_HOOK_CONCURRENCY is the legacy name (transition) — still honored
   * so existing deployments keep their setting across the rename.
   */
  jobConcurrency: Number(
    process.env.SYNCLE_JOB_CONCURRENCY ?? process.env.SYNCLE_HOOK_CONCURRENCY ?? 5,
  ),
  /**
   * when true, HTTP destinations may not resolve to loopback/private/link-local
   * addresses (SSRF guard for network-exposed deployments). off by default —
   * Syncle is local-first and posting to localhost services is a primary use.
   * cloud metadata endpoints are blocked regardless of this flag.
   */
  blockPrivateDestinations:
    (process.env.SYNCLE_BLOCK_PRIVATE_DESTINATIONS ?? '') === 'true',
  /** when set, SQLite connections may only open files under this directory */
  sqliteBaseDir: process.env.SYNCLE_SQLITE_DIR
    ? resolve(process.env.SYNCLE_SQLITE_DIR)
    : null,
} as const;

/**
 * parse {@link runtimeConfig.redisUrl} into ioredis connection options for
 * BullMQ. `maxRetriesPerRequest: null` is required by BullMQ's blocking
 * connections. ioredis still reconnects in the background, so a missing Redis
 * never crashes bootstrap, only enqueuing a run fails (with a clear message)
 */
export function redisConnectionOptions(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  maxRetriesPerRequest: null;
} {
  const u = new URL(runtimeConfig.redisUrl);
  const db = u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  return {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null,
  };
}
