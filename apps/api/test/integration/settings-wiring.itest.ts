/**
 * Settings that were stored, shown in the dialog and reported by the API — and
 * that nothing read. Each is checked here against the running application, at
 * the point where it has to take effect.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapApp, type AppHandle } from './app-harness';

let app: AppHandle;
let settings: any;
let processor: any;

beforeAll(async () => {
  app = await bootstrapApp();
  const { SettingsStoreService } =
    await import('../../src/settings/settings-store.service');
  const { BridgeJobProcessor } =
    await import('../../src/bridges/bridge-job.processor');
  settings = app.ctx.get(SettingsStoreService);
  processor = app.ctx.get(BridgeJobProcessor);
}, 120_000);

afterAll(async () => {
  await settings?.update({ jobConcurrency: 5 }).catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

describe('job concurrency', () => {
  it('is what the worker actually runs with, and follows a change without a restart', async () => {
    await settings.update({ jobConcurrency: 3 });
    expect(processor.worker.concurrency).toBe(3);
    await settings.update({ jobConcurrency: 11 });
    expect(processor.worker.concurrency).toBe(11);
  });

  it('rejects a value the worker could not run with', async () => {
    await expect(settings.update({ jobConcurrency: 0 })).rejects.toThrow();
    expect(processor.worker.concurrency).toBe(11);
  });
});

describe('settings listeners', () => {
  it('are told the current settings at once, and again on every change', async () => {
    const seen: number[] = [];
    const stop = settings.onChange((s: { jobConcurrency: number }) =>
      seen.push(s.jobConcurrency),
    );
    await new Promise((r) => setTimeout(r, 20));
    await settings.update({ jobConcurrency: 7 });
    stop();
    await settings.update({ jobConcurrency: 8 });
    expect(seen).toEqual([11, 7]);
  });

  it('one that throws does not stop a save, or the others', async () => {
    const seen: number[] = [];
    const stopBad = settings.onChange(() => {
      throw new Error('listener bug');
    });
    const stopGood = settings.onChange((s: { jobConcurrency: number }) =>
      seen.push(s.jobConcurrency),
    );
    await new Promise((r) => setTimeout(r, 20));
    await expect(settings.update({ jobConcurrency: 9 })).resolves.toMatchObject(
      { jobConcurrency: 9 },
    );
    expect(seen.at(-1)).toBe(9);
    stopBad();
    stopGood();
  });
});

describe('a connection to an engine this build has no driver for', () => {
  it('is refused when it is saved, not on every use afterwards', async () => {
    const attempt = app.connections.create({
      name: 'it-phantom',
      engine: 'mssql',
      host: 'x',
      port: 1433,
    });
    await expect(attempt).rejects.toThrow(/no driver for "mssql"/);
  });
});
