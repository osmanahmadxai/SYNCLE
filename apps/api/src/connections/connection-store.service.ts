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
  type TlsConfig,
  DEFAULT_WORKSPACE_ID,
  NotFoundError,
  BadRequestError,
} from '@syncle/core';
import { getDriver, reachHostFromContainer } from '@syncle/core/adapters';
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

  /* ----- tls: the client key is the one secret; everything else is public ----- */

  /** the key is blanked to "" in the stored JSON so its presence survives */
  private splitTls(tls: TlsConfig | undefined): { sanitized: TlsConfig | null; key: string } {
    if (!tls) return { sanitized: null, key: '' };
    const { key, ...rest } = tls;
    const trimmed = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => typeof v !== 'string' || v.trim() !== ''),
    ) as unknown as TlsConfig;
    return { sanitized: key ? { ...trimmed, key: '' } : trimmed, key: key ?? '' };
  }

  private tlsFromRow(row: ConnectionRow, includeSecrets: boolean): TlsConfig | undefined {
    if (!row.tlsJson) return undefined;
    let tls: TlsConfig;
    try {
      tls = JSON.parse(row.tlsJson) as TlsConfig;
    } catch {
      this.logger.warn(`Connection ${row.id} has unparseable tlsJson — ignoring it`);
      return undefined;
    }
    if (tls.key === undefined) return tls;
    return {
      ...tls,
      key: includeSecrets
        ? row.tlsSecretsEnc
          ? this.crypto.decrypt(row.tlsSecretsEnc)
          : ''
        : REDACTED,
    };
  }

  private toConfig(row: ConnectionRow, includeSecrets: boolean): ConnectionConfig {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      engine: row.engine as ConnectionConfig['engine'],
      color: row.color ?? undefined,
      readOnly: row.readOnly || undefined,
      environment: (row.environment ?? undefined) as ConnectionConfig['environment'],
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
      tls: this.tlsFromRow(row, includeSecrets),
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

  /**
   * full config including decrypted secrets, server-internal use only.
   *
   * This is where every dial the server makes comes from — the workbench, a
   * replay, a change stream, a dead-letter retry — so it is also where a
   * loopback address is pointed at the host running Syncle when Syncle is in a
   * container. What is stored and shown is left exactly as it was typed; only
   * the copy handed to a driver is corrected, and a tunnelled connection is
   * never touched (see reachHostFromContainer).
   */
  async resolve(id: string): Promise<ConnectionConfig> {
    return reachHostFromContainer(this.toConfig(await this.getRow(id), true));
  }

  /**
   * the schema lists the engines, the registry holds the drivers, and nothing
   * used to check one against the other at the door — so a connection to an
   * engine with no driver was saved, and every later use of it answered 501
   */
  private assertDriver(engine: string): void {
    if (!getDriver(engine as ConnectionConfig['engine'])) {
      throw new BadRequestError(`This build of Syncle has no driver for "${engine}".`);
    }
  }

  async create(input: ConnectionInput): Promise<ConnectionConfig> {
    this.assertDriver(input.engine);
    const { sanitized: ssh, secrets: sshSecrets } = this.splitSsh(input.ssh);
    const { sanitized: tls, key: tlsKey } = this.splitTls(input.tls);
    const row = await this.prisma.connection.create({
      data: {
        id: randomUUID(),
        name: input.name,
        workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
        engine: input.engine,
        color: input.color ?? null,
        readOnly: input.readOnly === true,
        environment: input.environment ?? null,
        host: input.host ?? null,
        port: input.port ?? null,
        user: input.user ?? null,
        passwordEnc: input.password ? this.crypto.encrypt(input.password) : null,
        database: input.database ?? null,
        // the old switch stays truthful for anything that still reads it
        ssl: tls ? tls.mode !== 'disable' : (input.ssl ?? false),
        connectionStringEnc: input.connectionString
          ? this.crypto.encrypt(input.connectionString)
          : null,
        optionsJson: input.options ? JSON.stringify(input.options) : null,
        sshJson: ssh ? JSON.stringify(ssh) : null,
        sshSecretsEnc: this.encryptSshSecrets(sshSecrets),
        tlsJson: tls ? JSON.stringify(tls) : null,
        tlsSecretsEnc: tlsKey ? this.crypto.encrypt(tlsKey) : null,
      },
    });
    return this.toConfig(row, false);
  }

  async update(id: string, input: ConnectionInput): Promise<ConnectionConfig> {
    this.assertDriver(input.engine);
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

    // the client key follows the same sentinel rule as every other secret
    const { sanitized: tls, key: tlsKeyInput } = this.splitTls(input.tls);
    const tlsSecretsEnc =
      tlsKeyInput === REDACTED
        ? existing.tlsSecretsEnc
        : tlsKeyInput
          ? this.crypto.encrypt(tlsKeyInput)
          : null;
    if (tls && tls.key !== undefined && !tlsSecretsEnc) delete tls.key;

    try {
      const row = await this.prisma.connection.update({
        where: { id },
        data: {
          name: input.name,
          engine: input.engine,
          color: input.color ?? null,
          readOnly: input.readOnly === true,
          environment: input.environment ?? null,
          host: input.host ?? null,
          port: input.port ?? null,
          user: input.user ?? null,
          passwordEnc,
          database: input.database ?? null,
          ssl: tls ? tls.mode !== 'disable' : (input.ssl ?? false),
          connectionStringEnc,
          optionsJson: input.options ? JSON.stringify(input.options) : null,
          sshJson: ssh ? JSON.stringify(ssh) : null,
          sshSecretsEnc: this.encryptSshSecrets(sshSecrets),
          tlsJson: tls ? JSON.stringify(tls) : null,
          tlsSecretsEnc,
        },
      });
      return this.toConfig(row, false);
    } catch (err) {
      throw this.mapMissing(err, id);
    }
  }

  /**
   * an edit form's payload with every REDACTED secret replaced by the stored
   * value, for testing an edit before it is saved. nothing is written; a secret
   * the user actually retyped is used as typed.
   */
  async withStoredSecrets<T extends ConnectionInput>(id: string, input: T): Promise<T> {
    const stored = await this.resolve(id);
    const keep = <V>(given: V, saved: V): V => (given === (REDACTED as unknown) ? saved : given);
    return {
      ...input,
      password: keep(input.password, stored.password),
      connectionString: keep(input.connectionString, stored.connectionString),
      ...(input.ssh
        ? {
            ssh: {
              ...input.ssh,
              password: keep(input.ssh.password, stored.ssh?.password),
              privateKey: keep(input.ssh.privateKey, stored.ssh?.privateKey),
              passphrase: keep(input.ssh.passphrase, stored.ssh?.passphrase),
            },
          }
        : {}),
      ...(input.tls ? { tls: { ...input.tls, key: keep(input.tls.key, stored.tls?.key) } } : {}),
    };
  }

  /**
   * record the jump host's key the first time a tunnel connects (trust on first
   * use). never overwrites a fingerprint that is already pinned — a CHANGED key
   * is refused by the tunnel, and only the operator may accept a new one.
   * `updatedAt` is kept as it was: this is bookkeeping, not an edit, and the
   * adapter pool treats a new `updatedAt` as "reconnect".
   */
  async pinSshHostKey(id: string, fingerprint: string): Promise<void> {
    const row = await this.prisma.connection.findUnique({ where: { id } });
    if (!row?.sshJson) return;
    let ssh: SshTunnelConfig;
    try {
      ssh = JSON.parse(row.sshJson) as SshTunnelConfig;
    } catch {
      return;
    }
    if (ssh.hostKey?.trim()) return;
    await this.prisma.connection.update({
      where: { id },
      data: {
        sshJson: JSON.stringify({ ...ssh, hostKey: fingerprint }),
        updatedAt: row.updatedAt,
      },
    });
    this.logger.log(`Pinned the SSH host key of ${ssh.host} for connection ${id}: ${fingerprint}`);
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
