/**
 * The one thing standing between the network and every stored database
 * credential, and it had no tests at all.
 *
 * Real scrypt, real token signing; the user table is a Map.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { AppUser } from '@prisma/client';
import type { Request, Response } from 'express';
import type { AuthService as AuthServiceClass } from './auth.service';
import type { CryptoService as CryptoServiceClass } from '../common/crypto.service';

process.env.SYNCLE_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'syncle-auth-'));
process.env.SYNCLE_MASTER_KEY ??=
  'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

let AuthService: typeof AuthServiceClass;
let SESSION_COOKIE: string;
let CryptoService: typeof CryptoServiceClass;

beforeAll(async () => {
  ({ AuthService, SESSION_COOKIE } = await import('./auth.service.js'));
  ({ CryptoService } = await import('../common/crypto.service.js'));
});

function fakePrisma() {
  const users = new Map<string, AppUser>();
  return {
    users,
    appUser: {
      count: async () => users.size,
      create: async ({
        data,
      }: {
        data: Pick<AppUser, 'id' | 'username' | 'passwordHash'>;
      }) => {
        const now = new Date();
        const user = {
          ...data,
          sessionVersion: 0,
          createdAt: now,
          updatedAt: now,
        } as AppUser;
        users.set(user.id, user);
        return user;
      },
      findUnique: async ({
        where,
      }: {
        where: { id?: string; username?: string };
      }) =>
        [...users.values()].find((u) =>
          where.id ? u.id === where.id : u.username === where.username,
        ) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { passwordHash: string };
      }) => {
        const user = users.get(where.id)!;
        const next = {
          ...user,
          passwordHash: data.passwordHash,
          sessionVersion: user.sessionVersion + 1,
        };
        users.set(next.id, next);
        return next;
      },
    },
  };
}

let ttlMinutes = 60;
function make() {
  const prisma = fakePrisma();
  const service = new AuthService(prisma as never, new CryptoService(), {
    resolved: async () => ({ sessionTtlMinutes: ttlMinutes }),
  } as never);
  return { prisma, service };
}

/** a response that records its cookies, the way a browser would keep them */
function fakeRes(secure = false) {
  const cookies = new Map<
    string,
    { value: string; options: Record<string, unknown> }
  >();
  const res = {
    req: { secure },
    headersSent: false,
    cookie: (name: string, value: string, options: Record<string, unknown>) =>
      void cookies.set(name, { value, options }),
    clearCookie: (name: string) => void cookies.delete(name),
  };
  return { res: res as unknown as Response, cookies };
}

const reqWith = (cookie?: string): Request =>
  ({
    headers: cookie
      ? {
          cookie: `other=1; ${SESSION_COOKIE}=${encodeURIComponent(cookie)}; x=y`,
        }
      : {},
  }) as Request;

async function account(service: AuthServiceClass) {
  // onModuleInit mints the setup token; read it the way the launcher does
  await service.onModuleInit();
  const token = (service as unknown as { setupToken: string }).setupToken;
  return service.setup('admin', 'correct horse battery', token, '10.0.0.1');
}

