import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { API_KEY_PREFIX, ApiKeyService } from './api-key.service';

/** an in-memory `api_keys` table */
function store() {
  const rows: Array<Record<string, any>> = [];
  const prisma = {
    apiKey: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const row = {
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(async () => [...rows]),
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; hash?: string } }) =>
          rows.find((r) =>
            where.id ? r.id === where.id : r.hash === where.hash,
          ) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, any>;
        }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
  return { rows, prisma, service: new ApiKeyService(prisma as never) };
}

describe('creating a key', () => {
  it('hands the key out once, and keeps only a hash of it', async () => {
    const { rows, service } = store();
    const created = await service.create({ name: 'ci', scope: 'read' });
    expect(created.key).toMatch(/^syn_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.key.slice(0, 12));
    expect(rows[0]!.hash).toBe(
      createHash('sha256').update(created.key).digest('hex'),
    );
    // nothing stored contains the key, or enough of it to matter
    expect(JSON.stringify(rows[0])).not.toContain(created.key);
    expect(JSON.stringify(await service.list())).not.toContain(
      created.key.slice(12),
    );
    // two keys are two keys
    expect((await service.create({ name: 'ci', scope: 'read' })).key).not.toBe(
      created.key,
    );
  });

  it('expires when it was asked to, and not otherwise', async () => {
    const { service } = store();
    const now = new Date('2026-09-17T10:00:00.000Z');
    expect(
      (await service.create({ name: 'a', scope: 'full' }, now)).expiresAt,
    ).toBeNull();
    expect(
      (
        await service.create(
          { name: 'b', scope: 'full', expiresInDays: 30 },
          now,
        )
      ).expiresAt,
    ).toBe('2026-10-17T10:00:00.000Z');
  });
});

describe('presenting a key', () => {
  it('is known by its hash, with its scope', async () => {
    const { service } = store();
    const { key, id } = await service.create({ name: 'deploy', scope: 'full' });
    expect(await service.identify(`Bearer ${key}`)).toEqual({
      id,
      name: 'deploy',
      scope: 'full',
    });
    expect(await service.identify(`bearer   ${key}  `)).toMatchObject({ id });
  });

  it('is nobody when it is not a key, not this key, revoked, or expired', async () => {
    const { service, prisma } = store();
    const now = new Date('2026-09-17T10:00:00.000Z');
    const { key, id } = await service.create(
      { name: 'k', scope: 'read', expiresInDays: 1 },
      now,
    );
    for (const presented of [
      undefined,
      '',
      key,
      `Basic ${key}`,
      'Bearer ',
      'Bearer nonsense',
      `Bearer ${key}x`,
      `Bearer ${API_KEY_PREFIX}${'a'.repeat(500)}`,
    ]) {
      expect(
        await service.identify(presented, now),
        String(presented),
      ).toBeNull();
    }
    // something that is not shaped like a key does not even reach the store
    prisma.apiKey.findUnique.mockClear();
    await service.identify('Bearer some-session-or-metrics-token', now);
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();

    expect(
      await service.identify(
        `Bearer ${key}`,
        new Date(now.getTime() + 86_400_000 - 1),
      ),
    ).not.toBeNull();
    expect(
      await service.identify(
        `Bearer ${key}`,
        new Date(now.getTime() + 86_400_000),
      ),
    ).toBeNull();

    const other = await service.create({ name: 'gone', scope: 'full' }, now);
    expect((await service.revoke(other.id)).revokedAt).not.toBeNull();
    expect(await service.identify(`Bearer ${other.key}`, now)).toBeNull();
    // still listed: "which key was that?" has an answer
    expect((await service.list()).map((k) => k.id)).toContain(other.id);
    // revoking twice keeps the first time
    const first = (await service.revoke(other.id)).revokedAt;
    expect((await service.revoke(other.id)).revokedAt).toBe(first);
    await expect(service.revoke('no-such-key')).rejects.toThrow(/not found/i);
    expect(id).toBeTruthy();
  });

  it('notes when it was last used — once a minute, not once a request', async () => {
    const { service, prisma } = store();
    const { key } = await service.create({ name: 'busy', scope: 'read' });
    const t0 = new Date('2026-09-17T10:00:00.000Z');
    for (let i = 0; i < 25; i++)
      await service.identify(
        `Bearer ${key}`,
        new Date(t0.getTime() + i * 1000),
      );
    expect(prisma.apiKey.update).toHaveBeenCalledTimes(1);
    await service.identify(`Bearer ${key}`, new Date(t0.getTime() + 61_000));
    expect(prisma.apiKey.update).toHaveBeenCalledTimes(2);
  });
});
