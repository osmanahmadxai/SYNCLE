/**
 * persistent store for automation hooks (Prisma / PostgreSQL). nested config is kept
 * as JSON strings; the destination's auth secret is the only sensitive field and
 * is encrypted at rest in `auth_enc`, same as how `ConnectionStoreService`
 * handles passwords. callers get a redacted view unless they explicitly resolve.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Hook as HookRow } from '@prisma/client';
import {
  type Hook,
  type HookDestination,
  type HookInputDTO,
  DEFAULT_WORKSPACE_ID,
  NotFoundError,
} from '@syncle/core';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';
import type { ResolvedHook } from './hooks.types';

const REDACTED = '********';

/** the resolved-config snapshot persisted on a run (auth stays encrypted) */
interface RunSnapshot {
  name: string;
  source: HookInputDTO['source'];
  destination: HookDestination; // secret blanked out
  authEnc: string | null;
  transform: HookInputDTO['transform'];
  delivery: HookInputDTO['delivery'];
}

@Injectable()
export class HookStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /* ----- secret split / merge ----- */

  /** split the encryptable secret out from the rest of the destination */
  private splitSecret(dest: HookDestination): {
    sanitized: HookDestination;
    secret: string | null;
  } {
    // database destinations keep no secret of their own, the target connection
    // holds its (separately-encrypted) credentials
    if (dest.kind !== 'http') return { sanitized: dest, secret: null };
    const auth = dest.auth;
    if (auth.type === 'bearer') {
      return {
        sanitized: { ...dest, auth: { type: 'bearer', token: '' } },
        secret: auth.token,
      };
    }
    if (auth.type === 'header') {
      return {
        sanitized: {
          ...dest,
          auth: { type: 'header', name: auth.name, value: '' },
        },
        secret: auth.value,
      };
    }
    return { sanitized: dest, secret: null };
  }

  /** re-attach the auth secret to a sanitized destination */
  private withSecret(
    dest: HookDestination,
    secret: string | null,
  ): HookDestination {
    if (dest.kind !== 'http') return dest;
    const auth = dest.auth;
    if (auth.type === 'bearer') {
      return { ...dest, auth: { ...auth, token: secret ?? '' } };
    }
    if (auth.type === 'header') {
      return { ...dest, auth: { ...auth, value: secret ?? '' } };
    }
    return dest;
  }

  private decryptSecret(authEnc: string | null): string | null {
    return authEnc ? this.crypto.decrypt(authEnc) : null;
  }

  /* ----- row → DTO ----- */

  private toHook(row: HookRow, includeSecrets: boolean): Hook {
    const sanitized = JSON.parse(row.destinationJson) as HookDestination;
    const secret = includeSecrets
      ? this.decryptSecret(row.authEnc)
      : row.authEnc
        ? REDACTED
        : null;
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      source: JSON.parse(row.sourceJson),
      destination: this.withSecret(sanitized, secret),
      transform: JSON.parse(row.transformJson),
      delivery: JSON.parse(row.deliveryJson),
      trigger: row.triggerJson
        ? JSON.parse(row.triggerJson)
        : { kind: 'replay' },
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async getRow(id: string): Promise<HookRow> {
    const row = await this.prisma.hook.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(`Hook "${id}" not found`);
    return row;
  }

  /* ----- CRUD ----- */

  async list(workspaceId?: string): Promise<Hook[]> {
    const rows = await this.prisma.hook.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toHook(r, false));
  }

  async get(id: string): Promise<Hook> {
    return this.toHook(await this.getRow(id), false);
  }

  /** full config including the decrypted auth secret, server-internal only */
  async resolve(id: string): Promise<ResolvedHook> {
    const hook = this.toHook(await this.getRow(id), true);
    return hook;
  }

  async create(input: HookInputDTO): Promise<Hook> {
    const { sanitized, secret } = this.splitSecret(input.destination);
    const row = await this.prisma.hook.create({
      data: {
        id: randomUUID(),
        name: input.name,
        workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
        connectionId: input.source.connectionId,
        sourceJson: JSON.stringify(input.source),
        destinationJson: JSON.stringify(sanitized),
        authEnc: secret ? this.crypto.encrypt(secret) : null,
        transformJson: JSON.stringify(input.transform),
        deliveryJson: JSON.stringify(input.delivery),
        triggerJson: JSON.stringify(input.trigger),
        enabled: input.enabled,
      },
    });
    return this.toHook(row, false);
  }

  async update(id: string, input: HookInputDTO): Promise<Hook> {
    const existing = await this.getRow(id);
    const { sanitized, secret } = this.splitSecret(input.destination);

    // keep the stored secret when the client echoes the redaction sentinel
    const authEnc =
      secret === REDACTED
        ? existing.authEnc
        : secret
          ? this.crypto.encrypt(secret)
          : null;

    const row = await this.prisma.hook.update({
      where: { id },
      data: {
        name: input.name,
        connectionId: input.source.connectionId,
        sourceJson: JSON.stringify(input.source),
        destinationJson: JSON.stringify(sanitized),
        authEnc,
        transformJson: JSON.stringify(input.transform),
        deliveryJson: JSON.stringify(input.delivery),
        triggerJson: JSON.stringify(input.trigger),
        enabled: input.enabled,
      },
    });
    return this.toHook(row, false);
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.prisma.hook.delete({ where: { id } });
  }

  /* ----- run snapshot (auth kept encrypted) ----- */

  /** build the config snapshot persisted on a run */
  async snapshotJson(id: string): Promise<string> {
    const row = await this.getRow(id);
    const snapshot: RunSnapshot = {
      name: row.name,
      source: JSON.parse(row.sourceJson),
      destination: JSON.parse(row.destinationJson), // secret blanked out
      authEnc: row.authEnc,
      transform: JSON.parse(row.transformJson),
      delivery: JSON.parse(row.deliveryJson),
    };
    return JSON.stringify(snapshot);
  }

  /** decrypt a run snapshot into a runnable, fully-resolved hook config */
  resolveSnapshot(json: string): ResolvedHook {
    const s = JSON.parse(json) as RunSnapshot;
    return {
      id: '',
      name: s.name,
      source: s.source,
      destination: this.withSecret(
        s.destination,
        this.decryptSecret(s.authEnc),
      ),
      transform: s.transform,
      delivery: s.delivery,
      // a snapshot is only used to execute a replay run; the trigger is resolved
      // live for watch hooks, so a placeholder is fine here
      trigger: { kind: 'replay' },
      enabled: true,
    };
  }
}
