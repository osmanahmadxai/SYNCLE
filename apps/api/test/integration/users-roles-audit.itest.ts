/**
 * More than one account, each with a role — and the audit log that says who did
 * what. Over real HTTP, against the application exactly as production
 * configures it, so that what is asserted is what a person at a browser gets.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from './env';

applyTestEnv();

let app: any;
let base: string;
let prisma: any;
let startedAt: Date;
const cookies: Record<string, string> = {};
const passwords: Record<string, string> = {
  root: 'the first admin password',
  ops: 'an operator password',
  eye: 'a viewer password',
};
const made: { connections: string[] } = { connections: [] };

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

const cookieOf = (res: Response) =>
  (res.headers.get('set-cookie') ?? '').split(';')[0]!;
const data = async (res: Response) =>
  ((await res.json()) as { data: unknown }).data;

async function login(
  username: string,
  password = passwords[username]!,
): Promise<string> {
  const res = await call('POST', '/api/auth/login', {
    body: { username, password },
  });
  expect(res.status, `login ${username}`).toBe(201);
  return cookieOf(res);
}

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
  startedAt = new Date();
  await prisma.appUser.deleteMany({});
  const auth = app.get(AuthService);
  await auth.onModuleInit();
  const token = (auth as { setupToken: string }).setupToken;
  const setup = await call('POST', '/api/auth/setup', {
    body: { username: 'root', password: passwords.root, setupToken: token },
  });
  expect(setup.status).toBe(201);
  cookies.root = cookieOf(setup);
}, 120_000);

afterAll(async () => {
  for (const id of made.connections)
    await call('DELETE', `/api/connections/${id}`, {
      cookie: cookies.root,
    }).catch(() => undefined);
  await prisma?.appUser.deleteMany({}).catch(() => undefined);
  await prisma?.auditEntry
    .deleteMany({ where: { at: { gte: startedAt } } })
    .catch(() => undefined);
  await app?.close().catch(() => undefined);
});

describe('accounts', () => {
  it('the first account is an admin, and knows it', async () => {
    const me = await data(
      await call('GET', '/api/auth/me', { cookie: cookies.root }),
    );
    expect(me).toMatchObject({ username: 'root', role: 'admin' });
    expect(JSON.stringify(me)).not.toMatch(/passwordHash|resetCode/);
  });

  it('an admin makes more — an operator, a viewer — and each can sign in as what it is', async () => {
    const ops = await call('POST', '/api/auth/users', {
      cookie: cookies.root,
      body: { username: 'ops', password: passwords.ops, role: 'operator' },
    });
    expect(ops.status).toBe(201);
    expect(await data(ops)).toMatchObject({
      username: 'ops',
      role: 'operator',
      disabledAt: null,
    });
    const eye = await call('POST', '/api/auth/users', {
      cookie: cookies.root,
      body: { username: 'eye', password: passwords.eye, role: 'viewer' },
    });
    expect(eye.status).toBe(201);
    cookies.ops = await login('ops');
    cookies.eye = await login('eye');
    expect(
      await data(await call('GET', '/api/auth/me', { cookie: cookies.ops })),
    ).toMatchObject({ role: 'operator' });
    expect(
      await data(await call('GET', '/api/auth/me', { cookie: cookies.eye })),
    ).toMatchObject({ role: 'viewer' });
    // and are listed, with when they last signed in
    const list = (await data(
      await call('GET', '/api/auth/users', { cookie: cookies.root }),
    )) as Array<Record<string, unknown>>;
    expect(list.map((u) => u.username)).toEqual(['root', 'ops', 'eye']);
    for (const name of ['root', 'ops', 'eye'])
      expect(list.find((u) => u.username === name)!.lastLoginAt, name).toEqual(
        expect.any(String),
      );
    // (root's is from the setup itself: it signed them in)
  });

  it('a name that is taken is refused; a weak password too', async () => {
    const dup = await call('POST', '/api/auth/users', {
      cookie: cookies.root,
      body: {
        username: 'ops',
        password: 'another good password',
        role: 'viewer',
      },
    });
    expect(dup.status).toBe(409);
    const weak = await call('POST', '/api/auth/users', {
      cookie: cookies.root,
      body: { username: 'new', password: 'short', role: 'viewer' },
    });
    expect(weak.status).toBe(400);
  });
});

describe('what each role may do', () => {
  const connection = {
    name: 'it-roles-conn',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_test',
  };

  it('a viewer looks, and changes nothing but their own password', async () => {
    expect(
      (await call('GET', '/api/bridges', { cookie: cookies.eye })).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/connections', { cookie: cookies.eye })).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/settings', { cookie: cookies.eye })).status,
    ).toBe(200);
    const refused = await call('POST', '/api/connections', {
      cookie: cookies.eye,
      body: connection,
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toMatch(/viewer/);
    expect(
      (
        await call('PUT', '/api/settings', {
          cookie: cookies.eye,
          body: { maxQueryRows: 500 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', '/api/auth/users', { cookie: cookies.eye })).status,
    ).toBe(403);
    expect(
      (await call('GET', '/api/audit', { cookie: cookies.eye })).status,
    ).toBe(403);
    // their own password: yes — and it ends the sessions that came before, this one included
    const changed = await call('POST', '/api/auth/change-password', {
      cookie: cookies.eye,
      body: {
        currentPassword: passwords.eye,
        newPassword: 'a viewer password 2',
      },
    });
    expect(changed.status).toBe(201);
    passwords.eye = 'a viewer password 2';
    cookies.eye = cookieOf(changed);
    expect(
      (await call('GET', '/api/auth/me', { cookie: cookies.eye })).status,
    ).toBe(200);
  });

  it('an operator does the work, and nothing that is an admin’s', async () => {
    const created = await call('POST', '/api/connections', {
      cookie: cookies.ops,
      body: connection,
    });
    expect(created.status).toBe(201);
    made.connections.push(((await data(created)) as { id: string }).id);
    const settings = await call('PUT', '/api/settings', {
      cookie: cookies.ops,
      body: { maxQueryRows: 500 },
    });
    expect(settings.status).toBe(403);
    expect(JSON.stringify(await settings.json())).toMatch(/admin role/);
    expect(
      (await call('GET', '/api/auth/users', { cookie: cookies.ops })).status,
    ).toBe(403);
    expect(
      (await call('GET', '/api/auth/api-keys', { cookie: cookies.ops })).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/api/auth/api-keys', {
          cookie: cookies.ops,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', '/api/audit', { cookie: cookies.ops })).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/api/workspaces', {
          cookie: cookies.ops,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/api/alerts/channels', {
          cookie: cookies.ops,
          body: {},
        })
      ).status,
    ).toBe(403);
  });

  it('an admin does everything', async () => {
    const before = (await data(
      await call('GET', '/api/settings', { cookie: cookies.root }),
    )) as { maxQueryRows: number };
    const settings = await call('PUT', '/api/settings', {
      cookie: cookies.root,
      body: { maxQueryRows: before.maxQueryRows },
    });
    expect(settings.status).toBe(200);
    expect(
      (await call('GET', '/api/audit', { cookie: cookies.root })).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/auth/api-keys', { cookie: cookies.root }))
        .status,
    ).toBe(200);
  });
});

describe('the last admin', () => {
  it('cannot be demoted, disabled or deleted; once another admin exists it can — and nobody deletes their own account', async () => {
    const users = (await data(
      await call('GET', '/api/auth/users', { cookie: cookies.root }),
    )) as Array<{ id: string; username: string }>;
    const id = Object.fromEntries(users.map((u) => [u.username, u.id]));
    for (const body of [{ role: 'operator' }, { disabled: true }]) {
      const res = await call('PUT', `/api/auth/users/${id.root}`, {
        cookie: cookies.root,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/only admin/);
    }
    expect(
      (
        await call('DELETE', `/api/auth/users/${id.root}`, {
          cookie: cookies.root,
        })
      ).status,
    ).toBe(400);

    // promote the operator: now the first admin may step down
    expect(
      (
        await call('PUT', `/api/auth/users/${id.ops}`, {
          cookie: cookies.root,
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PUT', `/api/auth/users/${id.root}`, {
          cookie: cookies.root,
          body: { role: 'operator' },
        })
      ).status,
    ).toBe(200);
    // …and is one at once, without signing in again
    expect(
      (await call('GET', '/api/auth/users', { cookie: cookies.root })).status,
    ).toBe(403);
    expect(
      await data(await call('GET', '/api/auth/me', { cookie: cookies.root })),
    ).toMatchObject({ role: 'operator' });
    // the new admin puts it back (and cannot delete themselves)
    expect(
      (
        await call('DELETE', `/api/auth/users/${id.ops}`, {
          cookie: cookies.ops,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PUT', `/api/auth/users/${id.root}`, {
          cookie: cookies.ops,
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PUT', `/api/auth/users/${id.ops}`, {
          cookie: cookies.root,
          body: { role: 'operator' },
        })
      ).status,
    ).toBe(200);
  });
});

describe('a disabled account, and sessions that are ended', () => {
  it('a disabled account is out at once, cannot sign in, and is back when enabled', async () => {
    const users = (await data(
      await call('GET', '/api/auth/users', { cookie: cookies.root }),
    )) as Array<{ id: string; username: string }>;
    const eye = users.find((u) => u.username === 'eye')!.id;
    const off = await call('PUT', `/api/auth/users/${eye}`, {
      cookie: cookies.root,
      body: { disabled: true },
    });
    expect(off.status).toBe(200);
    expect(await data(off)).toMatchObject({ disabledAt: expect.any(String) });
    expect(
      (await call('GET', '/api/auth/me', { cookie: cookies.eye })).status,
    ).toBe(401);
    const refused = await call('POST', '/api/auth/login', {
      body: { username: 'eye', password: passwords.eye },
    });
    expect(refused.status).toBe(401);
    expect(JSON.stringify(await refused.json())).toMatch(/disabled/);
    expect(
      (
        await call('PUT', `/api/auth/users/${eye}`, {
          cookie: cookies.root,
          body: { disabled: false },
        })
      ).status,
    ).toBe(200);
    cookies.eye = await login('eye');
  });

  it('ending an account’s sessions signs it out everywhere; a password set by an admin does too', async () => {
    const users = (await data(
      await call('GET', '/api/auth/users', { cookie: cookies.root }),
    )) as Array<{ id: string; username: string }>;
    const ops = users.find((u) => u.username === 'ops')!.id;
    expect(
      (
        await call('POST', `/api/auth/users/${ops}/sessions/end`, {
          cookie: cookies.root,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/auth/me', { cookie: cookies.ops })).status,
    ).toBe(401);
    cookies.ops = await login('ops');
    expect(
      (
        await call('PUT', `/api/auth/users/${ops}`, {
          cookie: cookies.root,
          body: { newPassword: 'set by the admin' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/auth/me', { cookie: cookies.ops })).status,
    ).toBe(401);
    expect(
      (
        await call('POST', '/api/auth/login', {
          body: { username: 'ops', password: passwords.ops },
        })
      ).status,
    ).toBe(401);
    passwords.ops = 'set by the admin';
    cookies.ops = await login('ops');
  });
});

describe('a password that has been forgotten, with more than one account', () => {
  it('the code is for the account that was named — and, unnamed, for the first admin', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { runtimeConfig } = await import('../../src/common/runtime-config');
    expect(
      (
        await call('POST', '/api/auth/reset/request', {
          body: { username: 'ops' },
        })
      ).status,
    ).toBe(202);
    const code = readFileSync(runtimeConfig.resetCodeFile, 'utf8').trim();
    const reset = await call('POST', '/api/auth/reset', {
      body: { resetCode: code, newPassword: 'reset by code' },
    });
    expect(reset.status).toBe(201);
    expect(await data(reset)).toMatchObject({
      username: 'ops',
      role: 'operator',
    });
    passwords.ops = 'reset by code';
    cookies.ops = await login('ops');
    expect(existsSync(runtimeConfig.resetCodeFile)).toBe(false);

    // a name nobody has: nothing is made, and nothing is said
    expect(
      (
        await call('POST', '/api/auth/reset/request', {
          body: { username: 'nobody' },
        })
      ).status,
    ).toBe(202);
    expect(existsSync(runtimeConfig.resetCodeFile)).toBe(false);

    // unnamed: the first admin's (the way it was before there were roles)
    expect(
      (await call('POST', '/api/auth/reset/request', { body: {} })).status,
    ).toBe(202);
    const rootCode = readFileSync(runtimeConfig.resetCodeFile, 'utf8').trim();
    const rootReset = await call('POST', '/api/auth/reset', {
      body: { resetCode: rootCode, newPassword: passwords.root },
    });
    expect(rootReset.status).toBe(201);
    expect(await data(rootReset)).toMatchObject({ username: 'root' });
    cookies.root = cookieOf(rootReset);
  });
});

describe('the audit log', () => {
  const list = async (query = '') =>
    (await data(
      await call('GET', `/api/audit${query}`, { cookie: cookies.root }),
    )) as {
      entries: Array<{
        id: string;
        at: string;
        actor: { type: string; id: string | null; name: string };
        action: string;
        target: { type: string; id: string | null; name: string | null } | null;
        details: Record<string, unknown> | null;
        ip: string | null;
      }>;
      next: string | null;
    };

  it('says who did what, to what, from where — sign-ins included, failed ones too', async () => {
    expect(
      (
        await call('POST', '/api/auth/login', {
          body: { username: 'ops', password: 'wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call('POST', '/api/auth/login', {
          body: { username: 'nobody', password: 'wrong' },
        })
      ).status,
    ).toBe(401);
    const all = (await list('?limit=200')).entries;
    const actions = all.map((e) => e.action);
    for (const expected of [
      'auth.setup',
      'user.create',
      'auth.login',
      'auth.login_failed',
      'auth.password_changed',
      'connection.create',
      'settings.update',
      'user.update',
      'user.sessions_ended',
      'auth.reset_requested',
      'auth.password_reset',
    ])
      expect(actions, expected).toContain(expected);

    const made = all.find((e) => e.action === 'connection.create')!;
    expect(made.actor).toEqual({
      type: 'user',
      id: expect.any(String),
      name: 'ops',
    });
    expect(made.target).toEqual({
      type: 'connection',
      id: expect.any(String),
      name: 'it-roles-conn',
    });
    expect(made.details).toEqual({ engine: 'postgres' });
    expect(made.ip).toEqual(expect.any(String));
    // nothing of the connection's credentials
    expect(JSON.stringify(made)).not.toMatch(/syncle:|password/);

    const failed = all.filter((e) => e.action === 'auth.login_failed');
    expect(failed.map((e) => e.actor.name)).toEqual(
      expect.arrayContaining(['ops', 'nobody']),
    );
    expect(failed.find((e) => e.actor.name === 'nobody')!.actor.id).toBeNull();
    expect(failed.find((e) => e.actor.name === 'ops')!.actor.id).toEqual(
      expect.any(String),
    );

    // (newest first: the LAST promotion to admin was root's, by ops; the one before it was ops's, by root)
    const promoted = all.find(
      (e) =>
        e.action === 'user.update' &&
        e.details?.role === 'admin' &&
        e.target?.name === 'ops',
    )!;
    expect(promoted.target).toMatchObject({ type: 'user', name: 'ops' });
    expect(promoted.actor.name).toBe('root');
    const set = all.find(
      (e) => e.action === 'user.update' && e.details?.passwordSet === true,
    )!;
    expect(set.details).toEqual({ passwordSet: true }); // never the password
    expect(all.find((e) => e.action === 'settings.update')!.details).toEqual({
      maxQueryRows: expect.any(Number),
    });
    // (two were asked for: one by name, one unnamed — the first admin's)
    expect(
      all
        .filter((e) => e.action === 'auth.reset_requested')
        .map((e) => e.target?.name),
    ).toEqual(expect.arrayContaining(['ops', 'root']));
  });

  it('is narrowed by action and by actor, and paged without a gap or a duplicate', async () => {
    const logins = await list('?action=auth.login&actor=ops');
    expect(logins.entries.length).toBeGreaterThan(0);
    expect(
      logins.entries.every(
        (e) => e.action === 'auth.login' && e.actor.name === 'ops',
      ),
    ).toBe(true);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list(
        `?limit=5${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.entries.length).toBeLessThanOrEqual(5);
      for (const e of page.entries) {
        expect(seen.has(e.id), 'an entry twice').toBe(false);
        seen.add(e.id);
      }
      cursor = page.next;
      pages++;
    } while (cursor && pages < 100);
    // (every entry there is, whatever other suites left in the table)
    expect(seen.size).toBe(await prisma.auditEntry.count());
    expect(pages).toBeGreaterThan(1);
  });

  it('is kept for as long as the setting says, and pruned by the retention sweep', async () => {
    // (another suite may have left the setting at anything: it is put back as it was found)
    const settings = (await data(
      await call('GET', '/api/settings', { cookie: cookies.root }),
    )) as { auditRetentionDays: number };
    const old = (await list('?limit=3')).entries.map((e) => e.id);
    await prisma.auditEntry.updateMany({
      where: { id: { in: old } },
      data: { at: new Date(Date.now() - 400 * 86_400_000) },
    });
    try {
      // 0 = for ever: nothing goes
      expect(
        (
          await call('PUT', '/api/settings', {
            cookie: cookies.root,
            body: { auditRetentionDays: 0 },
          })
        ).status,
      ).toBe(200);
      const kept = (await data(
        await call('POST', '/api/bridges/retention/run', {
          cookie: cookies.root,
        }),
      )) as { auditEntries: number };
      expect(kept.auditEntries).toBe(0);
      expect(
        await prisma.auditEntry.count({ where: { id: { in: old } } }),
      ).toBe(3);

      expect(
        (
          await call('PUT', '/api/settings', {
            cookie: cookies.root,
            body: { auditRetentionDays: 30 },
          })
        ).status,
      ).toBe(200);
      const swept = (await data(
        await call('POST', '/api/bridges/retention/run', {
          cookie: cookies.root,
        }),
      )) as { auditEntries: number };
      // (at least the three: a run that failed before its sweep leaves old ones behind too)
      expect(swept.auditEntries).toBeGreaterThanOrEqual(3);
      expect(
        await prisma.auditEntry.count({ where: { id: { in: old } } }),
      ).toBe(0);
    } finally {
      await call('PUT', '/api/settings', {
        cookie: cookies.root,
        body: { auditRetentionDays: settings.auditRetentionDays },
      });
    }
  });
});
