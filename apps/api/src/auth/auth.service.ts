/**
 * single-operator authentication. one "admin" account, created on first run,
 * guards the whole API. passwords are hashed with scrypt (built into Node — no
 * native build step), sessions are a signed httpOnly cookie carrying the user
 * id and a session version. bumping the version (on password change) instantly
 * invalidates every outstanding cookie.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AppError,
  BadRequestError,
  ConflictError,
  UnauthorizedError,
  type AuthUser,
} from '@syncle/core';
import { AttemptLimiter } from '../common/attempt-limiter';
import type { AppUser } from '@prisma/client';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';
import { SettingsStoreService } from '../settings/settings-store.service';

const scrypt = promisify(scryptCb);

/** a reset code lives this long… */
const RESET_TTL_MS = 15 * 60_000;
/** …a new one is made at most this often… */
const RESET_MIN_INTERVAL_MS = 60_000;
/** …and it is gone after this many wrong guesses, wherever they came from */
const RESET_MAX_FAILURES = 10;
const CLEARED_RESET = { resetCodeHash: null, resetCodeMintedAt: null, resetCodeExpiresAt: null, resetCodeFailures: 0 };

/** what is stored of a reset code (72 random bits: a fast hash is enough, and it is compared in constant time) */
const hashResetCode = (code: string): string => createHash('sha256').update(code.trim()).digest('hex');

/** the session cookie name; cookies aren't port-scoped, so this is host-wide */
export const SESSION_COOKIE = 'db_session';

/**
 * Mark the session cookie Secure only when the browser actually used HTTPS.
 *
 * Keying this off NODE_ENV would lock out most self-hosted installs: the
 * Docker image runs with NODE_ENV=production, and browsers silently discard a
 * Secure cookie sent over plain HTTP — so logging in at http://<lan-ip>:3002
 * would appear to succeed and then bounce straight back to the login screen.
 * (localhost is exempt, which is why it only breaks once you leave your own
 * machine.) `req.secure` reads X-Forwarded-Proto via Express's trust-proxy
 * setting, so an HTTPS reverse proxy still gets Secure cookies.
 *
 * SYNCLE_SECURE_COOKIES=true|false forces it, for a proxy that doesn't
 * forward the header.
 */
function useSecureCookie(res: Response): boolean {
  const override = process.env.SYNCLE_SECURE_COOKIES;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return res.req?.secure === true;
}

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

interface SessionPayload {
  uid: string;
  /** session version at issue time; must match the user's current version */
  v: number;
  /** issued-at (seconds) for idle-expiry enforcement */
  iat: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger('Auth');
  /** one-time first-run token; null once an account exists */
  private setupToken: string | null = null;
  /** per-ip:username lockout against online password guessing */
  private readonly loginLimiter = new AttemptLimiter();
  /**
   * …and per user name alone, whatever address the attempt claims to come from.
   *
   * the address is `req.ip`, and with `trust proxy` on that is the left-most
   * X-Forwarded-For entry — which the bundled web proxy relays exactly as the
   * browser sent it. so a guesser who puts a new made-up address in that header
   * on every attempt got a fresh key every time, and the lockout above never
   * fired: unlimited guesses. this one cannot be dodged. it is deliberately
   * gentle — ten failures, then at most a minute — because the one person it
   * can inconvenience is the operator, while a guesser is held to about one
   * attempt a minute: 1,440 a day against a password.
   */
  private readonly usernameLimiter = new AttemptLimiter(10, 5_000, 60_000);
  /** per-ip lockout against setup-token guessing */
  private readonly setupLimiter = new AttemptLimiter(5, 60_000);
  /** …and against guessing a password-reset code */
  private readonly resetLimiter = new AttemptLimiter(5, 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsStoreService,
  ) {}

  /* ----- account lifecycle ----- */

  /**
   * first-run guard: whoever reaches an un-set-up instance first would own it
   * (trust-on-first-use). mint a one-time token at boot and print it to the
   * server console — setup then requires something only the operator has.
   */
  async onModuleInit(): Promise<void> {
    try {
      if (await this.hasAccount()) {
        // an account already exists — clear any token file left behind by an
        // earlier boot (e.g. the process was killed mid-setup)
        this.clearSetupTokenFile();
        return;
      }
    } catch (err) {
      // DB not up yet — the token is minted lazily on the first setup attempt
      this.logger.warn(`Skipped setup-token mint: ${(err as Error).message}`);
      return;
    }
    this.printSetupBanner(this.mintSetupToken());
  }

