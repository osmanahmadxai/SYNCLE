/**
 * who did what.
 *
 * Every change made through the API — by an account or by an API key — and
 * every sign-in, succeeded or not, is one entry: who (by name as well as by id,
 * so that the entry outlives the account), what, to what, from where, and a
 * few words of detail. Never a secret: a password, a connection's credentials,
 * an API key are not details.
 *
 * Reads are not recorded. They are the ordinary use of the app and would drown
 * the rest; what somebody LOOKED at is not what an audit log is for.
 *
 * Recording never fails a request. An entry that could not be written is said
 * in the server log, and the request is answered as it would have been.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  AuditActor,
  AuditEntry,
  AuditPage,
  AuditQueryDTO,
  AuditTarget,
} from '@syncle/core';
import type { AuditEntry as AuditRow } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../common/prisma.service';

export interface AuditRecord {
  actor: AuditActor;
  action: string;
  target?: AuditTarget | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

/** how much of a name or a detail is kept: enough to say what it was */
const NAME_LIMIT = 200;
const DETAILS_LIMIT = 4000;

export const SYSTEM: AuditActor = { type: 'system', id: null, name: 'system' };

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  /** the account or key behind a request (what AuthGuard attached to it), as the entry names it */
  actorOf(req: { user?: unknown; apiKey?: unknown }): AuditActor {
    const user = req.user as { id: string; username: string } | undefined;
    if (user) return { type: 'user', id: user.id, name: user.username };
    const key = req.apiKey as { id: string; name: string } | undefined;
    if (key) return { type: 'apiKey', id: key.id, name: key.name };
    return SYSTEM;
  }

  /** the address a request came from, as the entry keeps it */
  ipOf(req: Pick<Request, 'ip'>): string | null {
    const ip = req.ip?.trim();
    return ip ? ip.slice(0, 64) : null;
  }

  async record(entry: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditEntry.create({
        data: {
          id: randomUUID(),
          actorType: entry.actor.type,
          actorId: entry.actor.id,
          actorName: cut(entry.actor.name, NAME_LIMIT),
          action: entry.action,
          targetType: entry.target?.type ?? null,
          targetId: entry.target?.id ?? null,
          targetName: entry.target?.name
            ? cut(entry.target.name, NAME_LIMIT)
            : null,
          detailsJson: entry.details
            ? cut(JSON.stringify(entry.details, safe), DETAILS_LIMIT)
            : null,
          ip: entry.ip ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `An audit entry could not be written (${entry.action}): ${(err as Error).message}`,
      );
    }
  }

  /** newest first, a page at a time */
  async list(query: AuditQueryDTO): Promise<AuditPage> {
    const cursor = parseCursor(query.before);
    const rows = await this.prisma.auditEntry.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.actor ? { actorName: query.actor } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
        ...(query.targetType ? { targetType: query.targetType } : {}),
        ...(cursor
          ? {
              OR: [
                { at: { lt: cursor.at } },
                { at: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(toEntry),
      next:
        rows.length > query.limit && last
          ? `${last.at.toISOString()}|${last.id}`
          : null,
    };
  }

  /** entries older than `cutoff` go, at most `limit` of them; how many went */
  async prune(cutoff: Date, limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const old = await this.prisma.auditEntry.findMany({
      where: { at: { lt: cutoff } },
      select: { id: true },
      orderBy: { at: 'asc' },
      take: limit,
    });
    if (old.length === 0) return 0;
    const { count } = await this.prisma.auditEntry.deleteMany({
      where: { id: { in: old.map((r) => r.id) } },
    });
    return count;
  }
}

function toEntry(row: AuditRow): AuditEntry {
  let details: Record<string, unknown> | null = null;
  if (row.detailsJson) {
    try {
      details = JSON.parse(row.detailsJson) as Record<string, unknown>;
    } catch {
      details = { text: row.detailsJson };
    }
  }
  return {
    id: row.id,
    at: row.at.toISOString(),
    actor: {
      type: row.actorType as AuditActor['type'],
      id: row.actorId,
      name: row.actorName,
    },
    action: row.action,
    target: row.targetType
      ? { type: row.targetType, id: row.targetId, name: row.targetName }
      : null,
    details,
    ip: row.ip,
  };
}

function parseCursor(
  text: string | undefined,
): { at: Date; id: string } | null {
  if (!text) return null;
  const [iso, id] = text.split('|');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime())) return null;
  return { at, id };
}

const cut = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * what JSON has no spelling for, and what must not be in an audit entry however
 * it got into the details: a TEXT under a name that says it is a secret. (a flag
 * — `passwordSet: true` — says that one was set, which is exactly the record)
 */
function safe(key: string, value: unknown): unknown {
  if (
    typeof value === 'string' &&
    /password|secret|token|credential|apikey|api_key|authorization/i.test(key)
  )
    return '[redacted]';
  if (typeof value === 'bigint') return value.toString();
  return value;
}
