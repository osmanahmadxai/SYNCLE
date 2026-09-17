import { afterEach, describe, expect, it, vi } from 'vitest';

/** the module reads the environment once, when it is first imported */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  const before = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import('./runtime-config.js');
  } finally {
    for (const k of Object.keys(env)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

afterEach(() => vi.resetModules());

describe('SYNCLE_LOG_LEVEL', () => {
  it('is `warn` unless it says otherwise — what the API always logged', async () => {
    expect(
      (await load({ SYNCLE_LOG_LEVEL: undefined })).runtimeConfig.logLevel,
    ).toBe('warn');
    expect((await load({ SYNCLE_LOG_LEVEL: '' })).runtimeConfig.logLevel).toBe(
      'warn',
    );
    expect(
      (await load({ SYNCLE_LOG_LEVEL: 'chatty' })).runtimeConfig.logLevel,
    ).toBe('warn');
  });

  it('takes the five levels, in any case, and `info` for what Nest calls `log`', async () => {
    for (const level of ['error', 'warn', 'log', 'debug', 'verbose']) {
      expect(
        (await load({ SYNCLE_LOG_LEVEL: level.toUpperCase() })).runtimeConfig
          .logLevel,
      ).toBe(level);
    }
    expect(
      (await load({ SYNCLE_LOG_LEVEL: ' info ' })).runtimeConfig.logLevel,
    ).toBe('log');
  });

  it('a level includes every more serious one', async () => {
    const { logLevelsUpTo } = await load({});
    expect(logLevelsUpTo('error')).toEqual(['error']);
    expect(logLevelsUpTo('warn')).toEqual(['error', 'warn']);
    expect(logLevelsUpTo('log')).toEqual(['error', 'warn', 'log']);
    expect(logLevelsUpTo('verbose')).toEqual([
      'error',
      'warn',
      'log',
      'debug',
      'verbose',
    ]);
  });
});

describe('the metrics token and the alert throttle', () => {
  it('no token means no metrics endpoint; blanks are no token', async () => {
    expect(
      (await load({ SYNCLE_METRICS_TOKEN: undefined })).runtimeConfig
        .metricsToken,
    ).toBe('');
    expect(
      (await load({ SYNCLE_METRICS_TOKEN: '   ' })).runtimeConfig.metricsToken,
    ).toBe('');
    expect(
      (await load({ SYNCLE_METRICS_TOKEN: ' s3cret ' })).runtimeConfig
        .metricsToken,
    ).toBe('s3cret');
  });

  it('alerts are throttled for five minutes by default; 0 sends every one', async () => {
    expect(
      (await load({ SYNCLE_ALERT_THROTTLE_SECONDS: undefined })).runtimeConfig
        .alertThrottleSeconds,
    ).toBe(300);
    expect(
      (await load({ SYNCLE_ALERT_THROTTLE_SECONDS: '0' })).runtimeConfig
        .alertThrottleSeconds,
    ).toBe(0);
    expect(
      (await load({ SYNCLE_ALERT_THROTTLE_SECONDS: 'soon' })).runtimeConfig
        .alertThrottleSeconds,
    ).toBe(300);
  });
});