  async hasAccount(): Promise<boolean> {
    return (await this.prisma.appUser.count()) > 0;
  }

  /** create the one admin account; refuses if an account already exists */
  async setup(
    username: string,
    password: string,
    setupToken: string,
    ip: string,
  ): Promise<AppUser> {
    if (await this.hasAccount()) {
      throw new ConflictError('An account already exists. Sign in instead.');
    }
    this.assertNotLocked(this.setupLimiter, `setup:${ip}`);
    if (this.setupToken == null) {
      // boot couldn't reach the DB (or the token was consumed by a failed
      // race) — mint now so the console always shows a usable token
      this.printSetupBanner(this.mintSetupToken());
    }
    if (!tokensEqual(setupToken, this.setupToken!)) {
      this.setupLimiter.fail(`setup:${ip}`);
      throw new UnauthorizedError(
        'Invalid setup token. It is printed in the server logs at startup.',
      );
    }
    const user = await this.prisma.appUser.create({
      data: {
        id: randomUUID(),
        username,
        passwordHash: await this.hashPassword(password),
      },
    });
    this.setupToken = null;
    this.clearSetupTokenFile();
    this.setupLimiter.succeed(`setup:${ip}`);
    return user;
  }

  async login(username: string, password: string, ip: string): Promise<AppUser> {
    const key = `${ip}:${username}`;
    const nameKey = `user:${username.trim().toLowerCase()}`;
    this.assertNotLocked(this.loginLimiter, key);
    this.assertNotLocked(this.usernameLimiter, nameKey);
    const user = await this.prisma.appUser.findUnique({ where: { username } });
    // verify against a decoy hash even when the user is missing, so a wrong
    // username and a wrong password take the same time (no user enumeration)
    const ok = await this.verifyPassword(
      password,
      user?.passwordHash ?? DECOY_HASH,
    );
    if (!user || !ok) {
      this.loginLimiter.fail(key);
      this.usernameLimiter.fail(nameKey);
      throw new UnauthorizedError('Incorrect username or password.');
    }
    this.loginLimiter.succeed(key);
    this.usernameLimiter.succeed(nameKey);
    return user;
  }

  private assertNotLocked(limiter: AttemptLimiter, key: string): void {
    const waitMs = limiter.retryAfterMs(key);
    if (waitMs > 0) {
      throw new AppError(
        'RATE_LIMITED',
        `Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`,
        429,
      );
    }
  }

  private mintSetupToken(): string {
    this.setupToken = randomBytes(9).toString('base64url');
    this.persistSetupToken(this.setupToken);
    return this.setupToken;
  }

  /**
   * Mirror the token to the data dir so `syncle up` can read it back and open
   * the browser with the setup form already filled in. Reading that file needs
   * host or container access — the same thing the token is proof of — so this
   * changes how the operator receives it, not who can.
   *
   * Written 0600, and removed as soon as an account exists so a stale file can
   * never hand out a token that no longer works.
   */
  private persistSetupToken(token: string): void {
    try {
      writeFileSync(runtimeConfig.setupTokenFile, `${token}\n`, { mode: 0o600 });
    } catch (err) {
      // non-fatal: the token is still printed to the console
      this.logger.warn(
        `Could not write the setup-token file: ${(err as Error).message}`,
      );
    }
  }

