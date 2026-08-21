/**
 * global application settings, persisted as a key/value table and layered over
 * the process defaults from {@link runtimeConfig}. reads are cached in-process
 * and refreshed on write, so hot paths (session TTL, query caps) don't hit the
 * database each time.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  appSettingsSchema,
  type AppSettings,
  type AppSettingsDTO,
} from '@syncle/core';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';

const SETTINGS_KEY = 'app';

@Injectable()
export class SettingsStoreService implements OnModuleInit {
  private readonly logger = new Logger('Settings');
  private cache: AppSettings | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // warm the cache on boot so the sync snapshot() has real values immediately
  async onModuleInit(): Promise<void> {
    await this.resolved().catch(() => undefined);
  }

  /**
   * the current settings without awaiting the DB — the warmed cache, or the
   * built-in defaults before the first load. for hot, non-async call sites like
   * the adapter-pool sweep. use {@link resolved} when a fresh read is fine.
   */
  snapshot(): AppSettings {
    return this.cache ?? this.defaults();
  }

  /** built-in defaults, sourced from the environment/runtime config */
  private defaults(): AppSettings {
    return {
      defaultPollIntervalMs: 5000,
      defaultMaxPerPoll: 500,
      defaultCdcOperations: ['insert', 'update', 'delete'],
      maxQueryRows: runtimeConfig.maxQueryRows,
      poolIdleMs: runtimeConfig.poolIdleMs,
      jobConcurrency: runtimeConfig.jobConcurrency,
      sessionTtlMinutes: 60 * 24 * 7, // one week
    };
  }

  /** fully-resolved settings: stored overrides merged onto the defaults */
  async resolved(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const overrides = await this.readOverrides();
    this.cache = { ...this.defaults(), ...overrides };
    return this.cache;
  }

  /** apply a partial update, validate, persist, and refresh the cache */
  async update(patch: AppSettingsDTO): Promise<AppSettings> {
    const clean = appSettingsSchema.parse(patch);
    const current = await this.readOverrides();
    // drop keys explicitly set back to undefined so they fall through to defaults
    const merged: AppSettingsDTO = { ...current };
    for (const [k, v] of Object.entries(clean)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
    await this.prisma.appSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: { valueJson: JSON.stringify(merged) },
      create: { key: SETTINGS_KEY, valueJson: JSON.stringify(merged) },
    });
    this.cache = { ...this.defaults(), ...merged };
    return this.cache;
  }

  private async readOverrides(): Promise<AppSettingsDTO> {
    const row = await this.prisma.appSetting
      .findUnique({ where: { key: SETTINGS_KEY } })
      .catch(() => null);
    if (!row) return {};
    try {
      return appSettingsSchema.parse(JSON.parse(row.valueJson));
    } catch (err) {
      this.logger.warn(`Ignoring corrupt settings row: ${(err as Error).message}`);
      return {};
    }
  }
}
