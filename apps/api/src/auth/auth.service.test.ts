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
          role: 'admin',
          disabledAt: null,
          lastLoginAt: null,
          ...data,
          sessionVersion: 0,
          resetCodeHash: null,
          resetCodeMintedAt: null,
          resetCodeExpiresAt: null,
          resetCodeFailures: 0,
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
      findFirst: async () => [...users.values()][0] ?? null,
      /** the accounts with a live reset code (what resetPassword asks for), or all of them */
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        [...users.values()].filter((u) => {
          if (!where) return true;
          if (where.resetCodeHash && !u.resetCodeHash) return false;
          const gt = (where.resetCodeExpiresAt as { gt?: Date } | undefined)?.gt;
          if (gt && !(u.resetCodeExpiresAt && u.resetCodeExpiresAt > gt)) return false;
          if ('disabledAt' in where && where.disabledAt === null && u.disabledAt) return false;
          if (where.role && u.role !== where.role) return false;
          return true;
        }),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const user = users.get(where.id)!;
        const next = { ...user } as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          const step = (value as { increment?: number } | null)?.increment;
          next[key] =
            typeof step === 'number' ? (next[key] as number) + step : value;
        }
        users.set(where.id, next as unknown as AppUser);
        return next as unknown as AppUser;
      },
    },
  };
}

let ttlMinutes = 60;
function make(prisma = fakePrisma(), crypto = new CryptoService()) {
  const service = new AuthService(prisma as never, crypto, {
    resolved: async () => ({ sessionTtlMinutes: ttlMinutes }),
  } as never);
  return { prisma, service };
}