beforeEach(() => {
  ttlMinutes = 60;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('first-run setup', () => {
  it('needs the token printed on the server, and works once', async () => {
    const { service, prisma } = make();
    await service.onModuleInit();
    await expect(
      service.setup('admin', 'pw-pw-pw-pw', 'not-the-token', '10.0.0.1'),
    ).rejects.toThrow(/Invalid setup token/);
    expect(prisma.users.size).toBe(0);

    const user = await account(service);
    expect(user.username).toBe('admin');
    // never stored as it was typed
    expect(user.passwordHash).not.toContain('correct horse');
    expect(user.passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);

    await expect(
      service.setup('second', 'pw-pw-pw-pw', 'anything', '10.0.0.1'),
    ).rejects.toThrow(/already exists/);
  });

  it('stops answering a token guesser', async () => {
    const { service } = make();
    await service.onModuleInit();
    for (let i = 0; i < 5; i++) {
      await expect(
        service.setup('a', 'pw-pw-pw-pw', `guess-${i}`, '10.9.9.9'),
      ).rejects.toThrow(/Invalid setup token/);
    }
    await expect(
      service.setup('a', 'pw-pw-pw-pw', 'guess-6', '10.9.9.9'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('salts every hash: the same password twice is two different hashes', async () => {
    const a = make();
    const b = make();
    const ua = await account(a.service);
    const ub = await account(b.service);
    expect(ua.passwordHash).not.toBe(ub.passwordHash);
  });
});

describe('login', () => {
  it('accepts the right password and nothing else', async () => {
    const { service } = make();
    await account(service);
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.1'),
    ).resolves.toMatchObject({ username: 'admin' });
    await expect(
      service.login('admin', 'Correct horse battery', '10.0.0.1'),
    ).rejects.toThrow(/Incorrect username or password/);
    await expect(service.login('admin', '', '10.0.0.1')).rejects.toThrow(
      /Incorrect/,
    );
  });

  it('says the same thing for a user that does not exist', async () => {
    const { service } = make();
    await account(service);
    const wrongPassword = await service
      .login('admin', 'nope', '10.0.0.1')
      .catch((e: Error) => e.message);
    const wrongUser = await service
      .login('nobody', 'nope', '10.0.0.1')
      .catch((e: Error) => e.message);
    expect(wrongUser).toBe(wrongPassword);
  });

  it('locks an address out after five failures, and a success clears the count', async () => {
    const { service } = make();
    await account(service);
    for (let i = 0; i < 4; i++)
      await service.login('admin', 'nope', '10.0.0.2').catch(() => undefined);
    await service.login('admin', 'correct horse battery', '10.0.0.2');
    for (let i = 0; i < 5; i++)
      await service.login('admin', 'nope', '10.0.0.2').catch(() => undefined);
    // locked: even the RIGHT password is refused, without being checked
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.2'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('cannot be dodged by claiming a new address on every attempt', async () => {
    // `req.ip` is the left-most X-Forwarded-For entry, and the web proxy relays
    // that header as the browser sent it. with the lockout keyed on address
    // alone, this loop could run for ever
    const { service } = make();
    await account(service);
    const outcomes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const err = await service
        .login('admin', `guess-${i}`, `203.0.113.${i}`)
        .catch((e: { status?: number }) => e);
      outcomes.push((err as { status?: number }).status ?? 0);
    }
    expect(outcomes.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(outcomes.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('that lock is short: the operator is back within a minute', async () => {
    vi.useFakeTimers({
      now: new Date('2026-09-17T10:00:00Z'),
      toFake: ['Date'],
    });
    const { service } = make();
    await account(service);
    for (let i = 0; i < 10; i++)
      await service
        .login('admin', 'nope', `203.0.113.${i}`)
        .catch(() => undefined);
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.1'),
    ).rejects.toMatchObject({ status: 429 });
    vi.setSystemTime(new Date('2026-09-17T10:00:06Z'));
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.1'),
    ).resolves.toMatchObject({ username: 'admin' });
  });

  it('treats Admin and admin as one name for the purpose of counting', async () => {
    const { service } = make();
    await account(service);
    for (let i = 0; i < 10; i++) {
      await service
        .login(i % 2 ? 'ADMIN' : ' admin ', 'nope', `203.0.113.${i}`)
        .catch(() => undefined);
    }
    await expect(
      service.login('admin', 'nope', '198.51.100.1'),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe('sessions', () => {
  it('is an httpOnly, SameSite cookie — Secure exactly when the browser used HTTPS', async () => {
    const { service } = make();
    const user = await account(service);
    const plain = fakeRes(false);
    await service.issueSession(plain.res, user);
    expect(plain.cookies.get(SESSION_COOKIE)!.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 60 * 60_000,
    });
    const https = fakeRes(true);
    await service.issueSession(https.res, user);
    expect(https.cookies.get(SESSION_COOKIE)!.options.secure).toBe(true);
  });

  it('resolves the user from the cookie, among other cookies', async () => {
    const { service } = make();
    const user = await account(service);
    const { res, cookies } = fakeRes();
    await service.issueSession(res, user);
    const found = await service.userFromRequest(
      reqWith(cookies.get(SESSION_COOKIE)!.value),
    );
    expect(found?.id).toBe(user.id);
    expect(await service.userFromRequest(reqWith())).toBeNull();
  });

  it('rejects a cookie that was tampered with, or signed by another key', async () => {
    const { service } = make();
    const user = await account(service);
    const { res, cookies } = fakeRes();
    await service.issueSession(res, user);
    const token = cookies.get(SESSION_COOKIE)!.value;
    const flipped =
      token.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A') + token.slice(-1);
    expect(await service.userFromRequest(reqWith(flipped))).toBeNull();
    expect(await service.userFromRequest(reqWith('garbage'))).toBeNull();
    expect(await service.userFromRequest(reqWith(''))).toBeNull();
    // not valid percent-encoding: decodeURIComponent throws on it
    const junk = { headers: { cookie: `${SESSION_COOKIE}=%%%` } } as Request;
    await expect(service.userFromRequest(junk)).resolves.toBeNull();
  });

  it('a password change ends every other session at once', async () => {
    const { service } = make();
    const user = await account(service);
    const laptop = fakeRes();
    await service.issueSession(laptop.res, user);
    const stolen = laptop.cookies.get(SESSION_COOKIE)!.value;

    await expect(
      service.changePassword(user.id, 'wrong', 'a new long password'),
    ).rejects.toThrow(/current password is incorrect/);
    expect(await service.userFromRequest(reqWith(stolen))).not.toBeNull();

    const updated = await service.changePassword(
      user.id,
      'correct horse battery',
      'a new long password',
    );
    expect(await service.userFromRequest(reqWith(stolen))).toBeNull();
    // the session that made the change is re-issued and carries on
    const fresh = fakeRes();
    await service.issueSession(fresh.res, updated);
    expect(
      await service.userFromRequest(
        reqWith(fresh.cookies.get(SESSION_COOKIE)!.value),
      ),
    ).not.toBeNull();
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.1'),
    ).rejects.toThrow(/Incorrect/);
    await expect(
      service.login('admin', 'a new long password', '10.0.0.1'),
    ).resolves.toBeTruthy();
  });

  it('expires after the configured time WITHOUT activity', async () => {
    vi.useFakeTimers({
      now: new Date('2026-09-17T10:00:00Z'),
      toFake: ['Date'],
    });
    ttlMinutes = 15;
    const { service } = make();
    const user = await account(service);
    const { res, cookies } = fakeRes();
    await service.issueSession(res, user);
    const token = cookies.get(SESSION_COOKIE)!.value;
    vi.setSystemTime(new Date('2026-09-17T10:14:00Z'));
    expect(await service.userFromRequest(reqWith(token))).not.toBeNull();
    vi.setSystemTime(new Date('2026-09-17T10:16:00Z'));
    expect(await service.userFromRequest(reqWith(token))).toBeNull();
  });

  it('…and not while it is being used: activity renews it', async () => {
    // the cookie's issue time used to be set at login and never again, so with
    // a 15 minute timeout an operator was thrown out every 15 minutes, mid-edit
    vi.useFakeTimers({
      now: new Date('2026-09-17T10:00:00Z'),
      toFake: ['Date'],
    });
    ttlMinutes = 15;
    const { service } = make();
    const user = await account(service);
    let jar = fakeRes();
    await service.issueSession(jar.res, user);

    // a request every five minutes, for an hour
    for (let minute = 5; minute <= 60; minute += 5) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 17, 10, minute)));
      const session = await service.sessionFromRequest(
        reqWith(jar.cookies.get(SESSION_COOKIE)!.value),
      );
      expect(session, `still signed in at minute ${minute}`).not.toBeNull();
      const next = fakeRes();
      if (await service.renewIfDue(next.res, session!)) jar = next;
    }
  });

  it('does not mint a cookie for every request of a busy page', async () => {
    vi.useFakeTimers({
      now: new Date('2026-09-17T10:00:00Z'),
      toFake: ['Date'],
    });
    const { service } = make();
    const user = await account(service);
    const { res, cookies } = fakeRes();
    await service.issueSession(res, user);
    vi.setSystemTime(new Date('2026-09-17T10:00:20Z'));
    const session = await service.sessionFromRequest(
      reqWith(cookies.get(SESSION_COOKIE)!.value),
    );
    const again = fakeRes();
    expect(await service.renewIfDue(again.res, session!)).toBe(false);
    expect(again.cookies.size).toBe(0);
  });

  it('leaves a response that is already streaming alone', async () => {
    const { service } = make();
    const user = await account(service);
    const streaming = fakeRes();
    (streaming.res as unknown as { headersSent: boolean }).headersSent = true;
    expect(
      await service.renewIfDue(streaming.res, { user, ageSec: 99_999 }),
    ).toBe(false);
  });
});
