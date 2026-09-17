/**
 * Authentication, over real HTTP, against the application exactly as production
 * configures it (configureApp). Until now the only evidence that the API was
 * protected at all was reading the code.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from './env';

applyTestEnv();

let app: any;
let base: string;
let auth: any;
let prisma: any;

const PUBLIC = new Set([
  'GET /api/health',
  'GET /api/health/ready',
  // behind a token of its own, and absent (404) until one is configured
  'GET /api/metrics',
  'GET /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  // for somebody who cannot sign in: a code is printed on the SERVER, and asked for here
  'POST /api/auth/reset/request',
  'POST /api/auth/reset',
]);

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
  auth = app.get(AuthService);
  prisma = app.get(PrismaService);
  // a fresh instance: no operator account yet (this store is the test one)
  await prisma.appUser.deleteMany({});
  await auth.onModuleInit();
}, 120_000);

afterAll(async () => {
  await prisma?.appUser.deleteMany({}).catch(() => undefined);
  await app?.close().catch(() => undefined);
});

const call = (
  method: string,
  path: string,
  init: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  });

/** every route the application registered: [METHOD, path with :params filled in] */
function routes(): Array<[string, string]> {
  const router =
    app.getHttpAdapter().getInstance()._router ??
    app.getHttpAdapter().getInstance().router;
  const found: Array<[string, string]> = [];
  for (const layer of router.stack as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (method === '_all' || method === 'options' || method === 'head')
        continue;
      found.push([
        method.toUpperCase(),
        layer.route.path.replace(/:[A-Za-z]+\??/g, 'x'),
      ]);
    }
  }
  return found;
}