/** the key/value table every process of an installation shares */
function sharedSettings() {
  const rows = new Map<string, { key: string; valueJson: string }>();
  return {
    rows,
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.get(where.key) ?? null,
      create: async ({
        data,
      }: {
        data: { key: string; valueJson: string };
      }) => {
        if (rows.has(data.key)) throw new Error('Unique constraint failed');
        rows.set(data.key, data);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => ({
        count: rows.delete(where.key) ? 1 : 0,
      }),
    },
  };
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

describe('first-run setup with more than one API process', () => {
  const tokenOf = (service: AuthServiceClass) =>
    (service as unknown as { setupToken: string | null }).setupToken;

  it('every process prints the SAME token, and any of them takes it', async () => {
    const shared = sharedSettings();
    const database = { ...fakePrisma(), ...shared };
    const a = make(database).service;
    const b = make(database).service;
    await a.onModuleInit();
    await b.onModuleInit();
    expect(tokenOf(a)).toMatch(/^[\w-]{12}$/);
    expect(tokenOf(b)).toBe(tokenOf(a));
    // the token one process printed, entered through the other
    await expect(
      b.setup('admin', 'correct horse battery', tokenOf(a)!, '10.0.0.1'),
    ).resolves.toMatchObject({ username: 'admin' });
    // used up: what it was derived from is gone, for every process
    expect(shared.rows.size).toBe(0);
  });

  it('nothing in the database gives the token away: it takes the master key', async () => {
    const shared = sharedSettings();
    const { service } = make({ ...fakePrisma(), ...shared });
    await service.onModuleInit();
    const stored = [...shared.rows.values()].map((r) => r.valueJson).join();
    expect(stored).not.toContain(tokenOf(service)!);
    // another installation (another master key) over the same value gets another token
    const otherKey = new CryptoService();
    (otherKey as unknown as { key: Buffer }).key = Buffer.alloc(32, 9);
    const other = make({ ...fakePrisma(), ...shared }, otherKey).service;
    await other.onModuleInit();
    expect(tokenOf(other)).toMatch(/^[\w-]{12}$/);
    expect(tokenOf(other)).not.toBe(tokenOf(service));
  });

  it('a database that is set up AGAIN gets a token of its own', async () => {
    const shared = sharedSettings();
    const first = make({ ...fakePrisma(), ...shared }).service;
    await first.onModuleInit();
    const one = tokenOf(first)!;
    await first.setup('admin', 'correct horse battery', one, '10.0.0.1');
    const second = make({ ...fakePrisma(), ...shared }).service; // (the users table was wiped)
    await second.onModuleInit();
    expect(tokenOf(second)).not.toBe(one);
  });

  it('without the shared table a process falls back to a token of its own, as before', async () => {
    const { service } = make();
    await service.onModuleInit();
    expect(tokenOf(service)).toMatch(/^[\w-]{12}$/);
    await expect(
      service.setup(
        'admin',
        'correct horse battery',
        tokenOf(service)!,
        '10.0.0.1',
      ),
    ).resolves.toMatchObject({ username: 'admin' });
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
    // (the last character of unpadded base64url can carry bits that decode to
    // nothing, so it is the one before it that is changed — to something it is
    // NOT: this used to write an 'A' over it, which one token in 64 already had)
    const at = token.length - 2;
    const flipped =
      token.slice(0, at) +
      (token[at] === 'A' ? 'B' : 'A') +
      token.slice(at + 1);
    expect(flipped).not.toBe(token);
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

describe('a password that has been forgotten', () => {
  /** the code, read where the operator reads it: the server's console */
  const printedCode = (): string | null => {
    const calls = (console.log as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    for (const [text] of [...calls].reverse()) {
      const m = /Password reset code[\s\S]*?│\s+(\S+)\s+│/.exec(String(text));
      if (m) return m[1]!;
    }
    return null;
  };

  it('the code is printed on the server, and only its hash is kept', async () => {
    const { service, prisma } = make();
    const user = await account(service);
    await service.requestPasswordReset();
    const code = printedCode()!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const stored = prisma.users.get(user.id)!;
    expect(stored.resetCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.resetCodeExpiresAt!.getTime() - Date.now()).toBeGreaterThan(
      14 * 60_000,
    );
  });

  it('with the code: a new password, the old one and every old session gone — and the code works once', async () => {
    const { service } = make();
    const user = await account(service);
    const { res, cookies } = fakeRes();
    await service.issueSession(res, user);
    const oldSession = cookies.get(SESSION_COOKIE)!.value;

    await service.requestPasswordReset();
    const code = printedCode()!;
    const updated = await service.resetPassword(
      `  ${code} `,
      'a brand new password',
      '10.0.0.9',
    );
    expect(updated.sessionVersion).toBe(user.sessionVersion + 1);
    expect(await service.userFromRequest(reqWith(oldSession))).toBeNull();
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.9'),
    ).rejects.toThrow();
    await expect(
      service.login('admin', 'a brand new password', '10.0.0.9'),
    ).resolves.toMatchObject({ username: 'admin' });
    await expect(
      service.resetPassword(code, 'yet another password', '10.0.0.9'),
    ).rejects.toThrow(/not valid/);
  });

  it('without it: nothing — and ten wrong guesses, from wherever, kill the code', async () => {
    const { service, prisma } = make();
    const user = await account(service);
    await expect(
      service.resetPassword('anything', 'a brand new password', '10.0.0.1'),
    ).rejects.toThrow(/not valid/);
    await service.requestPasswordReset();
    const code = printedCode()!;
    for (let i = 0; i < 10; i++) {
      // a new address every time: the per-address lockout never fires, the count on the code does
      await expect(
        service.resetPassword(
          `wrong-${i}`,
          'a brand new password',
          `10.9.${i}.1`,
        ),
      ).rejects.toThrow(/not valid/);
    }
    expect(prisma.users.get(user.id)!.resetCodeHash).toBeNull();
    await expect(
      service.resetPassword(code, 'a brand new password', '10.0.0.77'),
    ).rejects.toThrow(/not valid/);
    await expect(
      service.login('admin', 'correct horse battery', '10.0.0.77'),
    ).resolves.toBeDefined();
  });

  it('one address guessing is locked out before that', async () => {
    const { service } = make();
    await account(service);
    await service.requestPasswordReset();
    for (let i = 0; i < 5; i++)
      await service
        .resetPassword(`wrong-${i}`, 'a brand new password', '10.1.1.1')
        .catch(() => undefined);
    await expect(
      service.resetPassword(printedCode()!, 'a brand new password', '10.1.1.1'),
    ).rejects.toThrow(/too many|try again|wait/i);
  });

  it('a code that has run out does not work', async () => {
    const { service, prisma } = make();
    const user = await account(service);
    await service.requestPasswordReset();
    const code = printedCode()!;
    prisma.users.set(user.id, {
      ...prisma.users.get(user.id)!,
      resetCodeExpiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      service.resetPassword(code, 'a brand new password', '10.0.0.1'),
    ).rejects.toThrow(/not valid/);
  });

  it('asking again within a minute makes no new code: the button cannot flood the log, or replace a code being typed', async () => {
    const { service, prisma } = make();
    const user = await account(service);
    await service.requestPasswordReset();
    const first = prisma.users.get(user.id)!.resetCodeHash;
    await service.requestPasswordReset();
    await service.requestPasswordReset();
    expect(prisma.users.get(user.id)!.resetCodeHash).toBe(first);
    // a minute later it does
    prisma.users.set(user.id, {
      ...prisma.users.get(user.id)!,
      resetCodeMintedAt: new Date(Date.now() - 61_000),
    });
    await service.requestPasswordReset();
    expect(prisma.users.get(user.id)!.resetCodeHash).not.toBe(first);
  });

  it('with no account there is nothing to reset, and nothing is printed', async () => {
    const { service } = make();
    await service.requestPasswordReset();
    expect(printedCode()).toBeNull();
  });

  it('changing the password the ordinary way cancels a reset that was asked for', async () => {
    const { service, prisma } = make();
    const user = await account(service);
    await service.requestPasswordReset();
    const code = printedCode()!;
    await service.changePassword(
      user.id,
      'correct horse battery',
      'changed the usual way',
    );
    expect(prisma.users.get(user.id)!.resetCodeHash).toBeNull();
    await expect(
      service.resetPassword(code, 'a brand new password', '10.0.0.1'),
    ).rejects.toThrow(/not valid/);
  });
});
