/**
 * live adapter cache. opening a database connection is expensive, so one
 * adapter instance per saved connection is kept alive across requests and
 * evicted after a period of inactivity
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createAdapter } from '@syncle/core/adapters';
import { runtimeConfig } from '../common/runtime-config';
import type { ConnectionConfig, DatabaseAdapter } from '@syncle/core';
import { SettingsStoreService } from '../settings/settings-store.service';
import { ConnectionStoreService } from './connection-store.service';

interface PoolEntry {
  adapter: DatabaseAdapter;
  revision: string;
  lastUsedAt: number;
}

@Injectable()
export class AdapterPoolService implements OnModuleDestroy {
  private readonly entries = new Map<string, PoolEntry>();
  /** in-flight opens, so concurrent requests share one connect instead of leaking */
  private readonly pending = new Map<string, Promise<DatabaseAdapter>>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly store: ConnectionStoreService,
    private readonly settings: SettingsStoreService,
  ) {
    // fixed sweep cadence; the idle threshold itself is read live from settings
    // each sweep, so changing it in the UI takes effect without a restart
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweepTimer);
    await Promise.all(
      [...this.entries.values()].map((e) => e.adapter.close().catch(() => {})),
    );
    this.entries.clear();
  }

  private sweep(): void {
    const now = Date.now();
    const idleMs = this.settings.snapshot().poolIdleMs;
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > idleMs) {
        void entry.adapter.close().catch(() => {});
        this.entries.delete(id);
      }
    }
  }

  /**
   * acquire an adapter for a connection, optionally bound to a specific
   * database. engines like PostgreSQL bind a connection to a single database,
   * so switching databases means a distinct adapter, so we cache one
   * adapter per `(connection, database)` pair
   */
  private async acquire(
    id: string,
    database?: string,
  ): Promise<DatabaseAdapter> {
    const config = await this.store.resolve(id);
    const effectiveDb = database || config.database;
    const key = `${id}::${effectiveDb ?? ''}`;
    const existing = this.entries.get(key);

    if (existing && existing.revision === config.updatedAt) {
      existing.lastUsedAt = Date.now();
      return existing.adapter;
    }

    // join an in-flight open instead of racing it: two concurrent misses would
    // otherwise both connect and the loser's adapter would leak unreferenced
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const open = this.open(key, { ...config, database: effectiveDb }).finally(
      () => this.pending.delete(key),
    );
    this.pending.set(key, open);
    return open;
  }

  private async open(
    key: string,
    config: ConnectionConfig,
  ): Promise<DatabaseAdapter> {
    const stale = this.entries.get(key);
    if (stale) {
      this.entries.delete(key);
      await stale.adapter.close().catch(() => {});
    }
    const adapter = createAdapter(withServerRestrictions(config));
    await adapter.connect();
    this.entries.set(key, {
      adapter,
      revision: config.updatedAt,
      lastUsedAt: Date.now(),
    });
    return adapter;
  }

  /**
   * run an operation against the live adapter for a connection, optionally
   * targeting a specific database
   */
  async withAdapter<T>(
    id: string,
    database: string | undefined,
    fn: (adapter: DatabaseAdapter) => Promise<T>,
  ): Promise<T> {
    return fn(await this.acquire(id, database));
  }

  /** build a one-off adapter from a raw config (used by "test connection") */
  async test(config: ConnectionConfig): Promise<void> {
    const adapter = createAdapter(withServerRestrictions(config));
    try {
      await adapter.connect();
      await adapter.ping();
    } finally {
      await adapter.close().catch(() => {});
    }
  }

  /**
   * evict (and close) every adapter for a connection, across all databases,
   * after the connection is edited or deleted
   */
  async evict(id: string): Promise<void> {
    const prefix = `${id}::`;
    // settle in-flight opens first so their adapters can't escape the evict
    const opening = [...this.pending.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, p]) => p.catch(() => {}));
    await Promise.all(opening);

    const targets = [...this.entries.entries()].filter(([key]) =>
      key.startsWith(prefix),
    );
    for (const [key] of targets) this.entries.delete(key);
    await Promise.all(
      targets.map(([, entry]) => entry.adapter.close().catch(() => {})),
    );
  }
}

/**
 * server-side config restrictions applied to every adapter, whatever store
 * the config came from: the SQLite path jail (SYNCLE_SQLITE_DIR) must not be
 * bypassable by anything a client can persist.
 */
function withServerRestrictions<T extends { engine: string }>(config: T): T {
  if (config.engine === 'sqlite' && runtimeConfig.sqliteBaseDir) {
    return { ...config, fileBaseDir: runtimeConfig.sqliteBaseDir };
  }
  return config;
}
