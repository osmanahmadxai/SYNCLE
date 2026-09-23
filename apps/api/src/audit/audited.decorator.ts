import { SetMetadata } from '@nestjs/common';
import type { AuditAction, AuditTarget } from '@syncle/core';

export const AUDITED = 'audited';

/** what a route handler saw and answered, for the entry's target and details */
export interface AuditedContext {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  result: unknown;
}

export interface AuditedMeta {
  action: AuditAction;
  /**
   * the target and the details of the entry. without it: the target's type is
   * the action's first word, its id `params.id` (or the result's), its name the
   * result's (or the body's); no details. never put a secret in the details
   */
  describe?: (ctx: AuditedContext) => {
    target?: Partial<AuditTarget> | null;
    details?: Record<string, unknown> | null;
  };
}

/** record this route in the audit log when it succeeds (see AuditInterceptor) */
export const Audited = (
  action: AuditAction,
  describe?: AuditedMeta['describe'],
) => SetMetadata(AUDITED, { action, describe } satisfies AuditedMeta);
