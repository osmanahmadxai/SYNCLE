import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// import fresh with a pinned master key so the test never touches a real data dir
async function loadService(masterKey = randomBytes(32).toString('base64')) {
  vi.resetModules();
  vi.stubEnv('SYNCLE_DATA_DIR', mkdtempSync(join(tmpdir(), 'syncle-test-')));
  vi.stubEnv('SYNCLE_MASTER_KEY', masterKey);
  const { CryptoService } = await import('./crypto.service.js');
  return new CryptoService();
}

describe('CryptoService', () => {
  it('round-trips encryption and signed tokens', async () => {
    const svc = await loadService();
    expect(svc.decrypt(svc.encrypt('s3cret'))).toBe('s3cret');
    const token = svc.signToken({ uid: 'u1', v: 2 });
    expect(svc.verifyToken(token)).toMatchObject({ uid: 'u1', v: 2 });
    expect(svc.verifyToken(token.slice(0, -2) + 'xx')).toBeNull();
  });

  it('rejects ciphertexts with a truncated auth tag', async () => {
    const svc = await loadService();
    const [iv, tag, data] = svc.encrypt('payload').split(':');
    const shortTag = Buffer.from(tag!, 'base64').subarray(0, 8).toString('base64');
    expect(() => svc.decrypt(`${iv}:${shortTag}:${data}`)).toThrow(/Malformed/);
    // the untampered ciphertext still decrypts
    expect(svc.decrypt(`${iv}:${tag}:${data}`)).toBe('payload');
  });

  it('derives a stable HKDF signing key from the master key', async () => {
    // the derivation must be deterministic: a session minted before a restart
    // (fresh service instance, same master key) still verifies after it
    const key = randomBytes(32).toString('base64');
    const before = await loadService(key);
    const token = before.signToken({ uid: 'u1' });
    const after = await loadService(key);
    expect(after.verifyToken(token)).toMatchObject({ uid: 'u1' });
    // ...while a different master key derives a different signing key
    const other = await loadService();
    expect(other.verifyToken(token)).toBeNull();
  });
});