describe('without a session', () => {
  it('every route answers 401, except the few that are meant to be open', async () => {
    const all = routes();
    // the walk has to be finding the API, or this proves nothing
    expect(all.length).toBeGreaterThan(40);
    expect(all.some(([m, p]) => m === 'GET' && p === '/api/connections')).toBe(
      true,
    );

    const open: string[] = [];
    for (const [method, path] of all) {
      if (PUBLIC.has(`${method} ${path}`)) continue;
      const res = await call(method, path, {
        body: method === 'GET' || method === 'DELETE' ? undefined : {},
      });
      if (res.status !== 401) open.push(`${method} ${path} -> ${res.status}`);
    }
    // a stray @Public(), or a route registered outside the guard, shows up here
    expect(open).toEqual([]);
  });

  it('the open ones say nothing they should not', async () => {
    const health = await (await call('GET', '/api/health')).json();
    expect(health).toEqual({
      data: { ok: true, checks: { database: 'ok', redis: 'ok' } },
    });
    expect(await (await call('GET', '/api/health/ready')).json()).toEqual(
      health,
    );
    // no SYNCLE_METRICS_TOKEN here: the endpoint is not there at all, with or
    // without a session, and whatever is presented as a token
    expect((await call('GET', '/api/metrics')).status).toBe(404);
    expect(
      (
        await call('GET', '/api/metrics', {
          headers: { authorization: 'Bearer ' },
        })
      ).status,
    ).toBe(404);
    const status = await (await call('GET', '/api/auth/status')).json();
    expect(status.data).toEqual({
      needsSetup: true,
      authenticated: false,
      user: null,
    });
    expect(JSON.stringify(status)).not.toMatch(/version|token/i);
  });

  it('a forged or mangled cookie is no session', async () => {
    for (const cookie of [
      'db_session=abc',
      'db_session=',
      'db_session=%%%',
      'other=1',
    ]) {
      expect((await call('GET', '/api/connections', { cookie })).status).toBe(
        401,
      );
    }
  });

  it('does not tell another origin it may read the API with credentials', async () => {
    const res = await call('GET', '/api/health', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe(
      'https://evil.example',
    );
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('setup, sign in, sign out', () => {
  let cookie = '';

  it('needs the token from the server console', async () => {
    const wrong = await call('POST', '/api/auth/setup', {
      body: {
        username: 'admin',
        password: 'correct horse battery',
        setupToken: 'nope-nope-nope',
      },
    });
    expect(wrong.status).toBe(401);

    const token = (auth as { setupToken: string }).setupToken;
    const res = await call('POST', '/api/auth/setup', {
      body: {
        username: 'admin',
        password: 'correct horse battery',
        setupToken: token,
      },
    });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^db_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // plain HTTP here: a Secure cookie would be dropped by the browser
    expect(setCookie).not.toMatch(/;\s*Secure/i);
    cookie = setCookie.split(';')[0]!;
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|correct horse/);
  });

  it('marks the cookie Secure when the browser came over HTTPS', async () => {
    const res = await call('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'correct horse battery' },
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
  });

  it('cannot be set up a second time', async () => {
    const res = await call('POST', '/api/auth/setup', {
      body: {
        username: 'intruder',
        password: 'a long enough password',
        setupToken: 'anything-at-all',
      },
    });
    expect(res.status).toBe(409);
  });

  it('the cookie opens the API, and signing out closes it', async () => {
    expect((await call('GET', '/api/auth/me', { cookie })).status).toBe(200);
    expect((await call('GET', '/api/connections', { cookie })).status).toBe(
      200,
    );
    const version = await (
      await call('GET', '/api/version', { cookie })
    ).json();
    expect(version.data.version).toMatch(/^\d+\.\d+\.\d+/);

    const out = await call('POST', '/api/auth/logout', { cookie });
    expect(out.status).toBe(201);
    expect(out.headers.get('set-cookie')).toMatch(/db_session=;/);
  });

  it('a password change ends the sessions that came before it', async () => {
    const login = await call('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'correct horse battery' },
    });
    const old = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const changed = await call('POST', '/api/auth/change-password', {
      cookie: old,
      body: {
        currentPassword: 'correct horse battery',
        newPassword: 'a different long password',
      },
    });
    expect(changed.status).toBe(201);
    const renewed = (changed.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await call('GET', '/api/auth/me', { cookie: old })).status).toBe(
      401,
    );
    expect(
      (await call('GET', '/api/auth/me', { cookie: renewed })).status,
    ).toBe(200);
  });
});

describe('a password that has been forgotten', () => {
  it('asking for a reset says nothing, and puts the code where only the operator can read it', async () => {
    const { readFileSync, existsSync, statSync } = await import('node:fs');
    const { runtimeConfig } = await import('../../src/common/runtime-config');
    const res = await call('POST', '/api/auth/reset/request');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { requested: true } });
    expect(existsSync(runtimeConfig.resetCodeFile)).toBe(true);
    // nobody but the owner
    expect(statSync(runtimeConfig.resetCodeFile).mode & 0o077).toBe(0);
    const code = readFileSync(runtimeConfig.resetCodeFile, 'utf8').trim();
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);

    const wrong = await call('POST', '/api/auth/reset', {
      body: {
        resetCode: 'not-the-code',
        newPassword: 'a different long password',
      },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const weak = await call('POST', '/api/auth/reset', {
      body: { resetCode: code, newPassword: 'short' },
    });
    expect(weak.status).toBe(400);

    // a session from before the reset
    const before = await call('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'a different long password' },
    });
    const oldCookie = (before.headers.get('set-cookie') ?? '').split(';')[0]!;

    const ok = await call('POST', '/api/auth/reset', {
      body: { resetCode: code, newPassword: 'a different long password' },
    });
    expect(ok.status).toBe(201);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await call('GET', '/api/auth/me', { cookie })).status).toBe(200);
    expect(
      (await call('GET', '/api/auth/me', { cookie: oldCookie })).status,
    ).toBe(401);
    // used: the file is gone, and the code is no good a second time
    expect(existsSync(runtimeConfig.resetCodeFile)).toBe(false);
    const again = await call('POST', '/api/auth/reset', {
      body: { resetCode: code, newPassword: 'a different long password' },
    });
    expect(again.status).toBe(401);
    expect(JSON.stringify(await ok.json())).not.toMatch(
      /passwordHash|resetCode/,
    );
  });

  it('another site cannot press the button for you, let alone use a code', async () => {
    const res = await call('POST', '/api/auth/reset/request', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('a request another site made the browser send', () => {
  // the session is a cookie, and a cookie goes wherever the browser sends a
  // request. what changes something has to come FROM the app — and a browser
  // says where a request comes from, in a header a page cannot forge
  const credentials = {
    username: 'admin',
    password: 'a different long password',
  };
  const signIn = async () => {
    const res = await call('POST', '/api/auth/login', { body: credentials });
    expect(res.status).toBe(201);
    return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  };

  it('is refused before it reaches a route — with the right password, with a valid session', async () => {
    const forged = await call('POST', '/api/auth/login', {
      body: credentials,
      headers: { origin: 'https://evil.example' },
    });
    expect(forged.status).toBe(403);
    expect((await forged.json()).error).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'cross-origin' },
    });
    expect(forged.headers.get('set-cookie')).toBeNull();

    const cookie = await signIn();
    const before = await (
      await call('GET', '/api/workspaces', { cookie })
    ).json();
    for (const origin of [
      'https://evil.example',
      'null',
      'https://127.0.0.1.evil.example',
    ]) {
      const res = await call('POST', '/api/workspaces', {
        cookie,
        body: { name: `made by ${origin}` },
        headers: { origin },
      });
      expect(res.status, origin).toBe(403);
    }
    const del = await call('DELETE', '/api/workspaces/default', {
      cookie,
      headers: { origin: 'https://evil.example' },
    });
    expect(del.status).toBe(403);
    const after = await (
      await call('GET', '/api/workspaces', { cookie })
    ).json();
    expect(after.data).toEqual(before.data);
  });

  it('from the app itself it is taken: directly, behind the web app’s proxy, or from a configured origin', async () => {
    const cookie = await signIn();
    const made: string[] = [];
    const create = async (headers: Record<string, string>) => {
      const res = await call('POST', '/api/workspaces', {
        cookie,
        body: { name: `ws-${made.length}-${Date.now()}` },
        headers,
      });
      if (res.status === 201) made.push((await res.json()).data.id);
      return res.status;
    };
    try {
      // no Origin at all: not a browser
      expect(await create({})).toBe(201);
      // the API's own origin (the browser talks to it directly)
      expect(await create({ origin: base })).toBe(201);
      // behind the web app: it forwards the browser's Origin, and says which host and scheme the browser used
      expect(
        await create({
          origin: 'https://syncle.example.com',
          'x-forwarded-host': 'syncle.example.com',
          'x-forwarded-proto': 'https',
        }),
      ).toBe(201);
      // …and only that host: the same headers do not vouch for another origin
      expect(
        await create({
          origin: 'https://evil.example',
          'x-forwarded-host': 'syncle.example.com',
          'x-forwarded-proto': 'https',
        }),
      ).toBe(403);
      // WEB_ORIGIN (its default, here)
      expect(await create({ origin: 'http://localhost:3002' })).toBe(201);
      // behind a reverse proxy that rewrites Host, the API does not know its own public name — the
      // browser does, and says so in a header no page can set
      expect(
        await create({
          origin: 'https://syncle.example.com',
          'sec-fetch-site': 'same-origin',
        }),
      ).toBe(201);
      expect(
        await create({
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        }),
      ).toBe(403);
      expect(
        await create({
          origin: 'https://sibling.example.com',
          'sec-fetch-site': 'same-site',
        }),
      ).toBe(403);
    } finally {
      for (const id of made)
        await call('DELETE', `/api/workspaces/${id}`, { cookie });
    }
  });

  it('reading is never refused for where it comes from: a GET changes nothing (CORS decides who may READ the answer)', async () => {
    const cookie = await signIn();
    const res = await call('GET', '/api/auth/me', {
      cookie,
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    // …and the answer is not one that site's page is allowed to see
    expect(res.headers.get('access-control-allow-origin')).not.toBe(
      'https://evil.example',
    );
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('what every response says about itself', () => {
  it('data: not markup, not to be framed, not to be cached — signed in or not, found or not', async () => {
    const login = await call('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'a different long password' },
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    for (const res of [
      await call('GET', '/api/health'),
      await call('GET', '/api/connections'),
      await call('GET', '/api/connections', { cookie }),
      await call('GET', '/api/no-such-route', { cookie }),
      await call('POST', '/api/auth/login', {
        body: {},
        headers: { origin: 'https://evil.example' },
      }),
    ]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-powered-by')).toBeNull();
      // plain HTTP: asking for HTTPS-only here would lock a LAN install out of itself
      expect(res.headers.get('strict-transport-security')).toBeNull();
    }
    const tls = await call('GET', '/api/health', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(tls.headers.get('strict-transport-security')).toBe(
      'max-age=15552000',
    );
  });
});

describe('guessing the password', () => {
  it('is stopped even when every attempt claims to come from somewhere new', async () => {
    // `trust proxy` makes req.ip the left-most X-Forwarded-For entry, and the
    // web proxy relays that header as the browser sent it. keyed on address
    // alone the lockout never fired: this loop could run for ever
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await call('POST', '/api/auth/login', {
        body: { username: 'admin', password: `guess-number-${i}` },
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual(Array(4).fill(429));
    const body = await (
      await call('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'x' },
        headers: { 'x-forwarded-for': '198.51.100.250' },
      })
    ).json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
