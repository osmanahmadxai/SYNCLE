import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// runtime-config resolves the environment at import time (and creates the data
// dir), so each case stubs the env and re-imports the guard fresh
async function loadGuard(blockPrivate: boolean) {
  vi.resetModules();
  vi.stubEnv('SYNCLE_DATA_DIR', mkdtempSync(join(tmpdir(), 'syncle-test-')));
  vi.stubEnv('SYNCLE_BLOCK_PRIVATE_DESTINATIONS', blockPrivate ? 'true' : '');
  const mod = await import('./url-guard.js');
  return mod.assertAllowedDestination;
}

describe('assertAllowedDestination', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('always refuses cloud metadata endpoints', async () => {
    const guard = await loadGuard(false);
    await expect(guard('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /metadata/,
    );
    await expect(guard('http://[fd00:ec2::254]/')).rejects.toThrow(/metadata/);
    await expect(guard('http://100.100.100.200/')).rejects.toThrow(/metadata/);
  });

  it('allows private/loopback destinations by default (local-first)', async () => {
    const guard = await loadGuard(false);
    await expect(guard('http://127.0.0.1:4990/hook')).resolves.toBeUndefined();
    await expect(guard('http://192.168.1.20/ingest')).resolves.toBeUndefined();
  });

  it('refuses private ranges when the deployment opts in', async () => {
    const guard = await loadGuard(true);
    await expect(guard('http://127.0.0.1:4990/hook')).rejects.toThrow(/private/);
    await expect(guard('http://10.0.0.5/')).rejects.toThrow(/private/);
    await expect(guard('http://172.16.0.1/')).rejects.toThrow(/private/);
    await expect(guard('http://192.168.1.20/')).rejects.toThrow(/private/);
    await expect(guard('http://[::1]/')).rejects.toThrow(/private/);
    await expect(guard('http://[fe80::1]/')).rejects.toThrow(/private/);
    // public addresses stay reachable
    await expect(guard('http://93.184.216.34/')).resolves.toBeUndefined();
  });

  it('rejects malformed URLs', async () => {
    const guard = await loadGuard(false);
    await expect(guard('not a url')).rejects.toThrow(/valid URL/);
  });
});
