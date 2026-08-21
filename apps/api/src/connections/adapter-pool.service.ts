/**
 * live adapter cache. opening a database connection is expensive, so one
 * adapter instance per saved connection is kept alive across requests and
 * evicted after a period of inactivity. connections that tunnel through SSH
 * keep their tunnel alongside the adapter: it opens before the adapter
 * connects and closes with it
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createAdapter } from '@syncle/core/adapters';
import { runtimeConfig } from '../common/runtime-config';
import type { ConnectionConfig, DatabaseAdapter } from '@syncle/core';
import { SettingsStoreService } from '../settings/settings-store.service';
import { ConnectionStoreService } from './connection-store.service';
import { SshTunnelService, type SshTunnel } from './ssh-tunnel.service';

interface PoolEntry {
  adapter: DatabaseAdapter;
  /** the SSH tunnel the adapter dials through, when the config asks for one */
  tunnel?: SshTunnel;
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
    private readonly tunnels: SshTunnelService,
  ) {
    // fixed sweep cadence; the idle threshold itself is read live from settings
    // each sweep, so changing it in the UI takes effect without a restart
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweepTimer);
    await Promise.all(
      [...this.entries.values()].map((e) => this.closeEntry(e)),
    );
    this.entries.clear();
  }

  /** close an entry's adapter, then the tunnel it was dialing through */
  private async closeEntry(entry: PoolEntry): Promise<void> {
    await entry.adapter.close().catch(() => {});
    await entry.tunnel?.close().catch(() => {});
  }

  private sweep(): void {
    const now = Date.now();
    const idleMs = this.settings.snapshot().poolIdleMs;
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > idleMs) {
        void this.closeEntry(entry);
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
      await this.closeEntry(stale);
    }
    const restricted = withServerRestrictions(config);
    const tunnel = await this.tunnels.openFor(restricted);
    const adapter = createAdapter(this.tunnels.reroute(restricted, tunnel));
    try {
      await adapter.connect();
    } catch (err) {
      // a refused forward reaches the adapter as a bare socket reset; the
      // ssh-level failure recorded on the tunnel is the real story
      const sshErr = tunnel?.takeError();
      await adapter.close().catch(() => {});
      await tunnel?.close().catch(() => {});
      throw sshErr ?? err;
    }
    // if the ssh connection drops mid-use, evict so the next use redials
    tunnel?.onClose(() => {
      const entry = this.entries.get(key);
      if (entry?.tunnel !== tunnel) return;
      this.entries.delete(key);
      void entry.adapter.close().catch(() => {});
    });
    this.entries.set(key, {
      adapter,
      tunnel,
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
    const restricted = withServerRestrictions(config);
    const tunnel = await this.tunnels.openFor(restricted);
    const adapter = createAdapter(this.tunnels.reroute(restricted, tunnel));
    try {
      await adapter.connect();
      await adapter.ping();
    } catch (err) {
      // surface the ssh-level failure (e.g. refused forward) over the bare
      // socket error the adapter saw
      throw tunnel?.takeError() ?? err;
    } finally {
      await adapter.close().catch(() => {});
      await tunnel?.close().catch(() => {});
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
    await Promise.all(targets.map(([, entry]) => this.closeEntry(entry)));
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
