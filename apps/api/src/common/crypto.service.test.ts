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

describe('changing the master key', () => {
  async function serviceWith(env: { current: string; previous?: string; dataDir?: string }) {
    vi.resetModules();
    vi.stubEnv('SYNCLE_DATA_DIR', env.dataDir ?? mkdtempSync(join(tmpdir(), 'syncle-test-')));
    vi.stubEnv('SYNCLE_MASTER_KEY', env.current);
    vi.stubEnv('SYNCLE_MASTER_KEY_PREVIOUS', env.previous ?? '');
    const { CryptoService } = await import('./crypto.service.js');
    return new CryptoService();
  }
  const key = () => randomBytes(32).toString('base64');

  it('what a previous key encrypted is still readable — and only encrypted with the current one', async () => {
    const [a, b] = [key(), key()];
    const secret = (await serviceWith({ current: a })).encrypt('pg-password');

    const both = await serviceWith({ current: b, previous: a });
    expect(both.decrypt(secret)).toBe('pg-password');
    const moved = both.reencrypt(secret)!;
    expect(moved).not.toBe(secret);
    // under the NEW key alone now
    expect((await serviceWith({ current: b })).decrypt(moved)).toBe('pg-password');
    expect(() => (both as unknown as { decryptWith(k: Buffer, p: string): string }).decryptWith(Buffer.from(a, 'base64'), moved)).toThrow();
    // nothing to do for what is under the current key already
    expect(both.reencrypt(moved)).toBeNull();
    expect(both.reencrypt(both.encrypt('fresh'))).toBeNull();
  });

  it('without the previous key it is NOT readable: that is what the key is for', async () => {
    const [a, b] = [key(), key()];
    const secret = (await serviceWith({ current: a })).encrypt('pg-password');
    const onlyNew = await serviceWith({ current: b });
    expect(() => onlyNew.decrypt(secret)).toThrow();
    expect(() => onlyNew.reencrypt(secret)).toThrow();
  });

  it('several previous keys, in any order, spaced any way; the current key listed among them changes nothing', async () => {
    const [a, b, c] = [key(), key(), key()];
    const underA = (await serviceWith({ current: a })).encrypt('one');
    const underB = (await serviceWith({ current: b })).encrypt('two');
    const svc = await serviceWith({ current: c, previous: ` ${b} ,${a}, ${c} ` });
    expect(svc.previousKeys()).toHaveLength(2);
    expect(svc.decrypt(underA)).toBe('one');
    expect(svc.decrypt(underB)).toBe('two');
  });

  it('a previous key that is not a key is said at once, not found out when a secret will not open', async () => {
    const svc = await serviceWith({ current: key(), previous: 'not-a-key' });
    expect(() => svc.previousKeys()).toThrow(/SYNCLE_MASTER_KEY_PREVIOUS must hold base64-encoded 32-byte keys/);
  });

  it('an instance that began on a generated key file and was then given a key: the file is a previous key', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'syncle-test-'));
    vi.resetModules();
    vi.stubEnv('SYNCLE_DATA_DIR', dataDir);
    vi.stubEnv('SYNCLE_MASTER_KEY', '');
    vi.stubEnv('SYNCLE_MASTER_KEY_PREVIOUS', '');
    const { CryptoService } = await import('./crypto.service.js');
    const generated = new CryptoService();
    const secret = generated.encrypt('from the key file days'); // writes master.key

    const withEnvKey = await serviceWith({ current: key(), dataDir });
    expect(withEnvKey.decrypt(secret)).toBe('from the key file days');
    expect(withEnvKey.reencrypt(secret)).not.toBeNull();
  });

  it('changing the key signs nobody out: a session signed under the previous key is still a session', async () => {
    const [a, b] = [key(), key()];
    const token = (await serviceWith({ current: a })).signToken({ uid: 'u1', v: 3 });
    expect((await serviceWith({ current: b, previous: a })).verifyToken(token)).toMatchObject({ uid: 'u1', v: 3 });
    // …once the previous key is gone, neither is the session
    expect((await serviceWith({ current: b })).verifyToken(token)).toBeNull();
    // and a forgery is a forgery under any number of keys
    expect((await serviceWith({ current: b, previous: a })).verifyToken(`${token.split('.')[0]}.AAAA`)).toBeNull();
  });
});
