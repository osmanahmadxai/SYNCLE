/**
 * credential encryption at rest (AES-256-GCM).
 *
 * key precedence: SYNCLE_MASTER_KEY (base64, 32 bytes) when set, otherwise a
 * random key generated once and persisted to the data dir with 0600 perms.
 * ciphertext format is "iv:tag:data", all base64
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { runtimeConfig } from './runtime-config';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

@Injectable()
export class CryptoService {
  private key: Buffer | null = null;
  private sigKey: Buffer | null = null;

  private loadKey(): Buffer {
    if (this.key) return this.key;

    if (runtimeConfig.masterKey) {
      const key = Buffer.from(runtimeConfig.masterKey, 'base64');
      if (key.length !== 32) {
        throw new Error(
          'SYNCLE_MASTER_KEY must be a base64-encoded 32-byte value',
        );
      }
      this.key = key;
      return key;
    }

    if (existsSync(runtimeConfig.keyFile)) {
      this.key = Buffer.from(
        readFileSync(runtimeConfig.keyFile, 'utf8').trim(),
        'base64',
      );
      return this.key;
    }

    const key = randomBytes(32);
    // fine for local dev, but the key then lives beside the data it protects —
    // a backup of the data dir carries both. production must set the env key
    new Logger('Crypto').warn(
      `SYNCLE_MASTER_KEY is not set — generated a key at ${runtimeConfig.keyFile}. ` +
        'Set SYNCLE_MASTER_KEY in production.',
    );
    writeFileSync(runtimeConfig.keyFile, key.toString('base64'), {
      mode: 0o600,
    });
    try {
      chmodSync(runtimeConfig.keyFile, 0o600);
    } catch {
      /* best effort */
    }
    this.key = key;
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, this.loadKey(), iv);
    const data = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed ciphertext');
    const tag = Buffer.from(tagB64, 'base64');
    // GCM accepts tags as short as 4 bytes; a truncated tag collapses forgery
    // resistance, so only the full 16-byte tag our encrypt() emits is valid
    if (tag.length !== TAG_LENGTH) throw new Error('Malformed ciphertext');
    const decipher = createDecipheriv(
      ALGO,
      this.loadKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * sign an arbitrary JSON-serializable payload into a compact, tamper-evident
   * token: `base64url(json).base64url(hmac)`. used for the session cookie —
   * signed with a sub-key HKDF-derived from the master key, so the encryption
   * key and the MAC key stay independent (key-separation hygiene) while the
   * operator still manages a single secret.
   */
  signToken(payload: Record<string, unknown>): string {
    const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    return `${body}.${this.hmac(body)}`;
  }

  /**
   * verify a token from {@link signToken} and return its payload, or null if the
   * signature doesn't match or the token is malformed. never throws.
   */
  verifyToken<T = Record<string, unknown>>(token: string): T | null {
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.hmac(body);
    // constant-time compare so a valid-length forgery can't be timed out
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    try {
      return JSON.parse(
        Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
      ) as T;
    } catch {
      return null;
    }
  }

  private hmac(data: string): string {
    return base64url(createHmac('sha256', this.loadSigKey()).update(data).digest());
  }

  /** HKDF(master, info='syncle-session-sig') — derived once, never persisted */
  private loadSigKey(): Buffer {
    if (this.sigKey) return this.sigKey;
    this.sigKey = Buffer.from(
      hkdfSync('sha256', this.loadKey(), Buffer.alloc(0), 'syncle-session-sig', 32),
    );
    return this.sigKey;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
