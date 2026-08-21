/**
 * single-operator authentication. one "admin" account, created on first run,
 * guards the whole API. passwords are hashed with scrypt (built into Node — no
 * native build step), sessions are a signed httpOnly cookie carrying the user
 * id and a session version. bumping the version (on password change) instantly
 * invalidates every outstanding cookie.
 */
import {
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
  /** per-ip lockout against setup-token guessing */
  private readonly setupLimiter = new AttemptLimiter(5, 60_000);

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
    this.assertNotLocked(this.loginLimiter, key);
    const user = await this.prisma.appUser.findUnique({ where: { username } });
    // verify against a decoy hash even when the user is missing, so a wrong
    // username and a wrong password take the same time (no user enumeration)
    const ok = await this.verifyPassword(
      password,
      user?.passwordHash ?? DECOY_HASH,
    );
    if (!user || !ok) {
      this.loginLimiter.fail(key);
      throw new UnauthorizedError('Incorrect username or password.');
    }
    this.loginLimiter.succeed(key);
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
    return this.prisma.appUser.update({
      where: { id: userId },
      data: {
        passwordHash: await this.hashPassword(newPassword),
        sessionVersion: { increment: 1 },
      },
    });
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
    return user;
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
      return decodeURIComponent(part.slice(eq + 1).trim());
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
