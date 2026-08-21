/**
 * persistent store for saved connections, backed by Prisma (PostgreSQL).
 * secrets (password, connection string, SSH credentials) are encrypted at
 * rest. callers get a redacted view unless they explicitly resolve the full
 * config
 */
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Connection as ConnectionRow } from '@prisma/client';
import {
  type ConnectionConfig,
  type ConnectionInput,
  type SshTunnelConfig,
  DEFAULT_WORKSPACE_ID,
  NotFoundError,
} from '@syncle/core';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';

const REDACTED = '********';

/** the ssh fields that hold secret material, encrypted together as one blob */
const SSH_SECRET_KEYS = ['password', 'privateKey', 'passphrase'] as const;
type SshSecretKey = (typeof SSH_SECRET_KEYS)[number];
type SshSecrets = Partial<Record<SshSecretKey, string>>;

@Injectable()
export class ConnectionStoreService {
  private readonly logger = new Logger('ConnectionStore');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** corrupt options must not make the whole connection un-listable */
  private parseOptions(id: string, json: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      this.logger.warn(`Connection ${id} has unparseable optionsJson — ignoring it`);
      return undefined;
    }
  }

  /* ----- ssh secret split / merge (same pattern as the bridge auth secret) ----- */

  /**
   * split the secret material out of an ssh block. secrets are blanked to ""
   * in the sanitized copy so their presence survives without their value —
   * mirroring how BridgeStoreService blanks the destination auth secret
   */
  private splitSsh(ssh: SshTunnelConfig | undefined): {
    sanitized: SshTunnelConfig | null;
    secrets: SshSecrets;
  } {
    if (!ssh) return { sanitized: null, secrets: {} };
    const sanitized: SshTunnelConfig = { ...ssh };
    const secrets: SshSecrets = {};
    for (const key of SSH_SECRET_KEYS) {
      const value = sanitized[key];
      if (value) {
        secrets[key] = value;
        sanitized[key] = '';
      } else {
        delete sanitized[key];
      }
    }
    return { sanitized, secrets };
  }

  private encryptSshSecrets(secrets: SshSecrets): string | null {
    return Object.keys(secrets).length
      ? this.crypto.encrypt(JSON.stringify(secrets))
      : null;
  }

  private decryptSshSecrets(sshSecretsEnc: string | null): SshSecrets {
    return sshSecretsEnc
      ? (JSON.parse(this.crypto.decrypt(sshSecretsEnc)) as SshSecrets)
      : {};
  }

  /** rebuild the ssh block from a row, decrypted or redacted */
  private sshFromRow(
    row: ConnectionRow,
    includeSecrets: boolean,
  ): SshTunnelConfig | undefined {
    if (!row.sshJson) return undefined;
    let ssh: SshTunnelConfig;
    try {
      ssh = JSON.parse(row.sshJson) as SshTunnelConfig;
    } catch {
      this.logger.warn(`Connection ${row.id} has unparseable sshJson — ignoring it`);
      return undefined;
    }
    const secrets = includeSecrets ? this.decryptSshSecrets(row.sshSecretsEnc) : {};
    for (const key of SSH_SECRET_KEYS) {
      if (ssh[key] === undefined) continue; // no secret stored for this field
      ssh[key] = includeSecrets ? (secrets[key] ?? '') : REDACTED;
    }
    return ssh;
  }

  private toConfig(row: ConnectionRow, includeSecrets: boolean): ConnectionConfig {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      engine: row.engine as ConnectionConfig['engine'],
      color: row.color ?? undefined,
      host: row.host ?? undefined,
      port: row.port ?? undefined,
      user: row.user ?? undefined,
      password:
        includeSecrets && row.passwordEnc
          ? this.crypto.decrypt(row.passwordEnc)
          : row.passwordEnc
            ? REDACTED
            : undefined,
      database: row.database ?? undefined,
      ssl: row.ssl,
      connectionString:
        includeSecrets && row.connectionStringEnc
          ? this.crypto.decrypt(row.connectionStringEnc)
          : row.connectionStringEnc
            ? REDACTED
            : undefined,
      options: row.optionsJson
        ? this.parseOptions(row.id, row.optionsJson)
        : undefined,
      ssh: this.sshFromRow(row, includeSecrets),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async getRow(id: string): Promise<ConnectionRow> {
    const row = await this.prisma.connection.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(`Connection "${id}" not found`);
    return row;
  }

  async list(workspaceId?: string): Promise<ConnectionConfig[]> {
    const rows = await this.prisma.connection.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toConfig(r, false));
  }

  async get(id: string): Promise<ConnectionConfig> {
    return this.toConfig(await this.getRow(id), false);
  }

  /** full config including decrypted secrets, server-internal use only */
  async resolve(id: string): Promise<ConnectionConfig> {
    return this.toConfig(await this.getRow(id), true);
  }

  async create(input: ConnectionInput): Promise<ConnectionConfig> {
    const { sanitized: ssh, secrets: sshSecrets } = this.splitSsh(input.ssh);
    const row = await this.prisma.connection.create({
      data: {
        id: randomUUID(),
        name: input.name,
        workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
        engine: input.engine,
        color: input.color ?? null,
        host: input.host ?? null,
        port: input.port ?? null,
        user: input.user ?? null,
        passwordEnc: input.password ? this.crypto.encrypt(input.password) : null,
        database: input.database ?? null,
        ssl: input.ssl ?? false,
        connectionStringEnc: input.connectionString
          ? this.crypto.encrypt(input.connectionString)
          : null,
        optionsJson: input.options ? JSON.stringify(input.options) : null,
        sshJson: ssh ? JSON.stringify(ssh) : null,
        sshSecretsEnc: this.encryptSshSecrets(sshSecrets),
      },
    });
    return this.toConfig(row, false);
  }

  async update(id: string, input: ConnectionInput): Promise<ConnectionConfig> {
    const existing = await this.getRow(id);

    // keep stored secrets when the client sends the redaction sentinel
    const passwordEnc =
      input.password === REDACTED
        ? existing.passwordEnc
        : input.password
          ? this.crypto.encrypt(input.password)
          : null;
    const connectionStringEnc =
      input.connectionString === REDACTED
        ? existing.connectionStringEnc
        : input.connectionString
          ? this.crypto.encrypt(input.connectionString)
          : null;

    // same sentinel rule per ssh secret field: a redacted value means "keep
    // what's stored", anything else replaces (or clears) it
    const { sanitized: ssh, secrets: sshInput } = this.splitSsh(input.ssh);
    const stored = Object.values(sshInput).includes(REDACTED)
      ? this.decryptSshSecrets(existing.sshSecretsEnc)
      : {};
    const sshSecrets: SshSecrets = {};
    for (const key of SSH_SECRET_KEYS) {
      const value = sshInput[key] === REDACTED ? stored[key] : sshInput[key];
      if (value) sshSecrets[key] = value;
      // drop the presence marker when the sentinel matched nothing stored
      else if (ssh && ssh[key] !== undefined) delete ssh[key];
    }

    try {
      const row = await this.prisma.connection.update({
        where: { id },
        data: {
          name: input.name,
          engine: input.engine,
          color: input.color ?? null,
          host: input.host ?? null,
          port: input.port ?? null,
          user: input.user ?? null,
          passwordEnc,
          database: input.database ?? null,
          ssl: input.ssl ?? false,
          connectionStringEnc,
          optionsJson: input.options ? JSON.stringify(input.options) : null,
          sshJson: ssh ? JSON.stringify(ssh) : null,
          sshSecretsEnc: this.encryptSshSecrets(sshSecrets),
        },
      });
      return this.toConfig(row, false);
    } catch (err) {
      throw this.mapMissing(err, id);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.connection.delete({ where: { id } });
    } catch (err) {
      throw this.mapMissing(err, id);
    }
  }

  /** a concurrent delete between read and write should 404, not 500 */
  private mapMissing(err: unknown, id: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      return new NotFoundError(`Connection "${id}" not found`);
    }
    return err;
  }
}
