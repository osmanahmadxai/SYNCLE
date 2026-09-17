import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ConnectionInput } from '@syncle/core';
import type { CryptoService } from '../common/crypto.service';
import type { PrismaService } from '../common/prisma.service';
import { ConnectionStoreService } from './connection-store.service';

const REDACTED = '********';

/** reversible stand-in for AES so tests can assert what was encrypted */
const fakeCrypto = {
  encrypt: (plaintext: string) =>
    `enc:${Buffer.from(plaintext).toString('base64')}`,
  decrypt: (payload: string) => {
    if (!payload.startsWith('enc:')) throw new Error('Malformed ciphertext');
    return Buffer.from(payload.slice(4), 'base64').toString('utf8');
  },
} as unknown as CryptoService;

interface FakeRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

/** minimal in-memory prisma.connection backed by a Map */
function makePrisma(): { prisma: PrismaService; rows: Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>();
  const connection = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: FakeRow = {
        ...data,
        id: data.id as string,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(row.id, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('missing row');
      Object.assign(row, data, { updatedAt: (data.updatedAt as Date) ?? new Date() });
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      rows.get(where.id) ?? null,
    findMany: async () => [...rows.values()],
    delete: async ({ where }: { where: { id: string } }) => {
      rows.delete(where.id);
    },
  };
  return { prisma: { connection } as unknown as PrismaService, rows };
}

function input(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Remote PG',
    engine: 'postgres',
    host: 'db.internal',
    port: 5432,
    user: 'app',
    password: 'db-secret',
    ssh: {
      enabled: true,
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: 'hunter2',
    },
    ...overrides,
  };
}

function makeStore() {
  const { prisma, rows } = makePrisma();
  return { store: new ConnectionStoreService(prisma, fakeCrypto), rows };
}

