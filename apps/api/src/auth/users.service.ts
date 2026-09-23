/**
 * the accounts, as an admin manages them.
 *
 * one account is made at first run, an admin. it can make more, each with a
 * role (see core's userRoleSchema). two things are never allowed, because they
 * would lock everybody out: the last admin that can sign in cannot be demoted,
 * disabled or deleted, and nobody deletes their own account.
 *
 * a deleted account is gone; a DISABLED one stays, so that what it did in the
 * audit log stays attributed to somebody who can be looked up.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AppUser } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  type UserInfo,
  type UserInputDTO,
  type UserRole,
  type UserUpdateDTO,
} from '@syncle/core';
import { PrismaService } from '../common/prisma.service';
import { AuthService, CLEARED_RESET } from './auth.service';

export const roleOf = (user: Pick<AppUser, 'role'>): UserRole =>
  user.role === 'operator' || user.role === 'viewer' ? user.role : 'admin';

export function toUserInfo(user: AppUser): UserInfo {
  return {
    id: user.id,
    username: user.username,
    role: roleOf(user),
    disabledAt: user.disabledAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async list(): Promise<UserInfo[]> {
    const rows = await this.prisma.appUser.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toUserInfo);
  }

  async create(input: UserInputDTO): Promise<UserInfo> {
    const taken = await this.prisma.appUser.findUnique({
      where: { username: input.username },
    });
    if (taken)
      throw new ConflictError(
        `There is already an account called "${input.username}".`,
      );
    try {
      const row = await this.prisma.appUser.create({
        data: {
          id: randomUUID(),
          username: input.username,
          passwordHash: await this.auth.hashPassword(input.password),
          role: input.role,
        },
      });
      return toUserInfo(row);
    } catch (err) {
      // two admins making the same name at once: the second is told what the first would have been
      if ((err as { code?: string }).code === 'P2002')
        throw new ConflictError(
          `There is already an account called "${input.username}".`,
        );
      throw err;
    }
  }

  async update(
    id: string,
    patch: UserUpdateDTO,
    by: AppUser,
  ): Promise<UserInfo> {
    const user = await this.get(id);
    const stopsBeingAdmin =
      roleOf(user) === 'admin' &&
      !user.disabledAt &&
      ((patch.role !== undefined && patch.role !== 'admin') ||
        patch.disabled === true);
    if (stopsBeingAdmin)
      await this.assertAnotherAdmin(user, 'demoted or disabled');
    if (patch.disabled === true && user.id === by.id) {
      throw new BadRequestError(
        'You cannot disable your own account while signed in with it.',
      );
    }
    const row = await this.prisma.appUser.update({
      where: { id },
      data: {
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.disabled === true
          ? {
              disabledAt: user.disabledAt ?? new Date(),
              sessionVersion: { increment: 1 },
            }
          : patch.disabled === false
            ? { disabledAt: null }
            : {}),
        // a password set by an admin: whoever was signed in with the old one no longer is
        ...(patch.newPassword !== undefined
          ? {
              passwordHash: await this.auth.hashPassword(patch.newPassword),
              sessionVersion: { increment: 1 },
              ...CLEARED_RESET,
            }
          : {}),
      },
    });
    return toUserInfo(row);
  }

  async remove(
    id: string,
    by: AppUser,
  ): Promise<{ id: string; username: string }> {
    const user = await this.get(id);
    if (user.id === by.id) {
      throw new BadRequestError(
        'You cannot delete the account you are signed in with. Sign in as another admin to delete it.',
      );
    }
    if (roleOf(user) === 'admin' && !user.disabledAt)
      await this.assertAnotherAdmin(user, 'deleted');
    await this.prisma.appUser.delete({ where: { id } });
    return { id: user.id, username: user.username };
  }

  /** every session of the account ends; it can sign in again */
  async endSessions(id: string): Promise<UserInfo> {
    await this.get(id);
    const row = await this.prisma.appUser.update({
      where: { id },
      data: { sessionVersion: { increment: 1 } },
    });
    return toUserInfo(row);
  }

  private async get(id: string): Promise<AppUser> {
    const user = await this.prisma.appUser.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('There is no such account.');
    return user;
  }

  /** an admin that can sign in has to be left */
  private async assertAnotherAdmin(user: AppUser, what: string): Promise<void> {
    const others = await this.prisma.appUser.count({
      where: { id: { not: user.id }, role: 'admin', disabledAt: null },
    });
    if (others === 0) {
      throw new BadRequestError(
        `"${user.username}" is the only admin that can sign in, and cannot be ${what}: make another account an admin first.`,
      );
    }
  }
}
