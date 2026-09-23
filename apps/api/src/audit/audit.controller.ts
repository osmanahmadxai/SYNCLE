import { Controller, Get, Query } from '@nestjs/common';
import {
  auditQuerySchema,
  type AuditPage,
  type AuditQueryDTO,
} from '@syncle/core';
import { Roles } from '../auth/roles.decorator';
import { SessionOnly } from '../auth/session-only.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from './audit.service';

/** who did what: an admin's to read, signed in */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @SessionOnly()
  @Roles('admin')
  @Get()
  list(
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQueryDTO,
  ): Promise<AuditPage> {
    return this.audit.list(query);
  }
}
