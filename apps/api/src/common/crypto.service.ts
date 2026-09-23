/**
 * credential encryption at rest (AES-256-GCM).
 *
 * key precedence: SYNCLE_MASTER_KEY (base64, 32 bytes) when set, otherwise a
 * random key generated once and persisted to the data dir with 0600 perms.
 * ciphertext format is "iv:tag:data", all base64
 *
 * CHANGING the key. there is one key that encrypts, and there may be keys that
 * used to: SYNCLE_MASTER_KEY_PREVIOUS, and the key file in the data dir when an
 * env key has since taken its place. they are only ever tried for DECRYPTING
 * (GCM's tag says whether a key fits), so at no point during a change of key is
 * anything unreadable: not before the stored secrets have been re-encrypted
 * (KeyRotationService, at start), not if that is interrupted half-way, not if
 * the process is restarted in between.
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
  private previous: Buffer[] | null = null;
  private previousSigKeys: Buffer[] | null = null;

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

  /** keys that used to encrypt: tried when the current one does not fit, never encrypted with */
  previousKeys(): Buffer[] {
    if (this.previous) return this.previous;
    const current = this.loadKey();
    const keys: Buffer[] = [];
    const add = (encoded: string, from: string): void => {
      const key = Buffer.from(encoded.trim(), 'base64');
      if (key.length !== 32) throw new Error(`${from} must hold base64-encoded 32-byte keys`);
      if (!key.equals(current) && !keys.some((k) => k.equals(key))) keys.push(key);
    };
    for (const encoded of runtimeConfig.previousMasterKeys) add(encoded, 'SYNCLE_MASTER_KEY_PREVIOUS');
    // an instance that started on a generated key file and was then given a key
    // in its environment: the file's key is what its secrets are under
    if (runtimeConfig.masterKey && existsSync(runtimeConfig.keyFile)) {
      try {
        add(readFileSync(runtimeConfig.keyFile, 'utf8'), runtimeConfig.keyFile);
      } catch {
        /* a key file that is not a key is not a previous key */
      }
    }
    this.previous = keys;
    return keys;
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
    return this.open(payload).plaintext;
  }

  /** the plaintext, and whether it took a PREVIOUS key to get at it */
  private open(payload: string): { plaintext: string; underPreviousKey: boolean } {
    try {
      return { plaintext: this.decryptWith(this.loadKey(), payload), underPreviousKey: false };
    } catch (err) {
      for (const key of this.previousKeys()) {
        try {
          return { plaintext: this.decryptWith(key, payload), underPreviousKey: true };
        } catch {
          /* not this one */
        }
      }
      throw err;
    }
  }

  /**
   * the same secret under the CURRENT key, when it is under a previous one now;
   * null when there is nothing to do. throws when no key fits at all
   */
  reencrypt(payload: string): string | null {
    const opened = this.open(payload);
    return opened.underPreviousKey ? this.encrypt(opened.plaintext) : null;
  }

  private decryptWith(key: Buffer, payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed ciphertext');
    const tag = Buffer.from(tagB64, 'base64');
    // GCM accepts tags as short as 4 bytes; a truncated tag collapses forgery
    // resistance, so only the full 16-byte tag our encrypt() emits is valid
    if (tag.length !== TAG_LENGTH) throw new Error('Malformed ciphertext');
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
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
    // constant-time compare so a valid-length forgery can't be timed out. a
    // session signed under a previous key is still a session: changing the key
    // does not sign everybody out (the next renewal re-signs it under the new one)
    const fits = [this.loadSigKey(), ...this.loadPreviousSigKeys()].some((key) => {
      const expected = base64url(createHmac('sha256', key).update(body).digest());
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    });
    if (!fits) return null;
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

  /**
   * a value every process that has THIS master key computes the same, and
   * nobody without it can: HMAC under a sub-key of the master key that is only
   * ever used for `purpose`. (the first-run setup token is one: whichever
   * process prints it, and whichever one is asked, it is the same token)
   */
  derive(purpose: string, data: string): string {
    const key = Buffer.from(hkdfSync('sha256', this.loadKey(), Buffer.alloc(0), `syncle-derive:${purpose}`, 32));
    return base64url(createHmac('sha256', key).update(data).digest());
  }

  /** HKDF(master, info='syncle-session-sig') — derived once, never persisted */
  private loadSigKey(): Buffer {
    if (this.sigKey) return this.sigKey;
    this.sigKey = deriveSigKey(this.loadKey());
    return this.sigKey;
  }

  private loadPreviousSigKeys(): Buffer[] {
    this.previousSigKeys ??= this.previousKeys().map(deriveSigKey);
    return this.previousSigKeys;
  }
}

function deriveSigKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'syncle-session-sig', 32));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
