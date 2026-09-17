/**
 * The probes and the metrics endpoint, over HTTP, against the real stack.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from './env';

applyTestEnv();

let app: any;
let base: string;
const TOKEN = 'it-metrics-token';
const tokenBefore = process.env.SYNCLE_METRICS_TOKEN;

beforeAll(async () => {
  // read once, when the configuration module is first imported
  process.env.SYNCLE_METRICS_TOKEN = TOKEN;
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/configure-app');
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (tokenBefore === undefined) delete process.env.SYNCLE_METRICS_TOKEN;
  else process.env.SYNCLE_METRICS_TOKEN = tokenBefore;
});

describe('health', () => {
  it('reports the metadata store and Redis, to anyone', async () => {
    for (const path of ['/api/health', '/api/health/ready']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({
        data: { ok: true, checks: { database: 'ok', redis: 'ok' } },
      });
    }
  });

  it('with Redis gone: alive, NOT ready — and it answers instead of waiting for Redis to come back', async () => {
    const { RedisProbeService } =
      await import('../../src/observability/redis-probe.service');
    const probe = app.get(RedisProbeService);
    const real = probe.check.bind(probe);
    probe.check = async () => 'connect ECONNREFUSED';
    try {
      const alive = await fetch(`${base}/api/health`);
      expect(alive.status).toBe(200);
      expect((await alive.json()).data).toEqual({
        ok: false,
        checks: { database: 'ok', redis: 'down' },
      });
      const ready = await fetch(`${base}/api/health/ready`);
      expect(ready.status).toBe(503);
    } finally {
      probe.check = real;
    }
  });

  it('the probe itself gives up on a Redis that does not answer, quickly', async () => {
    const { RedisProbeService } =
      await import('../../src/observability/redis-probe.service');
    const before = process.env.REDIS_URL;
    const dead = new RedisProbeService();
    // a port nothing listens on. (the options are read when the probe first connects)
    const config =
      (await import('../../src/common/runtime-config')) as unknown as {
        runtimeConfig: { redisUrl: string };
      };
    const url = config.runtimeConfig.redisUrl;
    config.runtimeConfig.redisUrl = 'redis://127.0.0.1:1';
    try {
      const started = Date.now();
      const why = await dead.check();
      expect(why).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(4_000);
      // and again: asked every few seconds by a monitor, it must not pile up
      expect(await dead.check()).not.toBeNull();
    } finally {
      config.runtimeConfig.redisUrl = url;
      await dead.onModuleDestroy();
      if (before !== undefined) process.env.REDIS_URL = before;
    }
  }, 30_000);
});

describe('GET /api/metrics', () => {
  it('wants its token: no session will do, and no other token', async () => {
    expect((await fetch(`${base}/api/metrics`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/metrics`, {
          headers: { authorization: 'Bearer nope' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/metrics`, {
          headers: { authorization: `Basic ${TOKEN}` },
        })
      ).status,
    ).toBe(401);
    const refused = await fetch(`${base}/api/metrics`);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(await refused.text()).not.toContain('syncle_');
  });

  it('answers in the Prometheus text format, not the API’s JSON envelope', async () => {
    const res = await fetch(`${base}/api/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const type = res.headers.get('content-type') ?? '';
    expect(type.startsWith('text/plain')).toBe(true);
    expect(type).toContain('version=0.0.4');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text.startsWith('# HELP syncle_build_info')).toBe(true);
    expect(text).toMatch(/^syncle_build_info\{version="[^"]+"\} 1$/m);
    expect(text).toMatch(/^syncle_up\{component="database"\} 1$/m);
    expect(text).toMatch(/^syncle_up\{component="redis"\} 1$/m);
    expect(text).toMatch(/^syncle_deliveries_total\{status="success"\} \d+$/m);
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m);
    expect(text).toMatch(/^nodejs_eventloop_lag_p99_seconds [\d.e-]+$/m);

    // every line is a comment or `name{labels} number`: one malformed line and a scraper drops the lot
    for (const line of text.trimEnd().split('\n')) {
      expect(line, line).toMatch(
        /^(# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+|[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? (NaN|[+-]Inf|-?[\d.e+-]+))$/,
      );
    }
  });

  it('counts what is in the store: bridges by trigger, jobs by status, rows waiting in a dead-letter queue', async () => {
    const { PrismaService } = await import('../../src/common/prisma.service');
    const { randomUUID } = await import('node:crypto');
    const prisma = app.get(PrismaService);
    const ws = await prisma.workspace.findFirst();
    const bridgeId = randomUUID();
    const jobId = randomUUID();
    await prisma.bridge.create({
      data: {
        id: bridgeId,
        name: 'metrics "quoted"\nbridge',
        workspaceId: ws.id,
        connectionId: 'none',
        sourceJson: '{}',
        destinationJson: '{}',
        transformJson: '{}',
        deliveryJson: '{}',
        triggerJson: JSON.stringify({ kind: 'cdc', operations: ['insert'] }),
        enabled: false,
      },
    });
    try {
      await prisma.bridgeJob.create({
        data: {
          id: jobId,
          bridgeId,
          status: 'paused',
          configSnapshotJson: '{}',
          sentCount: 5,
          failedCount: 2,
        },
      });
      await prisma.bridgeDeadLetter.create({
        data: {
          id: randomUUID(),
          bridgeId,
          jobId,
          sequence: 0,
          rowsJson: '[]',
          rowCount: 3,
          cursor: 'c',
          error: 'e',
        },
      });
      const text = await (
        await fetch(`${base}/api/metrics`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).text();
      expect(text).toMatch(
        /^syncle_bridges\{trigger="cdc",enabled="false"\} [1-9]\d*$/m,
      );
      expect(text).toMatch(/^syncle_jobs\{status="paused"\} [1-9]\d*$/m);
      // the bridge's name, with everything that could break out of the label escaped
      expect(text).toContain(
        `syncle_dead_letter_rows{bridge_id="${bridgeId}",bridge="metrics \\"quoted\\"\\nbridge"} 3`,
      );
      const failed = Number(
        /^syncle_deliveries_total\{status="failed"\} (\d+)$/m.exec(text)![1],
      );
      expect(failed).toBeGreaterThanOrEqual(2);
    } finally {
      await prisma.bridge
        .delete({ where: { id: bridgeId } })
        .catch(() => undefined);
    }
  });
});
