/**
 * every write to the metadata store, seen once, in one place — so that the
 * page can be told something changed without every service remembering to say
 * so. a Prisma middleware watches the writes; {@link eventOf} says which event
 * a write is, and about what.
 */
import type { Prisma } from '@prisma/client';
import type { LiveEvent, LiveEventType } from '@syncle/core';

export interface PrismaWrite {
  model: string;
  action: string;
  args: Record<string, unknown>;
  /** what Prisma answered: the row (unless `select` narrowed it), or a count */
  result: unknown;
}

export type WriteListener = (write: PrismaWrite) => void;

/** the Prisma actions that change something */
export const WRITE_ACTIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/**
 * a Prisma middleware that tells the listeners of every write, AFTER it
 * happened (inside a transaction, that is before it is committed: an event is
 * a nudge to look again, and looking again is cheap)
 */
export function writeMiddleware(
  listeners: Iterable<WriteListener>,
): Prisma.Middleware {
  return async (params, next) => {
    const result = await next(params);
    if (params.model && WRITE_ACTIONS.has(params.action)) {
      const write: PrismaWrite = {
        model: params.model,
        action: params.action,
        args: (params.args ?? {}) as Record<string, unknown>,
        result,
      };
      for (const listener of listeners) {
        try {
          listener(write);
        } catch {
          /* a listener's failure is not the write's */
        }
      }
    }
    return result;
  };
}

/** the model -> what its writes are about */
const MODELS: Record<
  string,
  { type: LiveEventType; bridgeId?: string; jobId?: string; id?: string }
> = {
  Bridge: { type: 'bridge', bridgeId: 'id' },
  BridgeJob: { type: 'bridge.job', bridgeId: 'bridgeId', jobId: 'id' },
  BridgeDelivery: { type: 'bridge.deliveries', jobId: 'jobId' },
  BridgeVerification: { type: 'bridge.verification', bridgeId: 'bridgeId' },
  BridgeDeadLetter: { type: 'bridge.deadLetters', bridgeId: 'bridgeId' },
  Connection: { type: 'connection', id: 'id' },
  Workspace: { type: 'workspace', id: 'id' },
  AppSetting: { type: 'settings' },
  AppUser: { type: 'users' },
  ApiKey: { type: 'apiKeys' },
  AuditEntry: { type: 'audit' },
  AlertChannel: { type: 'alertChannels' },
};

/** the event a write is, or null for a write nobody watches (a CDC member, a cleanup) */
export function eventOf(write: PrismaWrite, at = new Date()): LiveEvent | null {
  const shape = MODELS[write.model];
  if (!shape) return null;
  const event: LiveEvent = { type: shape.type, at: at.toISOString() };
  const bridgeId = shape.bridgeId && idIn(write, shape.bridgeId);
  const jobId = shape.jobId && idIn(write, shape.jobId);
  const id = shape.id && idIn(write, shape.id);
  if (bridgeId) event.bridgeId = bridgeId;
  if (jobId) event.jobId = jobId;
  if (id) event.id = id;
  return event;
}

/**
 * the value of an id column in what was written: in the row Prisma answered
 * with, else in the `where`, else in the data. only an exact one — a `where`
 * of `{ in: [...] }` names no single row, and then the event names none
 */
function idIn(write: PrismaWrite, column: string): string | undefined {
  const where = record(write.args.where);
  const sources: unknown[] = [
    write.result,
    where,
    // a delivery is addressed by its (job, sequence) pair
    column === 'jobId' ? record(where?.jobId_sequence) : undefined,
    write.args.data,
    write.args.create,
    write.args.update,
  ];
  for (const source of sources) {
    const value = record(source)?.[column];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
