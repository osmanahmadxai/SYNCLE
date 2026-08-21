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
      Object.assign(row, data, { updatedAt: new Date() });
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
