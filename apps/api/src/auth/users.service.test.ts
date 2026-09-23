/**
 * the accounts, as an admin manages them — the rules that keep an installation
 * from locking everybody out, with the database replaced by a double
 */
import { describe, expect, it } from 'vitest';
import type { AppUser } from '@prisma/client';
import { UsersService } from './users.service';

function fakePrisma(
  seed: Array<Partial<AppUser> & { id: string; username: string }>,
) {
  const users = new Map<string, AppUser>();
  for (const u of seed) {
    users.set(u.id, {
      passwordHash: 'x',
      sessionVersion: 0,
      resetCodeHash: null,
      resetCodeMintedAt: null,
      resetCodeExpiresAt: null,
      resetCodeFailures: 0,
      role: 'admin',
      disabledAt: null,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...u,
    } as AppUser);
  }
  const matches = (u: AppUser, where: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(where)) {
      const own = (u as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object' && 'not' in (value as object)) {
        if (own === (value as { not: unknown }).not) return false;
      } else if (own !== value) return false;
    }
    return true;
  };
  return {
    users,
    appUser: {
      findMany: async () => [...users.values()],
      findUnique: async ({
        where,
      }: {
        where: { id?: string; username?: string };
      }) =>
        [...users.values()].find((u) =>
          where.id ? u.id === where.id : u.username === where.username,
        ) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) =>
        [...users.values()].filter((u) => matches(u, where)).length,
      create: async ({
        data,
      }: {
        data: Partial<AppUser> & { id: string; username: string };
      }) => {
        if ([...users.values()].some((u) => u.username === data.username))
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = {
          ...[...users.values()][0]!,
          sessionVersion: 0,
          disabledAt: null,
          ...data,
        } as AppUser;
        users.set(row.id, row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const user = users.get(where.id)!;
        const next = { ...user } as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          const step = (value as { increment?: number } | null)?.increment;
          next[key] =
            typeof step === 'number' ? (next[key] as number) + step : value;
        }
        users.set(where.id, next as unknown as AppUser);
        return next as unknown as AppUser;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const user = users.get(where.id)!;
        users.delete(where.id);
        return user;
      },
    },
  };
}

const auth = { hashPassword: async (p: string) => `hashed:${p}` };

function make(seed: Parameters<typeof fakePrisma>[0]) {
  const prisma = fakePrisma(seed);
  return { prisma, service: new UsersService(prisma as never, auth as never) };
}

const root = { id: 'root', username: 'root', role: 'admin' };
const me = { id: 'root', username: 'root' } as AppUser;

describe('making accounts', () => {
  it('an account is an operator unless said otherwise, and its password is hashed', async () => {
    const { service, prisma } = make([root]);
    const made = await service.create({
      username: 'sam',
      password: 'correct horse battery',
      role: 'operator',
    });
    expect(made).toMatchObject({
      username: 'sam',
      role: 'operator',
      disabledAt: null,
    });
    expect(prisma.users.get(made.id)!.passwordHash).toBe(
      'hashed:correct horse battery',
    );
    expect(await service.list()).toHaveLength(2);
  });

  it('a name that is taken is refused, and so is one taken a moment ago by another admin', async () => {
    const { service } = make([root]);
    await expect(
      service.create({
        username: 'root',
        password: 'correct horse battery',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the last admin', () => {
  it('cannot be demoted, disabled or deleted — make another admin first', async () => {
    const { service } = make([
      root,
      { id: 'ops', username: 'ops', role: 'operator' },
    ]);
    const other = { id: 'ops', username: 'ops' } as AppUser;
    await expect(
      service.update('root', { role: 'operator' }, other),
    ).rejects.toThrow(/only admin/);
    await expect(
      service.update('root', { disabled: true }, other),
    ).rejects.toThrow(/only admin/);
    await expect(service.remove('root', other)).rejects.toThrow(/only admin/);
    // the way out: promote another, then it is allowed
    await service.update('ops', { role: 'admin' }, me);
    await expect(
      service.update('root', { role: 'viewer' }, other),
    ).resolves.toMatchObject({ role: 'viewer' });
  });

  it('a DISABLED admin does not count as the other admin', async () => {
    const { service } = make([
      root,
      { id: 'old', username: 'old', role: 'admin', disabledAt: new Date() },
    ]);
    await expect(
      service.update('root', { role: 'operator' }, me),
    ).rejects.toThrow(/only admin/);
  });

  it('a password can still be set for the last admin: that locks nobody out', async () => {
    const { service, prisma } = make([root]);
    await service.update('root', { newPassword: 'another good password' }, me);
    expect(prisma.users.get('root')!.passwordHash).toBe(
      'hashed:another good password',
    );
  });
});

describe('your own account', () => {
  it('cannot be deleted or disabled while you are signed in with it', async () => {
    const { service } = make([
      root,
      { id: 'two', username: 'two', role: 'admin' },
    ]);
    await expect(service.remove('root', me)).rejects.toThrow(/signed in with/);
    await expect(
      service.update('root', { disabled: true }, me),
    ).rejects.toThrow(/own account/);
    // another admin can
    const other = { id: 'two', username: 'two' } as AppUser;
    await expect(
      service.update('root', { disabled: true }, other),
    ).resolves.toMatchObject({ disabledAt: expect.any(String) });
  });
});

describe('disabling, enabling, passwords and sessions', () => {
  it('disabling ends every session; enabling lets it sign in again; disabling twice keeps the first date', async () => {
    const { service, prisma } = make([
      root,
      { id: 'v', username: 'v', role: 'viewer' },
    ]);
    await service.update('v', { disabled: true }, me);
    const first = prisma.users.get('v')!;
    expect(first.sessionVersion).toBe(1);
    expect(first.disabledAt).toBeInstanceOf(Date);
    await service.update('v', { disabled: true }, me);
    expect(prisma.users.get('v')!.disabledAt).toBe(first.disabledAt);
    await service.update('v', { disabled: false }, me);
    expect(prisma.users.get('v')!.disabledAt).toBeNull();
  });

  it('a password set by an admin ends the sessions that had the old one, and cancels a reset that was asked for', async () => {
    const { service, prisma } = make([
      root,
      {
        id: 'v',
        username: 'v',
        role: 'viewer',
        resetCodeHash: 'h',
        resetCodeExpiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await service.update('v', { newPassword: 'set by an admin' }, me);
    const v = prisma.users.get('v')!;
    expect(v.passwordHash).toBe('hashed:set by an admin');
    expect(v.sessionVersion).toBe(1);
    expect(v.resetCodeHash).toBeNull();
  });

  it('ending the sessions changes nothing else', async () => {
    const { service, prisma } = make([
      root,
      { id: 'v', username: 'v', role: 'viewer' },
    ]);
    await service.endSessions('v');
    expect(prisma.users.get('v')!.sessionVersion).toBe(1);
    expect(prisma.users.get('v')!.disabledAt).toBeNull();
  });

  it('an account that is not there is said to be not there', async () => {
    const { service } = make([root]);
    await expect(
      service.update('nope', { role: 'viewer' }, me),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.remove('nope', me)).rejects.toMatchObject({
      status: 404,
    });
  });
});
