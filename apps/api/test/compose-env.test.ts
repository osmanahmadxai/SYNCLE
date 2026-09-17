/**
 * The Docker install can only change a setting that docker-compose.app.yml
 * passes into the API container. For a long time it passed two, so everything
 * else — the spool, the batch sizes, the dead-letter limits — was unreachable
 * for anyone who installed Syncle the recommended way, and the docs said so.
 *
 * This keeps the two lists from drifting apart again: every environment
 * variable the API reads is either passed through, or on the short list of ones
 * the compose file deliberately sets itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.app.yml'), 'utf8');

/** set by the compose file itself, or meaningless inside the container */
const NOT_PASSED_THROUGH = new Set([
  'PORT', // fixed: the web container proxies to it
  'DATABASE_URL', // the bundled Postgres
  'REDIS_URL', // the bundled Redis
  'NODE_ENV',
  'SYNCLE_DATA_DIR', // the volume's mount point
  'SYNCLE_MASTER_KEY', // passed through, under its own comment
  'WEB_PORT', // only used to print a localhost URL in development
  'SYNCLE_HOOK_CONCURRENCY', // the pre-rename name of SYNCLE_JOB_CONCURRENCY
  'SYNCLE_VERSION', // baked into the image by its build; not something to set
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** every variable name the API's own source reads */
function variablesRead(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(resolve(__dirname, '../src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
      names.add(m[1]!);
    // runtime-config reads through env('NAME') and friends
    for (const m of text.matchAll(/(?:env|numberEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g))
      names.add(m[1]!);
  }
  return [...names].sort();
}

/** the `environment:` block of the `api` service */
function apiEnvironment(): string {
  const start = COMPOSE.indexOf('\n  api:\n');
  const end = COMPOSE.indexOf('\n  web:\n');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return COMPOSE.slice(start, end);
}

describe('docker-compose.app.yml', () => {
  it('passes every setting the API reads into the API container', () => {
    const block = apiEnvironment();
    const read = variablesRead();
    // the scan itself has to be finding things, or this test proves nothing
    expect(read).toContain('SYNCLE_CDC_SPOOL');
    expect(read.length).toBeGreaterThan(15);

    const missing = read.filter(
      (name) =>
        !NOT_PASSED_THROUGH.has(name) &&
        !block.includes(`      ${name}: \${${name}:-}`),
    );
    expect(
      missing,
      `add these to the api service's environment as NAME: \${NAME:-}`,
    ).toEqual([]);
  });

  it('passes nothing the API does not read (a typo would be silent for ever)', () => {
    const read = new Set(variablesRead());
    const passed = [
      ...apiEnvironment().matchAll(/^ {6}([A-Z][A-Z0-9_]*): \$\{\1:-\}$/gm),
    ].map((m) => m[1]!);
    expect(passed.length).toBeGreaterThan(15);
    expect(passed.filter((name) => !read.has(name))).toEqual([]);
  });

  it('never gives a passed-through setting a default of its own: the API owns the defaults', () => {
    const withDefault = [
      ...apiEnvironment().matchAll(
        /^ {6}(SYNCLE_[A-Z0-9_]*): \$\{\1:-(.+)\}$/gm,
      ),
    ].map((m) => m[1]);
    expect(withDefault).toEqual([]);
  });
});

describe('an unset setting arrives as an empty string', () => {
  const NAMES = variablesRead().filter(
    (n) => n !== 'SYNCLE_DATA_DIR' && n !== 'DATABASE_URL' && n !== 'NODE_ENV',
  );
  const saved = new Map(NAMES.map((n) => [n, process.env[n]]));

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.resetModules();
  });

  async function configWith(value: string | undefined) {
    for (const name of NAMES) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.resetModules();
    const { runtimeConfig } = await import('../src/common/runtime-config');
    return { ...runtimeConfig };
  }

  it('and means "the default" — not zero, not off, not an empty key', async () => {
    const defaults = await configWith(undefined);
    const empty = await configWith('');
    const blank = await configWith('   ');
    expect(empty).toEqual(defaults);
    expect(blank).toEqual(defaults);
    // the ones that would have hurt most: Number('') is 0
    expect(empty.cdcBatchSize).toBe(100_000);
    expect(empty.maxQueryRows).toBe(5000);
    expect(empty.poolIdleMs).toBe(300_000);
    expect(empty.jobConcurrency).toBe(5);
    expect(empty.masterKey).toBeNull();
    expect(empty.cdcSpool).toBe(false);
  });

  it('a value that is not a number falls back too, instead of becoming NaN', async () => {
    const config = await configWith('lots');
    expect(config.cdcBatchSize).toBe(100_000);
    expect(config.cdcLingerMs).toBe(50);
    expect(config.deliveryRetentionDays).toBe(30);
    expect(
      Object.values(config).filter(
        (v) => typeof v === 'number' && Number.isNaN(v),
      ),
    ).toEqual([]);
  });

  it('real values still get through', async () => {
    process.env.SYNCLE_CDC_SPOOL = 'ON';
    process.env.SYNCLE_CDC_BATCH_SIZE = '2500';
    process.env.SYNCLE_SLOT_MAX_BYTES = '0';
    process.env.SYNCLE_JOB_CONCURRENCY = '';
    process.env.SYNCLE_HOOK_CONCURRENCY = '9';
    process.env.WEB_ORIGIN = 'https://a.example, https://b.example,';
    vi.resetModules();
    const { runtimeConfig } = await import('../src/common/runtime-config');
    expect(runtimeConfig.cdcSpool).toBe(true);
    expect(runtimeConfig.cdcBatchSize).toBe(2500);
    expect(runtimeConfig.slotMaxBytes).toBe(0);
    expect(runtimeConfig.jobConcurrency).toBe(9); // the legacy name still counts
    expect(runtimeConfig.webOrigin).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
