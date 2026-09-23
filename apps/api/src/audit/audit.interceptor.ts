/**
 * a route marked @Audited(action) is recorded when it succeeds: by whom, from
 * where, what it was about. (a module-provided interceptor runs OUTSIDE the
 * response transform: what it sees is the `{ data }` envelope, which is opened)
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditTarget } from '@syncle/core';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { AUDITED, type AuditedMeta } from './audited.decorator';
import { AuditService } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditedMeta | undefined>(
      AUDITED,
      context.getHandler(),
    );
    if (!meta) return next.handle();
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: unknown; apiKey?: unknown }>();
    return next.handle().pipe(
      tap({
        next: (answered) => {
          const ctx = {
            params: (req.params ?? {}) as Record<string, string>,
            query: (req.query ?? {}) as Record<string, unknown>,
            body: req.body as unknown,
            result: unwrap(answered),
          };
          let described: ReturnType<NonNullable<AuditedMeta['describe']>> = {};
          try {
            described = meta.describe?.(ctx) ?? {};
          } catch {
            /* a description that failed is no reason to lose the entry */
          }
          const target =
            described.target === null
              ? null
              : defaultTarget(meta.action, ctx, described.target);
          void this.audit.record({
            actor: this.audit.actorOf(req),
            action: meta.action,
            target,
            details: described.details ?? null,
            ip: this.audit.ipOf(req),
          });
        },
      }),
    );
  }
}

/** the action's first word as the type; `params.id` or the result's id; the result's or the body's name */
function defaultTarget(
  action: string,
  ctx: { params: Record<string, string>; body: unknown; result: unknown },
  given: Partial<AuditTarget> | undefined,
): AuditTarget | null {
  const result = (ctx.result ?? {}) as Record<string, unknown>;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const type = given?.type ?? action.split('.')[0]!;
  const id =
    given?.id ??
    ctx.params.id ??
    (typeof result.id === 'string' ? result.id : null);
  const name =
    given?.name ??
    (typeof result.name === 'string'
      ? result.name
      : typeof body.name === 'string'
        ? body.name
        : null);
  if (id === null && name === null) return null;
  return { type, id, name };
}

/** what the handler returned, out of the `{ data }` envelope the response transform put it in */
function unwrap(answered: unknown): unknown {
  if (answered && typeof answered === 'object' && !Array.isArray(answered)) {
    const keys = Object.keys(answered as object);
    if (keys.length === 1 && keys[0] === 'data')
      return (answered as { data: unknown }).data;
  }
  return answered;
}
