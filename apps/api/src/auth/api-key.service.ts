/**
 * API keys: a credential for something that cannot type a password into a login
 * form — a script, a CI job — and should not be handed one.
 *
 *   Authorization: Bearer syn_<43 url-safe characters>
 *
 * The key is 32 random bytes and is shown once. What is stored is its SHA-256:
 * with that much entropy there is nothing to brute-force, so a fast hash is the
 * right one for something looked up on every request, and a stolen metadata
 * store yields no usable key.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  NotFoundError,
  type ApiKeyCreated,
  type ApiKeyInfo,
  type ApiKeyInputDTO,
  type ApiKeyScope,
} from '@syncle/core';
import { PrismaService } from '../common/prisma.service';

export const API_KEY_PREFIX = 'syn_';
/** how often a key's "last used" is written: not once per request */
const TOUCH_EVERY_MS = 60_000;

const sha256 = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyIdentity {
  id: string;
  name: string;
  scope: ApiKeyScope;
}

@Injectable()
export class ApiKeyService {
  private readonly touched = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  private toInfo(row: KeyRow): ApiKeyInfo {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scope: row.scope === 'full' ? 'full' : 'read',
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }

  async list(): Promise<ApiKeyInfo[]> {
    const rows = await this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toInfo(r));
  }

  async create(
    input: ApiKeyInputDTO,
    now = new Date(),
  ): Promise<ApiKeyCreated> {
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const row = await this.prisma.apiKey.create({
      data: {
        id: randomUUID(),
        name: input.name,
        prefix: key.slice(0, API_KEY_PREFIX.length + 8),
        hash: sha256(key),
        scope: input.scope,
        expiresAt: input.expiresInDays
          ? new Date(now.getTime() + input.expiresInDays * 86_400_000)
          : null,
      },
    });
    return { ...this.toInfo(row), key };
  }

  /** a revoked key stays in the list, so that "which key was that?" still has an answer */
  async revoke(id: string): Promise<ApiKeyInfo> {
    const row = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('API key not found.');
    if (row.revokedAt) return this.toInfo(row);
    return this.toInfo(
      await this.prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** who a presented key is, or null: unknown, revoked, expired, or not a key at all */
  async identify(
    presented: string | undefined,
    now = new Date(),
  ): Promise<ApiKeyIdentity | null> {
    const key = /^Bearer\s+(\S+)\s*$/i.exec(presented ?? '')?.[1];
    if (!key || !key.startsWith(API_KEY_PREFIX) || key.length > 200)
      return null;
    // looked up BY the hash: the comparison that matters happens inside the
    // index, on a value an attacker cannot choose without knowing the key
    const row = await this.prisma.apiKey.findUnique({
      where: { hash: sha256(key) },
    });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;

    const last = this.touched.get(row.id) ?? 0;
    if (now.getTime() - last > TOUCH_EVERY_MS) {
      this.touched.set(row.id, now.getTime());
      void this.prisma.apiKey
        .update({ where: { id: row.id }, data: { lastUsedAt: now } })
        .catch(() => undefined);
    }
    return {
      id: row.id,
      name: row.name,
      scope: row.scope === 'full' ? 'full' : 'read',
    };
  }
}