describe('ConnectionStoreService ssh secrets', () => {
  it('encrypts ssh secrets at rest and keeps no plaintext in the row', async () => {
    const { store, rows } = makeStore();
    const created = await store.create(input());
    const row = rows.get(created.id)!;

    expect(row.sshSecretsEnc).toMatch(/^enc:/);
    expect(fakeCrypto.decrypt(row.sshSecretsEnc as string)).toBe(
      JSON.stringify({ password: 'hunter2' }),
    );
    // the sanitized JSON keeps a blanked marker, never the value
    expect(JSON.parse(row.sshJson as string)).toMatchObject({ password: '' });
    expect(JSON.stringify(row)).not.toContain('hunter2');
  });

  it('redacts ssh secrets in list/get responses, like the db password', async () => {
    const { store } = makeStore();
    const { id } = await store.create(input());
    const config = await store.get(id);

    expect(config.password).toBe(REDACTED);
    expect(config.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: REDACTED,
    });
  });

  it('resolve() returns the decrypted ssh secrets, server-internal only', async () => {
    const { store } = makeStore();
    const { id } = await store.create(input());
    const config = await store.resolve(id);

    expect(config.password).toBe('db-secret');
    expect(config.ssh?.password).toBe('hunter2');
  });

  it('round-trips private-key auth with key and passphrase', async () => {
    const { store } = makeStore();
    const base = input();
    const { id } = await store.create(
      input({
        ssh: {
          ...base.ssh!,
          authMethod: 'privateKey',
          password: undefined,
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc',
          passphrase: 'pp',
        },
      }),
    );

    const redacted = await store.get(id);
    expect(redacted.ssh?.privateKey).toBe(REDACTED);
    expect(redacted.ssh?.passphrase).toBe(REDACTED);
    expect(redacted.ssh).not.toHaveProperty('password');

    const resolved = await store.resolve(id);
    expect(resolved.ssh?.privateKey).toContain('PRIVATE KEY');
    expect(resolved.ssh?.passphrase).toBe('pp');
  });

  it('keeps the stored secret when an update echoes the redaction sentinel', async () => {
    const { store } = makeStore();
    const base = input();
    const { id } = await store.create(base);

    await store.update(
      id,
      input({
        host: 'db2.internal',
        ssh: { ...base.ssh!, password: REDACTED },
      }),
    );

    const resolved = await store.resolve(id);
    expect(resolved.host).toBe('db2.internal');
    expect(resolved.ssh?.password).toBe('hunter2');
  });

  it('re-encrypts when an update sends a new secret value', async () => {
    const { store, rows } = makeStore();
    const base = input();
    const { id } = await store.create(base);

    await store.update(id, input({ ssh: { ...base.ssh!, password: 'rotated' } }));

    expect(fakeCrypto.decrypt(rows.get(id)!.sshSecretsEnc as string)).toBe(
      JSON.stringify({ password: 'rotated' }),
    );
    expect((await store.resolve(id)).ssh?.password).toBe('rotated');
  });

  it('merges per-field: sentinel keeps one secret while another rotates', async () => {
    const { store } = makeStore();
    const base = input();
    const { id } = await store.create(
      input({
        ssh: {
          ...base.ssh!,
          authMethod: 'privateKey',
          password: undefined,
          privateKey: 'PEM-1',
          passphrase: 'old-pp',
        },
      }),
    );

    await store.update(
      id,
      input({
        ssh: {
          ...base.ssh!,
          authMethod: 'privateKey',
          password: undefined,
          privateKey: REDACTED,
          passphrase: 'new-pp',
        },
      }),
    );

    const resolved = await store.resolve(id);
    expect(resolved.ssh?.privateKey).toBe('PEM-1');
    expect(resolved.ssh?.passphrase).toBe('new-pp');
  });

  it('clears secrets an update leaves out, and drops the whole block on demand', async () => {
    const { store, rows } = makeStore();
    const base = input();
    const { id } = await store.create(base);

    await store.update(id, input({ ssh: { ...base.ssh!, password: undefined } }));
    expect(rows.get(id)!.sshSecretsEnc).toBeNull();
    expect((await store.resolve(id)).ssh).not.toHaveProperty('password');

    await store.update(id, input({ ssh: undefined }));
    expect(rows.get(id)!.sshJson).toBeNull();
    expect((await store.get(id)).ssh).toBeUndefined();
  });
});

describe('TLS settings', () => {
  const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----';
  const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----';
  const KEY = '-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----';
  const tls = { mode: 'verify-full' as const, ca: CA, cert: CERT, key: KEY, servername: 'pg.prod' };

  it('stores certificates in the clear and the private key encrypted, never both together', async () => {
    const { prisma, rows } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const created = await store.create(input({ ssh: undefined, tls }));
    const row = rows.get(created.id)!;

    const stored = JSON.parse(row.tlsJson as string);
    expect(stored).toEqual({ mode: 'verify-full', ca: CA, cert: CERT, servername: 'pg.prod', key: '' });
    expect(row.tlsJson as string).not.toContain('very-secret');
    expect(row.tlsSecretsEnc).toBe(fakeCrypto.encrypt(KEY));
    // the old switch stays truthful for anything that still reads it
    expect(row.ssl).toBe(true);
  });

  it('returns the key redacted to the browser and whole to the server', async () => {
    const { prisma } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const { id } = await store.create(input({ ssh: undefined, tls }));
    expect((await store.get(id)).tls).toEqual({ ...tls, key: REDACTED });
    expect((await store.list())[0]!.tls!.key).toBe(REDACTED);
    expect((await store.resolve(id)).tls).toEqual(tls);
  });

  it('a redacted key on update means "keep it"; a new one replaces it; none removes it', async () => {
    const { prisma, rows } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const { id } = await store.create(input({ ssh: undefined, tls }));

    await store.update(id, input({ ssh: undefined, tls: { ...tls, key: REDACTED, mode: 'verify-ca' } }));
    expect((await store.resolve(id)).tls).toMatchObject({ mode: 'verify-ca', key: KEY });

    await store.update(id, input({ ssh: undefined, tls: { ...tls, key: 'NEW-KEY' } }));
    expect((await store.resolve(id)).tls!.key).toBe('NEW-KEY');

    await store.update(id, input({ ssh: undefined, tls: { mode: 'require' } }));
    expect(rows.get(id)!.tlsSecretsEnc).toBeNull();
    expect((await store.resolve(id)).tls).toEqual({ mode: 'require' });
  });

  it('mode "disable" turns the old switch off; no tls block leaves it as given', async () => {
    const { prisma, rows } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const off = await store.create(input({ ssh: undefined, ssl: true, tls: { mode: 'disable' } }));
    expect(rows.get(off.id)!.ssl).toBe(false);
    const legacy = await store.create(input({ ssh: undefined, ssl: true }));
    expect(rows.get(legacy.id)!.ssl).toBe(true);
    expect(rows.get(legacy.id)!.tlsJson).toBeNull();
    expect((await store.resolve(legacy.id)).tls).toBeUndefined();
  });
});