  private clearSetupTokenFile(): void {
    try {
      rmSync(runtimeConfig.setupTokenFile, { force: true });
    } catch (err) {
      this.logger.warn(
        `Could not remove the setup-token file: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Written straight to stdout, not through the Nest logger: main.ts boots the
   * app with `logger: ['error','warn']` to keep startup quiet, which would
   * swallow a `logger.log` and leave a fresh install with no way to finish
   * setup. Same reasoning as the ready banner in main.ts.
   */
  private printSetupBanner(token: string): void {
    // eslint-disable-next-line no-console -- on purpose, see above: it must print whatever the log level
    console.log(this.setupBanner(token));
  }

  private setupBanner(token: string): string {
    return [
      '',
      '  ┌──────────────────────────────────────────────────┐',
      '  │  First-run setup token (enter it in the web UI)  │',
      `  │      ${token.padEnd(44)}│`,
      '  └──────────────────────────────────────────────────┘',
    ].join('\n');
  }

  /* ----- a password that has been forgotten ----- */

  /**
   * somebody at the login screen says they cannot sign in.
   *
   * there is no e-mail to send a link to, and the proof of being the operator is
   * what it was on the first day: being able to read the server's console, or
   * its data directory. so a code is made, PRINTED THERE, and asked for in the
   * browser. whoever pressed the button without that access has made a line
   * appear in a log they cannot read.
   *
   * answers nothing either way — not whether there is an account, not whether
   * a code was made. at most one code a minute, so the button can neither flood
   * the log nor keep replacing a code the operator is busy typing in; a code
   * lives for fifteen minutes, works once, and dies after ten wrong guesses
   * whoever made them. only its hash is stored, so it works whichever API
   * process the reset then reaches.
   */
  async requestPasswordReset(): Promise<void> {
    const user = await this.prisma.appUser.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) return; // nothing to reset: first-run setup is the way in
    const now = Date.now();
    const fresh =
      user.resetCodeHash &&
      user.resetCodeMintedAt &&
      user.resetCodeExpiresAt &&
      user.resetCodeExpiresAt.getTime() > now &&
      now - user.resetCodeMintedAt.getTime() < RESET_MIN_INTERVAL_MS;
    if (fresh) return;

    const code = randomBytes(9).toString('base64url');
    await this.prisma.appUser.update({
      where: { id: user.id },
      data: {
        resetCodeHash: hashResetCode(code),
        resetCodeMintedAt: new Date(now),
        resetCodeExpiresAt: new Date(now + RESET_TTL_MS),
        resetCodeFailures: 0,
      },
    });
    try {
      writeFileSync(runtimeConfig.resetCodeFile, `${code}\n`, { mode: 0o600 });
    } catch (err) {
      this.logger.warn(`Could not write the reset-code file: ${(err as Error).message}`);
    }
    // eslint-disable-next-line no-console -- like the setup token: it must print whatever the log level
    console.log(
      [
        '',
        '  ┌──────────────────────────────────────────────────┐',
        '  │  Password reset code (valid for 15 minutes)      │',
        `  │      ${code.padEnd(44)}│`,
        '  │  Nobody asked for this? Then ignore it.          │',
        '  └──────────────────────────────────────────────────┘',
      ].join('\n'),
    );
  }

  /** set a new password with a reset code; every session there was ends */
  async resetPassword(code: string, newPassword: string, ip: string): Promise<AppUser> {
    const key = `reset:${ip}`;
    this.assertNotLocked(this.resetLimiter, key);
    const user = await this.prisma.appUser.findFirst({ orderBy: { createdAt: 'asc' } });
    const live = !!user?.resetCodeHash && !!user.resetCodeExpiresAt && user.resetCodeExpiresAt.getTime() > Date.now();
    if (!user || !live || !tokensEqual(hashResetCode(code), user.resetCodeHash!)) {
      this.resetLimiter.fail(key);
      if (user && live) {
        // guesses from many addresses add up too: ten of them and the code is gone
        const failures = user.resetCodeFailures + 1;
        await this.prisma.appUser.update({
          where: { id: user.id },
          data: failures >= RESET_MAX_FAILURES ? CLEARED_RESET : { resetCodeFailures: failures },
        });
        if (failures >= RESET_MAX_FAILURES) this.clearResetCodeFile();
      }
      throw new UnauthorizedError('That reset code is not valid, or is no longer. Ask for a new one: it is printed in the server logs.');
    }
    const updated = await this.prisma.appUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.hashPassword(newPassword),
        // whoever was signed in with the old password no longer is
        sessionVersion: { increment: 1 },
        ...CLEARED_RESET,
      },
    });
    this.clearResetCodeFile();
    this.resetLimiter.succeed(key);
    this.logger.warn(`The password of "${updated.username}" was reset with a reset code.`);
    return updated;
  }

  private clearResetCodeFile(): void {
    try {
      rmSync(runtimeConfig.resetCodeFile, { force: true });
    } catch (err) {
      this.logger.warn(`Could not remove the reset-code file: ${(err as Error).message}`);
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AppUser> {
    const user = await this.prisma.appUser.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedError();
    if (!(await this.verifyPassword(currentPassword, user.passwordHash))) {
      throw new BadRequestError('Your current password is incorrect.');
    }
    // bump sessionVersion so every existing cookie (including other devices)
    // stops validating; the caller re-issues a fresh cookie for this session
    const updated = await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        passwordHash: await this.hashPassword(newPassword),
        sessionVersion: { increment: 1 },
        // a reset that was asked for is moot now, and must not outlive the password it was for
        ...CLEARED_RESET,
      },
    });
    this.clearResetCodeFile();
    return updated;
  }

  /* ----- session cookie ----- */

  async issueSession(res: Response, user: AppUser): Promise<void> {
    const ttlMinutes = (await this.settings.resolved()).sessionTtlMinutes;
    const token = this.crypto.signToken({
      uid: user.id,
      v: user.sessionVersion,
      iat: Math.floor(nowMs() / 1000),
    } satisfies SessionPayload);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: useSecureCookie(res),
      path: '/',
      maxAge: ttlMinutes * 60_000,
    });
  }

  clearSession(res: Response): void {
    // attributes must mirror issueSession's, or the browser keeps the original
    res.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: useSecureCookie(res),
    });
  }

  /**
   * resolve the user for a request from its session cookie, or null. rejects
   * cookies whose version is stale (password changed) or that have idled past
   * the configured TTL.
   */
  async userFromRequest(req: Request): Promise<AppUser | null> {
    return (await this.sessionFromRequest(req))?.user ?? null;
  }

  /** the user a request's cookie stands for, and how old that cookie is */
  async sessionFromRequest(req: Request): Promise<{ user: AppUser; ageSec: number } | null> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const payload = this.crypto.verifyToken<SessionPayload>(token);
    if (!payload?.uid) return null;

    const ttlMinutes = (await this.settings.resolved()).sessionTtlMinutes;
    const ageSec = Math.floor(nowMs() / 1000) - (payload.iat ?? 0);
    if (ageSec > ttlMinutes * 60) return null;

    const user = await this.prisma.appUser.findUnique({
      where: { id: payload.uid },
    });
    if (!user || user.sessionVersion !== payload.v) return null;
    return { user, ageSec };
  }

  /**
   * the timeout is described everywhere — the setting, its hint, the docs — as
   * minutes of INACTIVITY. it was nothing of the kind: the cookie's issue time
   * was set at login and never again, so a session ended that long after
   * signing in however busy it had been. with the setting at 15 minutes an
   * operator was thrown out every quarter of an hour, mid-edit.
   *
   * an active session is given a fresh cookie once it is a tenth of the way
   * through its life (and at least a minute old, so that a page making twenty
   * requests does not get twenty cookies).
   */
  async renewIfDue(res: Response, session: { user: AppUser; ageSec: number }): Promise<boolean> {
    const ttlSec = (await this.settings.resolved()).sessionTtlMinutes * 60;
    if (session.ageSec < Math.max(60, ttlSec / 10)) return false;
    // headers can no longer be set once a handler has started streaming
    if (res.headersSent) return false;
    await this.issueSession(res, session.user);
    return true;
  }

  toAuthUser(user: AppUser): AuthUser {
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  /* ----- password hashing (scrypt) ----- */

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
    return `${salt.toString('hex')}:${derived.toString('hex')}`;
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    try {
      const derived = (await scrypt(
        password,
        Buffer.from(saltHex, 'hex'),
        SCRYPT_KEYLEN,
      )) as Buffer;
      const expected = Buffer.from(hashHex, 'hex');
      return (
        derived.length === expected.length && timingSafeEqual(derived, expected)
      );
    } catch {
      return false;
    }
  }
}

function nowMs(): number {
  return new Date().getTime();
}

/** constant-time string compare (padded so length mismatches don't throw) */
function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** parse a single cookie value out of the raw Cookie header (no cookie-parser dep) */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      // whatever the client sent. `%%%` is not valid percent-encoding, and
      // decodeURIComponent THROWS on it — which turned a junk cookie into a 500
      // from every route instead of a 401
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * a fixed scrypt hash of a random string, used to equalize timing on the
 * "user not found" path. its plaintext is unknown, so it never matches.
 */
const DECOY_HASH =
  '00000000000000000000000000000000:' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';
