/**
 * alert channels at rest: the whole configuration encrypted (a Slack webhook
 * URL is its credential), and never handed back in the clear.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ALERT_SECRET_SENTINEL,
  BadRequestError,
  NotFoundError,
  alertChannelInputSchema,
  type AlertChannel,
  type AlertChannelInput,
  type AlertEventType,
} from '@syncle/core';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';

interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  eventsJson: string;
  configEnc: string;
  lastStatus: string | null;
  lastError: string | null;
  lastSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** a channel with its secrets, for sending. never leaves the process */
export type StoredChannel = AlertChannelInput & { id: string };

/** everything after the origin can be a credential (Slack: all of it is) */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`;
    return rest === '/' || rest === ''
      ? u.origin
      : `${u.origin}/${ALERT_SECRET_SENTINEL}`;
  } catch {
    return ALERT_SECRET_SENTINEL;
  }
}

const isMasked = (value: string | undefined): boolean =>
  typeof value === 'string' && value.includes(ALERT_SECRET_SENTINEL);

/** the channel as it may be shown */
export function redact(input: AlertChannelInput): AlertChannelInput {
  switch (input.kind) {
    case 'webhook':
      return {
        ...input,
        url: maskUrl(input.url),
        ...(input.secret ? { secret: ALERT_SECRET_SENTINEL } : {}),
        ...(input.headers
          ? {
              headers: Object.fromEntries(
                Object.keys(input.headers).map((k) => [
                  k,
                  ALERT_SECRET_SENTINEL,
                ]),
              ),
            }
          : {}),
      };
    case 'slack':
      return { ...input, url: maskUrl(input.url) };
    case 'email':
      return {
        ...input,
        smtp: {
          ...input.smtp,
          ...(input.smtp.password ? { password: ALERT_SECRET_SENTINEL } : {}),
        },
      };
  }
}

/**
 * an update as it should be stored: wherever the form sent back what it was
 * shown (the sentinel), what is stored stays. a change of KIND keeps nothing
 */
export function mergeSecrets(
  next: AlertChannelInput,
  stored: AlertChannelInput | null,
): AlertChannelInput {
  if (!stored || stored.kind !== next.kind) return next;
  switch (next.kind) {
    case 'webhook': {
      const before = stored as Extract<AlertChannelInput, { kind: 'webhook' }>;
      const headers = next.headers
        ? Object.fromEntries(
            Object.entries(next.headers).map(([k, v]) => [
              k,
              isMasked(v) && before.headers?.[k] !== undefined
                ? before.headers[k]!
                : v,
            ]),
          )
        : undefined;
      return {
        ...next,
        url: isMasked(next.url) ? before.url : next.url,
        secret: isMasked(next.secret) ? before.secret : next.secret,
        headers,
      };
    }
    case 'slack':
      return {
        ...next,
        url: isMasked(next.url) ? (stored as typeof next).url : next.url,
      };
    case 'email': {
      const before = stored as Extract<AlertChannelInput, { kind: 'email' }>;
      return {
        ...next,
        smtp: {
          ...next.smtp,
          password: isMasked(next.smtp.password)
            ? before.smtp.password
            : next.smtp.password,
        },
      };
    }
  }
}

/**
 * a mask that is still a mask after merging stands for nothing: a new channel
 * (or a change of kind) sent with `••••••••` where a URL or a secret belongs.
 * stored, it would be a channel that posts to `https://host/••••••••`, signed
 * with the literal dots — and that looks, in the list, exactly like one that works
 */
export function assertNoMaskLeft(input: AlertChannelInput): void {
  const masked: string[] = [];
  if (input.kind !== 'email' && isMasked(input.url)) masked.push('the URL');
  if (input.kind === 'webhook') {
    if (isMasked(input.secret)) masked.push('the signing secret');
    for (const [k, v] of Object.entries(input.headers ?? {}))
      if (isMasked(v)) masked.push(`the header "${k}"`);
  }
  if (input.kind === 'email' && isMasked(input.smtp.password))
    masked.push('the SMTP password');
  if (masked.length) {
    throw new BadRequestError(
      `Nothing is stored for ${masked.join(', ')} to be kept from: type ${masked.length === 1 ? 'it' : 'them'} in.`,
    );
  }
}

@Injectable()
export class AlertChannelStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  private config(row: ChannelRow): AlertChannelInput {
    return alertChannelInputSchema.parse(
      JSON.parse(this.crypto.decrypt(row.configEnc)),
    );
  }

  private toDto(row: ChannelRow): AlertChannel {
    return {
      ...redact(this.config(row)),
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastStatus:
        row.lastStatus === 'ok' || row.lastStatus === 'failed'
          ? row.lastStatus
          : null,
      lastError: row.lastError,
      lastSentAt: row.lastSentAt?.toISOString() ?? null,
    };
  }

  async list(): Promise<AlertChannel[]> {
    const rows = await this.prisma.alertChannel.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  private async row(id: string): Promise<ChannelRow> {
    const row = await this.prisma.alertChannel.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Alert channel not found.');
    return row;
  }

  /** with its secrets: for sending only */
  async resolve(id: string): Promise<StoredChannel> {
    const row = await this.row(id);
    return { ...this.config(row), id: row.id };
  }

  /** the enabled channels that asked for this kind of event, with their secrets */
  async subscribers(type: AlertEventType): Promise<StoredChannel[]> {
    const rows = await this.prisma.alertChannel.findMany({
      where: { enabled: true },
    });
    const out: StoredChannel[] = [];
    for (const row of rows) {
      try {
        if (!(JSON.parse(row.eventsJson) as string[]).includes(type)) continue;
        out.push({ ...this.config(row), id: row.id });
      } catch {
        // one channel that cannot be read (a changed master key) must not
        // silence the others
      }
    }
    return out;
  }

  async create(input: AlertChannelInput): Promise<AlertChannel> {
    assertNoMaskLeft(input);
    const row = await this.prisma.alertChannel.create({
      data: { id: randomUUID(), ...this.columns(input) },
    });
    return this.toDto(row);
  }

  async update(id: string, input: AlertChannelInput): Promise<AlertChannel> {
    const before = await this.row(id);
    let stored: AlertChannelInput | null = null;
    try {
      stored = this.config(before);
    } catch {
      stored = null; // unreadable: whatever is sent now replaces it outright
    }
    const merged = alertChannelInputSchema.parse(mergeSecrets(input, stored));
    assertNoMaskLeft(merged);
    const row = await this.prisma.alertChannel.update({
      where: { id },
      data: this.columns(merged),
    });
    return this.toDto(row);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.prisma.alertChannel.delete({ where: { id } });
  }

  async recordOutcome(
    id: string,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    await this.prisma.alertChannel
      .update({
        where: { id },
        data: {
          lastStatus: ok ? 'ok' : 'failed',
          lastError: ok ? null : (error ?? 'failed').slice(0, 1000),
          lastSentAt: new Date(),
        },
      })
      .catch(() => undefined); // deleted meanwhile
  }

  private columns(input: AlertChannelInput) {
    return {
      name: input.name,
      kind: input.kind,
      enabled: input.enabled,
      eventsJson: JSON.stringify(input.events),
      configEnc: this.crypto.encrypt(JSON.stringify(input)),
    };
  }
}