describe('pinSshHostKey (trust on first use)', () => {
  const FP = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';

  it('records the key once, without counting as an edit', async () => {
    const { prisma, rows } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const { id } = await store.create(input());
    const before = rows.get(id)!.updatedAt;

    await store.pinSshHostKey(id, FP);

    expect((await store.resolve(id)).ssh!.hostKey).toBe(FP);
    // the adapter pool reconnects when updatedAt moves; pinning must not cause that
    expect(rows.get(id)!.updatedAt).toBe(before);
    // and the ssh secrets are untouched
    expect((await store.resolve(id)).ssh!.password).toBe(input().ssh!.password);
  });

  it('never replaces a key that is already pinned', async () => {
    const { prisma } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const { id } = await store.create(input());
    await store.pinSshHostKey(id, FP);
    await store.pinSshHostKey(id, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await store.resolve(id)).ssh!.hostKey).toBe(FP);
  });

  it('is a no-op for a connection without a tunnel, or one that is gone', async () => {
    const { prisma } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const { id } = await store.create(input({ ssh: undefined }));
    await expect(store.pinSshHostKey(id, FP)).resolves.toBeUndefined();
    await expect(store.pinSshHostKey('missing', FP)).resolves.toBeUndefined();
    expect((await store.resolve(id)).ssh).toBeUndefined();
  });
});

describe('withStoredSecrets (testing an edit without retyping anything)', () => {
  it('fills in what the form only ever saw redacted, and keeps what was retyped', async () => {
    const { prisma } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const original = input({
      tls: {
        mode: 'verify-full',
        cert: '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----',
        key: 'STORED-KEY',
      },
    });
    const { id } = await store.create(original);

    // exactly what the dialog sends back for an untouched connection
    const redacted = await store.get(id);
    const merged = await store.withStoredSecrets(id, {
      ...original,
      password: redacted.password,
      ssh: { ...original.ssh!, password: REDACTED },
      tls: { ...original.tls!, key: REDACTED },
    });
    expect(merged.password).toBe(original.password);
    expect(merged.ssh!.password).toBe(original.ssh!.password);
    expect(merged.tls!.key).toBe('STORED-KEY');

    // a value the user actually changed is used as typed
    const retyped = await store.withStoredSecrets(id, { ...original, password: 'new-password' });
    expect(retyped.password).toBe('new-password');
  });

  it('writes nothing', async () => {
    const { prisma, rows } = makePrisma();
    const store = new ConnectionStoreService(prisma, fakeCrypto);
    const { id } = await store.create(input());
    const before = JSON.stringify(rows.get(id));
    await store.withStoredSecrets(id, input({ password: REDACTED }));
    expect(JSON.stringify(rows.get(id))).toBe(before);
  });
});
