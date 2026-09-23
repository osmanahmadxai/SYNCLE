/**
 * API keys, over HTTP, against the real guard: what a key may reach, what it
 * may not, and that the key itself exists in exactly one place — the answer to
 * creating it.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from './env';

applyTestEnv();

let app: any;
let base: string;
let prisma: any;
let cookie: string;

beforeAll(async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/configure-app');
  const { AuthService } = await import('../../src/auth/auth.service');
  const { PrismaService } = await import('../../src/common/prisma.service');
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  prisma = app.get(PrismaService);
  await prisma.appUser.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await app.get(AuthService).onModuleInit();

  // the operator: set up and signed in
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  expect(status.data.needsSetup).toBe(true);
  const token = (app.get(AuthService) as unknown as { setupToken: string })
    .setupToken;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'operator',
      password: 'correct horse battery staple',
      setupToken: token,
    }),
  });
  expect(setup.status, await setup.clone().text()).toBeLessThan(300);
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;
}, 120_000);

afterAll(async () => {
  await prisma?.apiKey.deleteMany({}).catch(() => undefined);
  await prisma?.appUser.deleteMany({}).catch(() => undefined);
  await app?.close().catch(() => undefined);
});

const call = (
  method: string,
  path: string,
  init: { key?: string; session?: boolean; body?: unknown } = {},
) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.session ? { cookie } : {}),
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

async function mint(
  body: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const res = await call('POST', '/api/auth/api-keys', { session: true, body });
  expect(res.status).toBe(201);
  return (await res.json()).data;
}

describe('an API key', () => {
  it('is shown once, when it is made — never in the list, never in the store', async () => {
    const created = await mint({ name: 'ci', scope: 'read' });
    expect(created.key).toMatch(/^syn_[A-Za-z0-9_-]{43}$/);
    const list = await (
      await call('GET', '/api/auth/api-keys', { session: true })
    ).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      name: 'ci',
      scope: 'read',
      prefix: created.key.slice(0, 12),
      revokedAt: null,
    });
    expect(JSON.stringify(list)).not.toContain(created.key);
    const stored = await prisma.apiKey.findMany();
    expect(JSON.stringify(stored)).not.toContain(created.key);
  });

  it('read: may GET the API, and may not change anything', async () => {
    const { key } = await mint({ name: 'dashboard', scope: 'read' });
    expect((await call('GET', '/api/bridges', { key })).status).toBe(200);
    expect((await call('GET', '/api/connections', { key })).status).toBe(200);
    expect((await call('GET', '/api/version', { key })).status).toBe(200);

    const refused = await call('POST', '/api/connections', {
      key,
      body: { name: 'x', engine: 'sqlite', database: '/tmp/x.db' },
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toMatch(
      /"dashboard" is read-only.*POST/,
    );
    expect(
      (await call('DELETE', '/api/bridges/anything', { key })).status,
    ).toBe(403);
    expect((await call('PUT', '/api/settings', { key, body: {} })).status).toBe(
      403,
    );
    // a POST that only reads is still a POST: what a read key can do is answerable by the verb
    expect(
      (await call('POST', '/api/bridges/cdc/readiness', { key, body: {} }))
        .status,
    ).toBe(403);
  });

  it('full: may do what the operator can — except anything about credentials', async () => {
    const { key } = await mint({ name: 'terraform', scope: 'full' });
    const created = await call('POST', '/api/workspaces', {
      key,
      body: { name: `it-key-${Date.now()}` },
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()).data;
    expect(
      (await call('DELETE', `/api/workspaces/${ws.id}`, { key })).status,
    ).toBeLessThan(300);

    for (const [method, path, body] of [
      ['GET', '/api/auth/api-keys', undefined],
      ['POST', '/api/auth/api-keys', { name: 'more', scope: 'full' }],
      ['DELETE', '/api/auth/api-keys/whatever', undefined],
      [
        'POST',
        '/api/auth/change-password',
        { currentPassword: 'a', newPassword: 'another long password' },
      ],
      ['POST', '/api/auth/logout', undefined],
      ['GET', '/api/auth/me', undefined],
    ] as const) {
      const res = await call(method, path, { key, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.message).toMatch(/not with an API key/);
    }
    // and no key was minted by a key
    expect(await prisma.apiKey.count({ where: { name: 'more' } })).toBe(0);
  });

  it('stops working the moment it is revoked, and when it expires', async () => {
    const live = await mint({
      name: 'short-lived',
      scope: 'read',
      expiresInDays: 1,
    });
    expect((await call('GET', '/api/bridges', { key: live.key })).status).toBe(
      200,
    );
    await prisma.apiKey.update({
      where: { id: live.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call('GET', '/api/bridges', { key: live.key })).status).toBe(
      401,
    );

    const gone = await mint({ name: 'leaked', scope: 'full' });
    expect(
      (await call('DELETE', `/api/auth/api-keys/${gone.id}`, { session: true }))
        .status,
    ).toBe(200);
    expect((await call('GET', '/api/bridges', { key: gone.key })).status).toBe(
      401,
    );
    const listed = (
      await (await call('GET', '/api/auth/api-keys', { session: true })).json()
    ).data;
    expect(listed.find((k: any) => k.id === gone.id).revokedAt).not.toBeNull();
  });

  it('is not replaced by anything that merely looks like one', async () => {
    for (const key of ['syn_', 'syn_' + 'A'.repeat(43), 'not-a-key', '']) {
      expect((await call('GET', '/api/bridges', { key })).status, key).toBe(
        401,
      );
    }
    // the metrics token is not an API key, and an API key is not the metrics token
    const { key } = await mint({ name: 'not-for-metrics', scope: 'full' });
    expect((await call('GET', '/api/metrics', { key })).status).toBe(404);
  });

  it('notes that it was used', async () => {
    const { id, key } = await mint({ name: 'seen', scope: 'read' });
    expect(
      (await prisma.apiKey.findUnique({ where: { id } })).lastUsedAt,
    ).toBeNull();
    await call('GET', '/api/bridges', { key });
    await new Promise((r) => setTimeout(r, 200));
    expect(
      (await prisma.apiKey.findUnique({ where: { id } })).lastUsedAt,
    ).not.toBeNull();
  });
});
