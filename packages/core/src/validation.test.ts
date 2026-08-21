import { describe, expect, it } from 'vitest';
import { connectionInputSchema } from './validation';

const base = {
  name: 'Remote PG',
  engine: 'postgres' as const,
  host: 'db.internal',
  port: 5432,
  user: 'app',
  password: 'secret',
};

const ssh = {
  enabled: true,
  host: 'bastion.example.com',
  username: 'deploy',
  authMethod: 'password' as const,
  password: 'hunter2',
};

describe('connectionInputSchema ssh block', () => {
  it('round-trips a full ssh config and defaults the port to 22', () => {
    const parsed = connectionInputSchema.parse({ ...base, ssh });
    expect(parsed.ssh).toEqual({ ...ssh, port: 22 });
  });

  it('keeps an explicit ssh port and coerces it from a string', () => {
    const parsed = connectionInputSchema.parse({
      ...base,
      ssh: { ...ssh, port: '2222' },
    });
    expect(parsed.ssh?.port).toBe(2222);
  });

  it('accepts private-key auth with a passphrase', () => {
    const parsed = connectionInputSchema.parse({
      ...base,
      ssh: {
        ...ssh,
        authMethod: 'privateKey',
        password: undefined,
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n…',
        passphrase: 'pp',
      },
    });
    expect(parsed.ssh?.authMethod).toBe('privateKey');
    expect(parsed.ssh?.privateKey).toContain('PRIVATE KEY');
  });

  it('still parses connections without any ssh block', () => {
    const parsed = connectionInputSchema.parse(base);
    expect(parsed.ssh).toBeUndefined();
  });

  it('rejects an enabled tunnel on sqlite (file-based, nothing to tunnel)', () => {
    const result = connectionInputSchema.safeParse({
      name: 'Local file',
      engine: 'sqlite',
      database: '/tmp/data.db',
      ssh,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['ssh']);
      expect(result.error.issues[0]?.message).toMatch(/SQLite/);
    }
  });

  it('allows a disabled ssh block on sqlite (ignored, not an error)', () => {
    const result = connectionInputSchema.safeParse({
      name: 'Local file',
      engine: 'sqlite',
      database: '/tmp/data.db',
      ssh: { ...ssh, enabled: false },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an enabled tunnel combined with a connection string', () => {
    const result = connectionInputSchema.safeParse({
      ...base,
      connectionString: 'postgres://app:secret@db.internal:5432/app',
      ssh,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/connection string/);
    }
  });

  it('requires ssh host and username when a block is sent', () => {
    const result = connectionInputSchema.safeParse({
      ...base,
      ssh: { enabled: true, authMethod: 'password' },
    });
    expect(result.success).toBe(false);
  });
});
